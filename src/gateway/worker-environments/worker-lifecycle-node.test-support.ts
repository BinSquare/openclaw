import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  installManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
} from "../../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../../infra/node-commands.js";
import {
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_PREPARED_WORKSPACE_VERSION,
  NODE_WORKER_PROMPT_CONTEXT_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION,
} from "../../infra/node-runner-inventory.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { parseNodeWorkerEnvironmentStopInput } from "../../worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { parseNodeWorkerWorkspaceRetainInput } from "../../worker/node-workspace-retain-protocol.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerPreparedWorkspaceTransport } from "./node-worker-prepared-workspace-transport.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import {
  readPreparedPoolPresenceDemand,
  writePreparedPoolPresenceDemand,
} from "./prepared-pool-presence-worker.js";
import { createWorkerEnvironmentService } from "./service.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";
import type { WorkerLifecycle } from "./worker-lifecycle.test-support.types.js";

export function createWorkerLifecycleNodeFixture({
  state,
  issuer,
  identity,
  authority,
  origin,
  repositoryUrl,
  gatewayUrl,
  executionMode,
  store,
  placements,
  scheduler,
  transfer,
  onUnregisterNode,
  onEnrollmentManager,
  onEnvironments,
}: {
  state: OpenClawTestState;
  issuer: WorkerLifecycle["issuer"];
  identity: WorkerLifecycle["identity"];
  authority: AdmittedRunOperatorAuthority;
  origin: string;
  repositoryUrl: string;
  gatewayUrl: string;
  executionMode: WorkerPlacementExecutionMode;
  store: WorkerLifecycle["environmentStore"];
  placements: WorkerLifecycle["placements"];
  scheduler: ReturnType<typeof createTestGatewayScheduler>;
  transfer: ReturnType<typeof createNodeWorkspaceTransferService>;
  onUnregisterNode: (callback: () => void) => void;
  onEnrollmentManager: (manager: ReturnType<typeof createWorkerNodeEnrollmentManager>) => void;
  onEnvironments: (service: WorkerLifecycle["environments"]) => void;
}) {
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () => new NodeRegistry({ getConfig: () => issuer.cfg }),
  );
  const nodes = new Map<string, NodeWorkerWorkspaceRuntime>();
  const registerNode = async (nodeId: string) => {
    if (nodes.has(nodeId)) return;
    await fs.mkdir(state.path("homes", nodeId), { recursive: true });
    nodes.set(
      nodeId,
      new NodeWorkerWorkspaceRuntime({
        root: state.path("nodes", nodeId),
        ephemeral: true,
        env: {
          ...process.env,
          HOME: state.path("homes", nodeId),
          OPENCLAW_STATE_DIR: state.path("node-state", nodeId),
          GIT_ALLOW_PROTOCOL: "file:https",
        },
      }),
    );
    const connId = nodeId + "-connection";
    nodeRegistry.register(
      makeClient(connId, nodeId, [], {
        clientId: "node-host",
        platform: "linux",
        commands: ["codex.exec-server.stdio.v1", "codex.app-server.stdio.v1"],
      }),
      { pairingIdentity: nodeId + "-pairing", pairingGeneration: nodeId + "-generation" },
    );
    updateNodeRunnerInventory({
      registry: nodeRegistry,
      nodeId,
      connId,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 1, available: 1 },
          environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
          preparedWorkspace: NODE_WORKER_PREPARED_WORKSPACE_VERSION,
          repositoryReadiness: 1,
          workspaceQuiescence: NODE_WORKER_WORKSPACE_QUIESCENCE_VERSION,
          capturedExecPolicy: true,
          promptContext: NODE_WORKER_PROMPT_CONTEXT_VERSION,
        },
      },
    });
  };
  const unregisterNode = () => {
    for (const id of nodes.keys()) nodeRegistry.unregister(id + "-connection");
  };
  onUnregisterNode(unregisterNode);
  const transport = {
    ...nodeWorkerSupervisorTransport,
    async invoke(request: Parameters<typeof nodeWorkerSupervisorTransport.invoke>[0]) {
      if (
        !nodeWorkerSupervisorTransport.isCurrent(request.node) ||
        request.isDispatchAuthorized?.() === false
      ) {
        throw new Error("Lifecycle node request lost its real registry authority");
      }
      request.onDispatchReady?.("lifecycle-node-delivery");
      const nodeRuntime = expectDefined(nodes.get(request.node.nodeId), "registered node runtime");
      if (request.command === NODE_WORKER_WORKSPACE_PREPARE_COMMAND) {
        const response = await invokeNodeWorkerSupervisorCommand({
          command: request.command,
          paramsJSON: JSON.stringify(request.params),
          workspace: nodeRuntime,
          signal: request.signal,
        });
        if (!response.handled) {
          throw new Error("Prepared workspace command was not handled");
        }
        return response.ok
          ? { ok: true as const, payload: response.payload }
          : { ok: false as const, error: { code: response.code, message: response.message } };
      }
      if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
        const input = parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params));
        await nodeRuntime.processes.stopEnvironment(input);
        return { ok: true as const, payloadJSON: "null" };
      }
      if (request.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
        const input = parseNodeWorkerWorkspaceRetainInput(JSON.stringify(request.params));
        // This remote-exec carrier never launches supervisor-owned model children.
        const result = await nodeRuntime.applyRetainSnapshot(input, async () => [], request.signal);
        return { ok: true as const, payloadJSON: JSON.stringify(result) };
      }
      if (request.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
        throw new Error("Unexpected lifecycle node command: " + request.command);
      }
      const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
      // Keep the prepared checkout's admitted origin; substitute only its fetch transport.
      if (input.argv.includes("fetch") && input.argv.includes("origin") && input.input) {
        const source = JSON.parse(input.input) as { origin?: string };
        if (source.origin === repositoryUrl) {
          input.argv = input.argv.map((arg) =>
            arg === "origin" ? pathToFileURL(origin).href : arg,
          );
        }
      }
      const result = await nodeRuntime.exec(input, request.signal, { url: gatewayUrl });
      return { ok: true as const, payloadJSON: JSON.stringify(result) };
    },
  };
  const launchNodeWorker = vi.fn(async () => {
    throw new Error("Dispatch-only journey must not launch an embedded worker");
  });
  const tunnels = createNodeWorkerTunnelManager({
    gatewayDeviceId: "lifecycle-gateway",
    getEnvironment: store.get,
    listEnvironments: store.list,
    getTransport: () => transport,
    validateWorkerTurn: placements.validateTurnClaim,
    workspaceTransfer: transfer,
    launchNodeWorker,
  });
  let reconcileCount = 0;
  const workspaceSyncs: WorkerLifecycle["workspaceSyncs"] = [];
  const nodeTunnelManager = {
    ...tunnels,
    async start(request: Parameters<typeof tunnels.start>[0]) {
      const tunnel = await tunnels.start(request);
      return {
        ...tunnel,
        reconcileWorkspace: async (request: Parameters<typeof tunnel.reconcileWorkspace>[0]) => {
          reconcileCount += 1;
          return await tunnel.reconcileWorkspace(request);
        },
        syncWorkspace: async (sync: Parameters<typeof tunnel.syncWorkspace>[0]) => {
          if (sync.source.kind !== "repository" || sync.source.url !== repositoryUrl) {
            throw new Error("Git transport left the admitted repository");
          }
          workspaceSyncs.push({
            prepared: Boolean(sync.source.prepared),
            selectedGitCredential: sync.source.gitToken === "synthetic-restored-factory-token",
            runSetupScript: sync.source.runSetupScript,
            baseCommit: sync.source.baseCommit,
            hasCheckpoint: Boolean(sync.source.checkpoint),
          });
          // Substitute only the external Git origin; checkout, transfer and receipts stay real.
          return await tunnel.syncWorkspace({
            ...sync,
            source: sync.source.prepared
              ? sync.source
              : { ...sync.source, url: pathToFileURL(origin).href },
          });
        },
      };
    },
  };
  const build = {
    nodeBootstrapSha256: "c".repeat(64),
    bundleHash: "a".repeat(64),
    openclawVersion: "2026.10.0",
    protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
  };
  const manager = createWorkerNodeEnrollmentManager({
    store,
    getConfig: () => issuer.cfg,
    resolveAvailability: async (id) => ({
      available: transport.hasCurrentRunner(id),
      node: await transport.getCurrentNode(id),
    }),
    prepareArtifact: async () => ({
      tarballPath: state.path("external-node.tgz"),
      tarballSha256: build.nodeBootstrapSha256,
      tarballBytes: 1,
      openclawVersion: build.openclawVersion,
      buildId: "lifecycle",
      enabledPluginIds: [],
    }),
    transfer: createWorkerBootstrapArtifactTransferService(),
  });
  onEnrollmentManager(manager);
  const destroyedLeases: string[] = [];
  let preparationEnabled = false;
  let presenceExecutionMode = executionMode;
  const provider: WorkerProvider = {
    id: "lifecycle",
    supportedExecutionModes: ["worker-turn", "remote-exec"],
    requiresNodeEnrollment: true,
    supportsProjectPreparation: () => preparationEnabled,
    resolvePreparedIdleTimeoutMs: () => 60_000,
    resolvePreparationTarget: (_profile, machineClass, os) => ({
      machineClass: machineClass ?? "small",
      platform: os ?? "linux",
      arch: "x64",
    }),
    resolveAllocation: async (_profile, operationId) => ({
      leaseId: operationId,
      sharedHost: false,
    }),
    provision: async (_profile, operationId, options) => {
      options?.assertCurrent?.();
      const preparedNodeId = "node-" + operationId.replaceAll(":", "-");
      if (options?.project) {
        const home = state.path("homes", preparedNodeId);
        await fs.mkdir(home, { recursive: true });
        const runScript = async (script: string, signal: AbortSignal) => {
          const result = await runCommandWithTimeout(["sh", "-c", script], {
            timeoutMs: 30_000,
            signal,
            env: { ...process.env, HOME: home },
          });
          if (result.code !== 0)
            throw new Error("Prepared provider script failed: " + result.stderr);
          return result.stdout;
        };
        await options.project.prepare({
          runScript,
          runScriptWithBudget: (createScript, signal) => runScript(createScript(30_000), signal),
          upload: async (source, destination, signal) => {
            signal.throwIfAborted();
            await fs.copyFile(source, destination);
          },
        });
      }
      const enrollment = expectDefined(
        await options?.beginNodeEnrollment?.(),
        "provider enrollment owner",
      );
      const deviceId = enrollment.mode === "resume" ? enrollment.deviceId : preparedNodeId;
      if (enrollment.mode === "connect") {
        const { bootstrapToken: token } = decodePairingSetupCode(enrollment.setupCode);
        expect(
          await verifyDeviceBootstrapToken({
            token,
            deviceId,
            publicKey: deviceId + "-key",
            role: "node",
            scopes: [],
          }),
        ).toEqual({ ok: true });
        expect(
          await consumeDeviceBootstrapTokenWithSetupCompletion({
            token,
            deviceId,
            completedAtMs: Date.now(),
            admitsCloudWorkerSetup: manager.admitsNodeSetupCompletion,
          }),
        ).not.toBeNull();
      }
      await registerNode(deviceId);
      return {
        leaseId: operationId,
        sharedHost: false,
        node: { deviceId: await enrollment.waitForDeviceId() },
      };
    },
    inspect: async () => ({ status: "active" }),
    destroy: async ({ leaseId }) => {
      destroyedLeases.push(leaseId);
    },
  };
  const prepareInstallation = vi.fn(async () => ({
    install: "bundle" as const,
    bundleHash: build.bundleHash,
    openclawVersion: build.openclawVersion,
    protocolFeatures: build.protocolFeatures,
    tarballBytes: 1,
    tarballSha256: "b".repeat(64),
    tarballPath: state.path("external-provider-bundle.tgz"),
  }));
  const environments = createWorkerEnvironmentService({
    scheduler,
    store,
    getConfig: () => issuer.cfg,
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    placementStore: createWorkerSessionPlacementGate(placements),
    projectNamespace: nodeWorkerGatewayNamespace("lifecycle-gateway"),
    ...createNodeWorkerPreparedWorkspaceTransport({
      store,
      placementStore: placements,
      getNodeTransport: () => transport,
      gatewayNamespace: nodeWorkerGatewayNamespace("lifecycle-gateway"),
    }),
    prepareNodeArtifacts: async () => ({
      artifacts: {
        nodeBootstrapSha256: build.nodeBootstrapSha256,
        enabledPluginIds: [],
        workerBundleHash: build.bundleHash,
        workerArchiveSha256: "b".repeat(64),
        openclawVersion: build.openclawVersion,
        protocolFeatures: build.protocolFeatures,
      },
      assertCurrent: authority.assertCurrent,
    }),
    resolveHumanPresenceDemand: () =>
      preparationEnabled
        ? {
            profileId: "development",
            executionMode: presenceExecutionMode,
            repository: { agentId: identity.agentId, url: repositoryUrl, ref: "main" },
          }
        : undefined,
    presenceDemandStore: {
      read: readPreparedPoolPresenceDemand,
      write: writePreparedPoolPresenceDemand,
    },
    prepareInstallation,
    prepareNodeBootstrap: async () => build.nodeBootstrapSha256,
    prepareNodeEnrollment: manager.begin,
    closeNodeEnrollment: manager.close,
    ensureNodeWorkerBundle: async ({ assertCurrent }) => {
      assertCurrent?.();
      return {
        bundleHash: build.bundleHash,
        openclawVersion: build.openclawVersion,
        protocolFeatures: build.protocolFeatures,
      };
    },
    bootstrapWorker: async () => {
      throw new Error("SSH bootstrap is outside the node journey");
    },
    executeInference: async () => {
      throw new Error("The deterministic model leaf belongs to runEffect");
    },
    nodeTunnelManager,
  });
  onEnvironments(environments);
  const service = environments;
  const availability = vi.fn(async (id: string) => ({
    available: transport.hasCurrentRunner(id),
    node: await transport.getCurrentNode(id),
  }));
  bindDeviceWorkerAvailability(service, availability);
  return {
    service,
    transport,
    tunnels,
    launchNodeWorker,
    workspaceSyncs,
    provider,
    build,
    prepareInstallation,
    availability,
    destroyedLeases,
    get reconcileCount() {
      return reconcileCount;
    },
    enablePreparation() {
      preparationEnabled = true;
    },
    async setHostingAvailable(nodeId: string, enabled: boolean, reconnect = false) {
      const current = expectDefined(await transport.getCurrentNode(nodeId), "current node");
      const connId = reconnect ? nodeId + "-reconnected" : current.connId;
      if (reconnect) {
        nodeRegistry.register(
          makeClient(connId, nodeId, [], {
            clientId: "node-host",
            platform: "linux",
            commands: current.commands,
          }),
          {
            pairingIdentity: current.pairingIdentity,
            pairingGeneration: current.pairingGeneration,
          },
        );
      }
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId,
        connId,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: enabled ? current.workerHost : { enabled: false },
        },
      });
    },
    losePreparedRegistration(environmentId: string) {
      const nodeId = expectDefined(store.get(environmentId)?.nodeDeviceId, "prepared node");
      nodes.set(
        nodeId,
        new NodeWorkerWorkspaceRuntime({
          root: state.path("nodes", nodeId),
          ephemeral: true,
          env: {
            ...process.env,
            HOME: state.path("homes", nodeId),
            OPENCLAW_STATE_DIR: state.path("replacement-node-state", nodeId),
            GIT_ALLOW_PROTOCOL: "file:https",
          },
        }),
      );
    },
    async preparePresence(kind = "image", readyWorkers = 3, mode = executionMode) {
      preparationEnabled = true;
      presenceExecutionMode = mode;
      if (kind === "repository") {
        const profileId = "ghp_" + "1".repeat(32);
        await installManagedGitHubProfile({
          profileDir: resolveManagedGitHubProfileDir({
            agentId: identity.agentId,
            scope: "system",
            profileId,
          }),
          token: "synthetic-restored-factory-token",
          issuer: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
          commitConfig: async () => {
            issuer.cfg.tools = { ...issuer.cfg.tools, github: { profileId } };
            await state.writeConfig(issuer.cfg);
            setRuntimeConfigSnapshot(issuer.cfg, issuer.cfg);
          },
        });
        vi.stubEnv("FACTORY_AUTH_MODE", "");
      }
      issuer.cfg.cloudWorkers!.profiles!.development!.readyWorkers = readyWorkers;
      issuer.cfg.cloudWorkers!.preparedPool = { maxTotal: readyWorkers };
      await service.setHumanPresence(true);
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      const ready = store.list().filter((record) => record.preparation?.consumedAtMs === null);
      const incomplete = ready.filter((record) => record.state !== "ready");
      if (incomplete.length)
        throw new Error(
          JSON.stringify(incomplete.map(({ state, lastError }) => ({ state, lastError }))),
        );
      return ready;
    },
  };
}
