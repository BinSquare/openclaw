import { createWorkerLifecycleNodeFixture } from "./worker-lifecycle-node.test-support.js";
import { createWorkerLifecycleRepository } from "./worker-lifecycle-repository.test-support.js";
import type {
  WorkerLifecycle,
  WorkerLifecycleOptions,
} from "./worker-lifecycle.test-support.types.js";
export type { WorkerLifecycle } from "./worker-lifecycle.test-support.types.js";

import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import * as runtimePlugins from "../../agents/runtime-plugins.js";
import { withSessionPlacementTurnAdmission } from "../../agents/session-placement-admission.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { closeGatewayDeviceRevocation } from "../device-revocation.js";
import { factoryGitHubDispatchCredentialReader } from "../factory-github-proof.js";
import { revokeAttachGrantsForSession } from "../mcp-grant-store.js";
import { createSessionEventSubscriberRegistry } from "../server-chat-state.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import { readPreparedServerMethodModelCatalogs } from "../server-methods/optional-model-catalog.js";
import { flushPendingSessionsChangedEvents } from "../server-methods/session-change-event.js";
import { cancelGatewayWorkerSessionWork } from "../server-worker-placement-cancel.js";
import * as reclaimOwner from "../server-worker-placement-reclaim.js";
import { createGatewayWorkerPlacementRuntime } from "../server-worker-placement-startup.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerEnvironmentService } from "./service.js";
import { createWorkerEnvironmentStore } from "./store.js";

