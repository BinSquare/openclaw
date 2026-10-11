import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createNodeRepositoryReadiness } from "./node-worker-repository-readiness.js";
import * as diagnostics from "./placement-diagnostics.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
it.each(["failed", "revoked"] as const)(
  "activates hosted Codex before delayed repository admission and settles %s preparation",
  async (outcome) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "placement-async-repository-"));
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placementStore = createWorkerSessionPlacementStore({ database });
    const harness = createHarness(database, placementStore, {
      workspacePath: path.join(root, "workspace"),
    });
    try {
      const requested = await placementStore.startDispatch({
        ...REQUEST,
        executionMode: "remote-exec",
      });
      const provisioning = await placementStore.transition({
        sessionId: REQUEST.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId: harness.ready.environmentId },
      });
      const delayed = createDeferred();
      const entered = createDeferred();
      const background: Promise<void>[] = [];
      const release = vi.fn();
      const stage = vi.spyOn(diagnostics, "recordWorkerPlacementStage");
      let current = true;
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "fixture",
        scopes: ["operator.write"],
        assertCurrent: () => {
          if (!current) {
            throw new Error("fixture original authority revoked");
          }
        },
        retain: () => release,
      });
      const baseTunnel = harness.tunnelHandle(2);
      const repositoryCommand = vi.fn(baseTunnel.runWorkspaceCommand);
      const readiness = createNodeRepositoryReadiness({
        signal: new AbortController().signal,
        assertCurrent: () => {},
        run: async (command) => ({
          ...(await baseTunnel.runWorkspaceCommand(command)),
          stdout: command.repositoryPreparation?.status ?? "",
          workspaceDir: "/worker/workspace",
        }),
      });
      const tunnel: WorkerTunnelHandle = {
        ...baseTunnel,
        prepareRepositoryWorkspace: readiness.prepare,
        settleRepositoryWorkspace: readiness.settle,
        runWorkspaceCommand: (command) => readiness.execute(command, repositoryCommand),
      };
      vi.mocked(harness.environments.startTunnel).mockImplementation(async () => tunnel);
      const prepareIntent = vi
        .mocked(harness.environments.prepareProjectIntent)
        .getMockImplementation();
      if (!prepareIntent) {
        throw new Error("Repository intent fixture is unavailable");
      }
      vi.mocked(harness.environments.prepareProjectIntent).mockImplementation(async (...args) => {
        entered.resolve();
        await delayed.promise;
        if (outcome === "failed") {
          throw new Error("fixture repository admission failed");
        }
        return await prepareIntent(...args);
      });
      const startup = createWorkerPlacementDispatchStartup({
        placements: placementStore,
        environments: harness.environments,
        failure: createPlacementFailureActions({
          placements: placementStore,
          environments: harness.environments,
        }),
        runRecoveryBarrier: async () => {},
        runActivationBarrier: async ({ activate }) => activate(),
        isCurrentNodePlacement: () => true,
      });
      const workspace = {
        kind: "repository" as const,
        repository: {
          workspaceId: "fixture-workspace",
          agentId: REQUEST.agentId,
          sessionKey: REQUEST.sessionKey,
          url: "https://github.com/fixture/source.git",
          requestedRef: "refs/heads/topic",
          branch: "topic",
          baseCommit: null,
          baseManifestHash: null,
          checkpointRef: null,
          manifestHash: null,
          revision: 0,
          runSetupScript: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      };
      const active = await startup.continueProvisionedDispatch({
        request: {
          ...REQUEST,
          executionMode: "remote-exec",
          operatorAuthority: authority,
          trackRepositoryPreparation: (operation) => {
            background.push(operation);
            void operation.catch(() => undefined);
          },
          assertRepositoryPreparationCurrent: () => {},
        },
        placement: provisioning,
        environment: harness.ready,
        expectedEnvironmentId: harness.ready.environmentId,
        workspace,
        asynchronousRepository: true,
        admittedNode: {
          node: {
            nodeId: "fixture",
            connId: "fixture",
            pairingIdentity: "fixture",
            pairingGeneration: "fixture",
            clientId: "node-host",
            clientMode: "node",
            protocolFeature: "node-worker-supervisor-v6",
            workerHost: {
              enabled: true,
              capacity: { total: 1, available: 1 },
              repositoryReadiness: 1,
            },
            commands: [],
          },
          requirement: { consumesWorkerSlot: false, requiredNodeCommands: [] },
        },
      });
      await entered.promise;
      expect(active).toMatchObject({
        state: "active",
        workspaceBaseManifestRef: null,
        repositoryPreparation: "pending",
        remoteWorkspaceDir: "/worker/workspace",
      });
      // The readiness handshake itself uses this transport; only a subsequent
      // repository command must remain withheld.
      const pendingCommand = tunnel.runWorkspaceCommand({
        argv: ["git", "status"],
        transportRetry: "never",
      });
      void pendingCommand.catch(() => undefined);
      expect(repositoryCommand.mock.calls.some(([command]) => command.argv[0] === "git")).toBe(
        false,
      );
      expect(release).not.toHaveBeenCalled();
      if (outcome === "revoked") {
        current = false;
      }
      delayed.resolve();
      await expect(background[0]).rejects.toThrow(
        outcome === "revoked"
          ? "fixture original authority revoked"
          : "fixture repository admission failed",
      );
      await expect(pendingCommand).rejects.toThrow(
        "Repository preparation failed; this operation did not run",
      );
      expect(repositoryCommand.mock.calls.some(([command]) => command.argv[0] === "git")).toBe(
        false,
      );
      expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
        state: "active",
        generation: active.generation,
        repositoryPreparation: "failed",
        workspaceBaseManifestRef: null,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(stage).toHaveBeenCalledWith(
        REQUEST.sessionId,
        "workspace_sync_failed",
        expect.objectContaining({
          preparationPhase: "intent",
          preparationSignalAborted: false,
          operatorSignalAborted: false,
        }),
      );
      stage.mockRestore();
    } finally {
      await closeStateDatabaseForTest();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