/** One real Gateway placement owner; only provider/model and GitHub transport are controlled. */
export async function withWorkerLifecycle<T>(
  run: (world: WorkerLifecycle) => Promise<T>,
  options: WorkerLifecycleOptions = {},
) {
  const executionMode = options.executionMode ?? "remote-exec";
  return await withOpenClawTestState({ label: "worker-lifecycle-workflow" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
    for (const key of [
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
    ]) {
      vi.stubEnv(key, undefined);
    }
    const registryBefore = captureActivePluginRegistrySnapshot();
    let cleanupIssuer: Awaited<ReturnType<typeof createOriginalIssuerFixture>> | undefined;
    let harness: AgentHarness | undefined;
    const scheduler = createTestGatewayScheduler();
    let environments: ReturnType<typeof createWorkerEnvironmentService> | undefined;
    let transfer: ReturnType<typeof createNodeWorkspaceTransferService> | undefined;
    let server: Awaited<ReturnType<typeof startNodeWorkspaceTransferTestServer>> | undefined;
    let environmentStore: Awaited<ReturnType<typeof createWorkerEnvironmentStore>> | undefined;
    let closePreludeStarted = false;
    let sidecar: { stop: () => Promise<void> } | undefined;
    let unregisterNode = () => {};
    let enrollmentManager: ReturnType<typeof createWorkerNodeEnrollmentManager> | undefined;
    let projection: SessionRowProjection | undefined;
    let preparingProjection: Promise<void> | undefined;
    let primaryFailure: { error: unknown } | undefined;
    try {
      const issuer = await createOriginalIssuerFixture(
        state,
        0,
        "current",
        true,
        undefined,
        false,
        options.setupScript || options.admin
          ? ["operator.read", "operator.write", "operator.admin"]
          : undefined,
      );
      cleanupIssuer = issuer;
      if (options.absentGatewayWorkspace)
        issuer.cfg.agents!.defaults!.workspace = state.path("no-gateway-checkout");
      const authority = expectDefined(issuer.original, "authenticated original issuer").authority;
      const { createCodexHarnessForTest } = await loadBundledPluginFacade<{
        createCodexHarnessForTest: () => Promise<AgentHarness>;
      }>({ pluginId: "codex", artifactBasename: "test-api.js" });
      harness = await createCodexHarnessForTest();
      issuer.registry.plugins.push(createPluginRecord({ id: "codex" }));
      registerAgentHarness(harness, { ownerPluginId: "codex" });
      const harnessAttempts = vi.spyOn(harness, "runAttempt");
      const registerPreparedHarness = (registry: PluginRegistry) =>
        withPluginRuntimeRegistryScope(registry, () =>
          registerAgentHarness(harness!, { ownerPluginId: "codex" }),
        );
      const loadRegistry = runtimePlugins.loadAgentRuntimePluginRegistryHandle;
      vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockImplementation(
        (...args) => {
          const registry = loadRegistry(...args);
          registerPreparedHarness(registry);
          return registry;
        },
      );
      const acquireRegistry = runtimePlugins.acquireAgentRuntimePluginRegistry;
      vi.spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry").mockImplementation(
        async (...args) => {
          const acquired = await acquireRegistry(...args);
          registerPreparedHarness(acquired.registry);
          return acquired;
        },
      );
      const originFixture = await createWorkerLifecycleRepository({ state, issuer, options });
      const { origin, repositoryUrl, target, proofScopes, external } = originFixture;
      issuer.cfg.cloudWorkers = {
        profiles: { development: { provider: "lifecycle", settings: {} } },
      };
      issuer.cfg.gateway = {
        ...issuer.cfg.gateway,
        publicOrigin: "https://gateway.example.test",
        nodes: { commands: { allow: ["codex.exec-server.stdio.v1", "codex.app-server.stdio.v1"] } },
      };
      await state.writeConfig(issuer.cfg);
      setRuntimeConfigSnapshot(issuer.cfg, issuer.cfg);
      const observer = { ...issuer.client, connId: "observer-" + issuer.client.connId };
      const clients = [issuer.client, observer];
      issuer.context.getClientConnIds = (filter) =>
        new Set(
          clients
            .filter((client) => !filter || filter(client))
            .map((client) => expectDefined(client.connId, "connection")),
        );
      issuer.context.isConnectionActive = (id) => clients.some((client) => client.connId === id);
      const subscribers = createSessionEventSubscriberRegistry(issuer.context.isConnectionActive);
      issuer.context.subscribeSessionEvents = subscribers.subscribe;
      issuer.context.unsubscribeSessionEvents = subscribers.unsubscribe;
      issuer.context.getSessionEventSubscriberConnIds = subscribers.getAll;
      await refreshPreparedModelRuntimeSnapshots(issuer.cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const created = await dispatchGatewayRequestInProcess<{
        entry: { sessionId: string; repositoryWorkspaceId: string };
      }>(
        "sessions.create",
        {
          key: target.sessionKey,
          agentId: target.agentId,
          repository: {
            url: repositoryUrl,
            ...(options.branch ? { ref: "refs/heads/" + options.branch } : {}),
          },
          model: "openai/allowed",
          agentRuntime: executionMode === "worker-turn" ? "openclaw" : "codex",
          worktree: false,
        },
        {
          client: issuer.client,
          context: issuer.context,
          methodRegistry: issuer.methods,
          hasCurrentClientAuthority: issuer.deviceSource.isCurrent,
          sessionMutationCommitGuard: authority.assertCurrent,
        },
      );
      const sessionId = created.entry.sessionId;
      originFixture.bindSessionId(sessionId);
      const identity = { ...target, sessionId };
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository = expectDefined(
        await repositories.get(created.entry.repositoryWorkspaceId),
        "publicly created repository",
      );
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      environmentStore = await createWorkerEnvironmentStore({ database });
      const store = environmentStore;
      transfer = createNodeWorkspaceTransferService({
        getOwner: store.getTransferOwner,
        temporaryRoot: state.path("transfers"),
      });
      server = await startNodeWorkspaceTransferTestServer(transfer);
      const gatewayUrl = server.gatewayUrl;
      const nodeFixture = createWorkerLifecycleNodeFixture({
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
        onUnregisterNode: (value) => {
          unregisterNode = value;
        },
        onEnrollmentManager: (value) => {
          enrollmentManager = value;
        },
        onEnvironments: (value) => {
          environments = value;
        },
      });
      const {
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
      } = nodeFixture;
      issuer.context.workerEnvironmentService = service;
      issuer.context.workerSessionPlacementService = placements;
      const createReclaim = reclaimOwner.createGatewayWorkerPlacementReclaimBarriers;
      let reclaimBarriers: ReturnType<typeof createReclaim> | undefined;
      vi.spyOn(reclaimOwner, "createGatewayWorkerPlacementReclaimBarriers").mockImplementation(
        (params) => {
          reclaimBarriers = createReclaim(params);
          return reclaimBarriers;
        },
      );
      const placementRuntime = createGatewayWorkerPlacementRuntime({
        scheduler,
        placements,
        environments: service,
        getCommittedRuntimeConfig: () => issuer.cfg,
        gatewayNamespace: nodeWorkerGatewayNamespace("lifecycle-gateway"),
        getSessionChangeContext: () => issuer.context,
        warn: (message) => console.warn(message),
        cancelSessionWork: (request) => cancelGatewayWorkerSessionWork(issuer.context, request),
        revokeSessionAuthority: ({ sessionKeys }) => {
          for (const key of sessionKeys) {
            revokeAttachGrantsForSession(key);
          }
        },
      });
      placementRuntime.bindNodeWorkerSupervisorTransport(transport);
      placementRuntime.bindNodeWorkerAvailability(availability);
      tunnels.bindWorkspaceBindingResolver(placementRuntime.resolveNodeWorkspaceBinding);
      issuer.context.workerPlacementDispatchService = placementRuntime.dispatchService;
      const started = await placementRuntime.startRuntime({
        isClosePreludeStarted: () => closePreludeStarted,
        registerSidecar: (registered) => {
          expect(sidecar).toBeUndefined();
          sidecar = registered;
        },
        unregisterSidecar: (registered) => {
          if (sidecar === registered) {
            sidecar = undefined;
          }
        },
      });
      expect(started).toBe(sidecar);
      expectDefined(started, "started canonical placement sidecar");
      issuer.context.workerPlacementDiskSpaceReader = placementRuntime.diskSpace;
      issuer.context.workerPlacementRunnerAvailabilityReader = placementRuntime.runnerAvailability;
      const call = async <R>(
        method: string,
        params: unknown,
        selected: { agentId: string; sessionKey: string; sessionId?: string } = identity,
        client = issuer.client,
      ): Promise<R> => {
        if (
          method === "sessions.list" ||
          method === "sessions.describe" ||
          method === "sessions.subscribe"
        ) {
          await (preparingProjection ??= createSessionRowProjection({
            cfg: issuer.cfg,
            getConfig: () => issuer.cfg,
            getPolicyConfig: () => issuer.cfg,
            getModelCatalog: () => readPreparedServerMethodModelCatalogs(issuer.context, ["main"]),
            context: issuer.context,
            placementFactsReader: placements,
          }).then((created) => {
            projection = created;
            bindSessionRowProjection(issuer.context, () => projection);
          }));
        }
        return await proofScopes.run(selected, () =>
          dispatchGatewayRequestInProcess<R>(method, params, {
            client,
            context: issuer.context,
            methodRegistry: issuer.methods,
            hasCurrentClientAuthority: issuer.deviceSource.isCurrent,
            sessionMutationCommitGuard: authority.assertCurrent,
          }),
        );
      };

      const world: WorkerLifecycle = {
        rpc: call,
        observerConnectionId: observer.connId,
        observerRpc: <R>(method: string, params: unknown) =>
          call<R>(method, params, identity, observer),
        sourceCommit: originFixture.sourceCommit,
        sourceTree: originFixture.sourceTree,
        async createRepositorySession(choice) {
          const selected = { agentId: identity.agentId, sessionKey: choice.key };
          const created = await call<{
            entry: { sessionId: string; repositoryWorkspaceId: string };
          }>(
            "sessions.create",
            {
              key: choice.key,
              agentId: identity.agentId,
              repository: { url: repositoryUrl, ...(choice.ref ? { ref: choice.ref } : {}) },
              model: "openai/allowed",
              agentRuntime: executionMode === "worker-turn" ? "openclaw" : "codex",
              worktree: choice.worktree,
            },
            selected,
          );
          const target = { ...selected, sessionId: created.entry.sessionId };
          return {
            identity: target,
            repositoryId: created.entry.repositoryWorkspaceId,
            rpc: <R>(method: string, params: unknown) => call<R>(method, params, target),
          };
        },
        issuer,
        metadataRequests: external.fetchFixture,
        get credentialProofCount() {
          return external.proofs.size;
        },
        revokeAtNextCredentialLookup: originFixture.revokeAtNextCredentialLookup,
        harnessAttempts,
        launchNodeWorker,
        workspaceSyncs,
        environments: service,
        environmentStore: store,
        placements,
        reclaimBarriers: expectDefined(reclaimBarriers, "canonical runtime reclaim owner"),
        transport,
        availability,
        provider,
        build,
        prepareInstallation,
        setHostingAvailable: nodeFixture.setHostingAvailable,
        losePreparedRegistration: nodeFixture.losePreparedRegistration,
        preparePresence: nodeFixture.preparePresence,
        identity,
        repositoryId: repository.workspaceId,
        originalCommit: originFixture.commit,
        advancePublishedBranch: originFixture.advancePublishedBranch,
        issuerProfileId: issuer.profile.id,
        readEntry: () => loadSessionEntry(target),
        readRepository: () => repositories.get(repository.workspaceId),
        readPlacement: () => placements.get(sessionId!),
        pendingResults: () => placements.listPendingWorkspaceResultsAsync(identity.sessionId),
        destroyedLeases,
        get reconcileCount() {
          return nodeFixture.reconcileCount;
        },
        assertIssuerCurrent: authority.assertCurrent,
        revokeIssuer: () => setCanonicalUserProfileRole(issuer.profile.id, "viewer"),
        async reclaim() {
          return await placementRuntime.dispatchService.reclaim(identity, authority.assertCurrent);
        },
        async recover() {
          await placementRuntime.dispatchService.reconcileActive();
        },
        async stop() {
          closePreludeStarted = true;
          const current = expectDefined(sidecar, "registered placement sidecar");
          const stopped = current.stop();
          expect(current.stop()).toBe(stopped);
          await stopped;
          expect(service.isStopping()).toBe(true);
        },
        async dispatch(options, selected) {
          const identity = selected?.identity ?? world.identity;
          if (options?.repositoryReadiness) nodeFixture.enablePreparation();
          return await proofScopes.run(identity, () =>
            placementRuntime.dispatchService.dispatch(
              {
                ...identity,
                profileId: "development",
                executionMode,
                operatorAuthority: authority,
                runSetupScript: options?.runSetupScript,
                ...(options?.repositoryReadiness
                  ? {
                      devicePlacement: {
                        requiredNodeCommands: ["codex.app-server.stdio.v1"],
                        consumesWorkerSlot: false,
                      },
                    }
                  : {}),
                readNativeCredential: factoryGitHubDispatchCredentialReader({
                  ...identity,
                  repositoryUrl,
                  issuerAuthority: authority,
                  assertCurrent: authority.assertCurrent,
                }),
              },
              undefined,
              authority.assertCurrent,
            ),
          );
        },
        async runEffect(runId, text = "accepted worker effect", previous, selected) {
          const identity = selected?.identity ?? world.identity;
          const target = identity;
          const sessionId = identity.sessionId;
          return await proofScopes.run(identity, async () => {
            const preparedRunAdmission = prepareAgentRunAdmission({
              cfg: issuer.cfg,
              operationalRunInstance: createOperationalRunInstanceRef(runId),
              facts: {
                runId,
                agentId: target.agentId,
                ingress: { kind: "worker", boundary: "test.worker-lifecycle", state: "present" },
              },
              operatorAuthority: authority,
              assertSourceCurrent: authority.assertCurrent,
            });
            try {
              return await withSessionPlacementTurnAdmission(
                { ...identity, runId },
                {
                  ...identity,
                  runId,
                  preparedRunAdmission,
                  config: issuer.cfg,
                  sessionTarget: {
                    ...identity,
                    storePath: resolveGatewaySessionStoreTarget({
                      cfg: issuer.cfg,
                      agentId: identity.agentId,
                      key: identity.sessionKey,
                    }).storePath,
                  },
                  sessionFile: state.path("logical-session.jsonl"),
                  workspaceDir: state.workspaceDir,
                  prompt: "Write the accepted lifecycle checkpoint",
                  timeoutMs: 30_000,
                  provider: "openai",
                  model: "allowed",
                  skillsSnapshot: { prompt: "", skills: [] },
                },
                async () => {
                  const admitted = await preparedRunAdmission.admit("embedded");
                  expect(readAdmittedRunOperatorAuthority(admitted)?.profileId).toBe(
                    issuer.profile.id,
                  );
                  const placement = expectDefined(placements.get(sessionId!), "admitted placement");
                  if (placement.state !== "active") {
                    throw new Error("Effect requires an active production placement");
                  }
                  const environment = expectDefined(
                    service.get(placement.environmentId),
                    "effect environment",
                  );
                  const assertNative = expectDefined(
                    getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent,
                    "admitted native effect guard",
                  );
                  const assertCurrent = () => {
                    authority.assertCurrent();
                    assertNative({
                      ...identity,
                      runId,
                      nodeId: environment.nodeDeviceId!,
                      workspace: {
                        ...identity,
                        environmentId: environment.environmentId,
                        ownerEpoch: environment.ownerEpoch,
                        workspaceDir: placement.remoteWorkspaceDir,
                      },
                    });
                  };
                  const tunnel = await service.startTunnel({
                    environmentId: environment.environmentId,
                    ownerEpoch: environment.ownerEpoch,
                    authorize: assertCurrent,
                  });
                  const result = await tunnel.runWorkspaceCommand({
                    argv: [
                      "node",
                      "-e",
                      "const fs = require('node:fs'); if (process.argv[2] && fs.readFileSync('accepted.txt', 'utf8') !== process.argv[2]) throw Error('previous checkpoint bytes lost'); fs.writeFileSync('accepted.txt', process.argv[1]); process.stdout.write('effect-complete')",
                      text,
                      ...(previous === undefined ? [] : [previous]),
                    ],
                    assertCurrent,
                    transportRetry: "never",
                    timeoutMs: 10_000,
                  });
                  assertCurrent();
                  expect(result).toMatchObject({ code: 0, stdout: "effect-complete" });
                  return {
                    payloads: [{ text: "Effect completed" }],
                    meta: {
                      durationMs: 0,
                      agentMeta: { sessionId: sessionId!, provider: "openai", model: "allowed" },
                    },
                  };
                },
              );
            } finally {
              preparedRunAdmission.close();
            }
          });
        },
      };
      return await run(world);
    } catch (error) {
      primaryFailure = { error };
      throw error;
    } finally {
      closePreludeStarted = true;
      const failures: unknown[] = [];
      // Keep dependency order, but a failed stop must not strand unrelated private owners.
      const cleanup = [
        () => sidecar?.stop(),
        () => cleanupIssuer?.work.drain(),
        async () => {
          if (cleanupIssuer) {
            for (const id of cleanupIssuer.context.getSessionEventSubscriberConnIds())
              cleanupIssuer.context.unsubscribeSessionEvents(id);
            await flushPendingSessionsChangedEvents(cleanupIssuer.context);
          }
          await preparingProjection;
          projection?.dispose();
          await projection?.ensureMaterialized();
        },
        () => environments?.stop(),
        () => unregisterNode(),
        () => enrollmentManager?.stop(),
        () => transfer?.closeAll(),
        () => server?.close(),
        () => environmentStore?.close(),
        () => cleanupIssuer?.original?.release(),
        () => cleanupIssuer?.deviceSource.release(),
        () => {
          if (cleanupIssuer) {
            closeGatewayDeviceRevocation(cleanupIssuer.context);
            cleanupIssuer.runtime.close();
          }
        },
        () => harness?.dispose?.(),
        () => scheduler.stop(),
        () => closeSkillsWatchers(true),
        () => {
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
          restoreActivePluginRegistrySnapshot(registryBefore);
        },
      ];
      for (const settle of cleanup) {
        try {
          await settle();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(
          [...(primaryFailure ? [primaryFailure.error] : []), ...failures],
          "Worker lifecycle operation or cleanup did not settle",
        );
      }
      if (!primaryFailure) await options.afterShutdown?.(state);
    }
  });
}
