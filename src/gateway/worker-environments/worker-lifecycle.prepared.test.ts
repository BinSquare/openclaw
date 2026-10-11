import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as workerCancellation from "../server-worker-placement-cancel.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { readImageReserveProject } from "./image-reserve.js";
import { placementTurnOwner } from "./placement-record.js";
import * as repositoryPreparation from "./placement-repository-preparation.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import * as workerGitHub from "./worker-github-binding.js";
import { withWorkerLifecycle } from "./worker-lifecycle.test-support.js";

it("publishes setup-produced initial checkpoint before the first turn", async () => {
  await withWorkerLifecycle(
    async (world) => {
      const active = await world.dispatch({ runSetupScript: true });
      expect(active.state).toBe("active");
      expect(world.workspaceSyncs.at(-1)).toMatchObject({
        runSetupScript: true,
        hasCheckpoint: false,
      });
      const repository = await world.readRepository();
      expect(repository?.baseCommit).toBe(world.originalCommit);
      expect(repository?.manifestHash).not.toBe(repository?.baseManifestHash);
      expect(repository?.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//u);
      expect(active.workspaceBaseManifestRef).toBe(repository?.manifestHash);
      expect(world.reconcileCount).toBe(1);
      await withSessionRepositoryCheckpoint(
        { workspaceId: world.repositoryId },
        async (snapshot) => {
          expect(
            await fs.readFile(path.join(snapshot.stagingRoot, "setup-output.txt"), "utf8"),
          ).toBe("setup\n");
        },
      );
      expect(world.launchNodeWorker).not.toHaveBeenCalled();
    },
    { setupScript: "#!/bin/sh\nprintf 'setup\\n' >> setup-output.txt\n" },
  );
}, 60_000);

const diagnostics = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  const { createWorkerLifecycleLogger } =
    await import("./worker-lifecycle-diagnostics.test-support.js");
  return {
    ...original,
    createSubsystemLogger: createWorkerLifecycleLogger(original, diagnostics.info),
  };
});

it.each(["worker-turn", "remote-exec"] as const)(
  "activates a publicly selected %s runtime without launching a model",
  async (executionMode) => {
    await withWorkerLifecycle(
      async (world) => {
        const ready = await world.preparePresence("repository", 1);
        const cold = vi.spyOn(world.environments, "createWithRequest");
        const refill = vi
          .spyOn(world.environments, "schedulePreparedRefill")
          .mockImplementation(() => {
            throw new Error("refill notification failed");
          });
        let bound = false;
        const bind = world.environments.bindPreparedWorkspace;
        vi.spyOn(world.environments, "bindPreparedWorkspace").mockImplementation(
          async (...args) => {
            const result = await bind(...args);
            bound = true;
            return result;
          },
        );
        const start = world.environments.startTunnel;
        vi.spyOn(world.environments, "startTunnel").mockImplementation(async (...args) => {
          const tunnel = await start(...args);
          return {
            ...tunnel,
            syncWorkspace: async (request) => {
              expect(bound).toBe(true);
              expect(request.sessionKey).toBe(world.identity.sessionKey);
              return await tunnel.syncWorkspace(request);
            },
          };
        });
        diagnostics.info.mockClear();
        const active = await world.dispatch({ runSetupScript: false });
        expect(active).toMatchObject({
          state: "active",
          executionMode,
          environmentId: ready[0]!.environmentId,
        });
        expect(cold).not.toHaveBeenCalled();
        expect(
          world.environmentStore.get(ready[0]!.environmentId)?.preparation?.consumedAtMs,
        ).not.toBeNull();
        expect(refill).toHaveBeenCalledWith(ready[0]!.environmentId);
        const expected = [
          "dispatch_repository_ref_preparation_started",
          "dispatch_repository_ref_preparation_completed",
          "local_barrier_started",
          "local_barrier_completed",
          "workspace_resolve_started",
          "workspace_resolve_completed",
          "intent_prepare_started",
          "intent_prepare_completed",
          "prepared_selection_started",
          "dispatch_prepared_repository_revalidation_started",
          "dispatch_prepared_repository_revalidation_completed",
          "prepared_claimed",
          "prepared_selection_completed",
          "environment_ready",
          "session_attach_started",
          "session_attached",
          "tunnel_started",
          "tunnel_ready",
          "workspace_sync_started",
          "dispatch_workspace_preparation_started",
          "dispatch_workspace_preparation_completed",
          "workspace_sync_completed",
          "dispatch_post_sync_repository_revalidation_started",
          "dispatch_post_sync_repository_revalidation_completed",
          "activation_started",
          "active",
          "activation_completed",
        ];
        const calls = diagnostics.info.mock.calls.filter(
          ([name, facts]) =>
            name === "worker placement stage" && facts.sessionId === world.identity.sessionId,
        );
        expect(
          calls.map(([, facts]) => facts.stage).filter((stage) => expected.includes(stage)),
        ).toEqual(expected);
        expect(calls.every(([, facts]) => typeof facts.atMs === "number")).toBe(true);
        const spans = calls.filter(
          ([, facts]) => facts.stage.endsWith("_completed") && typeof facts.elapsedMs === "number",
        );
        expect(spans.length).toBeGreaterThanOrEqual(5);
        expect(spans.every(([, facts]) => facts.elapsedMs >= 0)).toBe(true);
        const logged = JSON.stringify(calls);
        expect(logged).not.toContain("credentialHash");
        expect(logged).not.toContain("synthetic-restored-factory-token");
        expect(logged).not.toContain(active.remoteWorkspaceDir);
        expect(world.launchNodeWorker).not.toHaveBeenCalled();
        expect(world.harnessAttempts).not.toHaveBeenCalled();
        expect(world.environmentStore.getCredential(active.environmentId)).toMatchObject({
          sessionId: world.identity.sessionId,
          ownerEpoch: active.activeOwnerEpoch,
        });
        const entered = createDeferred();
        const release = createDeferred();
        const failure = new Error(
          "Synthetic private reclaim failure must not enter stage metadata",
        );
        const failed = executionMode === "remote-exec";
        const startTunnel = vi.mocked(world.environments.startTunnel).getMockImplementation()!;
        const tunnel = vi
          .spyOn(world.environments, "startTunnel")
          .mockImplementation(async (...args) => {
            const original = await startTunnel(...args);
            return {
              ...original,
              reconcileWorkspace: async (request) => {
                entered.resolve();
                await release.promise;
                if (failed) throw failure;
                return await original.reconcileWorkspace(request);
              },
            };
          });
        const clock = vi.spyOn(performance, "now").mockReturnValue(100);
        diagnostics.info.mockClear();
        const stop = () =>
          world.rpc<{ placement: { state: string } }>("sessions.reclaim", {
            key: world.identity.sessionKey,
          });
        const stopping = stop().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        const stages = () =>
          diagnostics.info.mock.calls
            .filter(([message]) => message === "worker placement stage")
            .map(([, facts]) => facts);
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            stopping,
            "Stop did not reach real reconciliation",
          );
          expect(stages().at(-1)).toMatchObject({
            sessionId: world.identity.sessionId,
            stage: "reclaim_snapshot_reconcile_started",
            environmentId: active.environmentId,
            ownerEpoch: active.activeOwnerEpoch,
          });
          expect(
            stages().some((fact) => fact.stage === "reclaim_snapshot_reconcile_completed"),
          ).toBe(false);
          clock.mockReturnValue(350);
          release.resolve();
          const outcome = await stopping;
          if (failed) {
            expect(outcome).toMatchObject({ error: { message: failure.message } });
            expect(world.destroyedLeases).toHaveLength(0);
            expect(world.readPlacement()?.state).toBe("draining");
          } else expect(outcome).toMatchObject({ result: { placement: { state: "reclaimed" } } });
          expect(stages()).toContainEqual(
            expect.objectContaining({
              stage: "reclaim_snapshot_reconcile_" + (failed ? "failed" : "completed"),
              elapsedMs: 250,
              ...(failed ? { diagnosticCode: "operation_failed" } : {}),
            }),
          );
          expect(JSON.stringify(stages())).not.toContain(failure.message);
        } finally {
          release.resolve();
          await stopping;
          clock.mockRestore();
          tunnel.mockRestore();
        }
        if (failed) expect(await stop()).toMatchObject({ placement: { state: "reclaimed" } });
        expect(world.destroyedLeases).toHaveLength(1);
        const failedSource = await world.dispatch({ runSetupScript: false });
        const owner = {
          sessionId: world.identity.sessionId,
          environmentId: failedSource.environmentId,
          ownerEpoch: failedSource.activeOwnerEpoch,
          placementGeneration: failedSource.generation,
        };
        if (executionMode === "remote-exec") {
          const claim = await world.placements.claimTurn({
            ...world.identity,
            owner: placementTurnOwner(failedSource),
            claimId: "retained-claim",
            runId: "retained-run",
          });
          await world.placements.markWorkspaceResultPending(claim);
          // Import the historical terminal layout: current failure settlement removes this row.
          // The pending result itself is still minted by its real SQLite owner, never a fake receipt.
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare(
                `UPDATE worker_session_placements SET turn_claim_owner = NULL,
                turn_claim_id = NULL, turn_claim_run_id = NULL, turn_claim_generation = NULL,
                turn_claim_owner_epoch = NULL, state = 'failed',
                transition_generation = transition_generation + 3,
                recovery_error = 'previous worker failure', terminal_reason = 'previous worker failure',
                terminal_at_ms = 1 WHERE session_id = ?`,
              ).run(world.identity.sessionId);
            },
            { database: openOpenClawStateDatabase() },
          );
        } else {
          const basePack = Buffer.from("retained workspace rollback");
          await world.placements.beginWorkspaceReconciliation(owner, {
            version: 1,
            temporaryNonce: "a".repeat(32),
            baseManifestRef: failedSource.workspaceBaseManifestRef,
            currentManifestRef: "sha256:" + "c".repeat(64),
            baseEntries: [],
            appliedEntries: [],
            baseTree: "f".repeat(40),
            basePackSha256: createHash("sha256").update(basePack).digest("hex"),
            basePack,
          });
          const draining = await world.placements.startDrain({
            ...owner,
            expectedGeneration: failedSource.generation,
          });
          const reconciling = await world.placements.startReconcile({
            ...owner,
            expectedGeneration: draining.generation,
          });
          await world.placements.fail({
            sessionId: owner.sessionId,
            expectedGeneration: reconciling.generation,
            recoveryError: "retained rollback unavailable",
          });
        }
        expect(world.readPlacement()).toMatchObject({ state: "failed", turnClaim: null });
        const inspect = vi
          .spyOn(world.provider, "inspect")
          .mockResolvedValueOnce({ status: "destroyed" });
        await world.environments.reconcileEnvironment(failedSource.environmentId);
        expect(inspect).toHaveBeenCalledOnce();
        inspect.mockRestore();
        expect(world.environmentStore.get(failedSource.environmentId)).toMatchObject({
          state: "failed",
          leaseId: null,
        });
        const describe = async () =>
          (
            await world.rpc<{ session: GatewaySessionRow }>("sessions.describe", {
              key: world.identity.sessionKey,
            })
          ).session;
        const blocked = await describe();
        expect(blocked.sessionId).toBe(world.identity.sessionId);
        expect(blocked.placement).toMatchObject({ state: "failed", recoveryAction: "restart" });
        expect(blocked.placement).not.toHaveProperty("retryOnSend");
        expect(blocked.placement).not.toHaveProperty("workspaceResultReconciling");
        if (executionMode === "remote-exec") {
          const pending = await world.pendingResults();
          expect(pending).toHaveLength(1);
          expect(pending[0]!.placementGeneration).toBeLessThan(world.readPlacement()!.generation);
          await world.placements.abandonWorkspaceResult(pending[0]!);
        } else {
          expect(await world.placements.listWorkspaceReconciliationOwners()).toContainEqual(owner);
          await world.placements.abortWorkspaceReconciliation(owner, { force: true });
        }
        expect((await describe()).placement).toEqual({ ...blocked.placement, retryOnSend: true });
        expect((await world.reclaim()).state).toBe("local");
        if (executionMode === "worker-turn") {
          // A fresh unallocated failure exercises the retained-admission barrier itself.
          await world.placements.startDispatch({ ...world.identity, executionMode });
          await world.placements.fail({
            sessionId: world.identity.sessionId,
            recoveryError: "lost worker",
          });
          const cancellation = vi.spyOn(workerCancellation, "cancelGatewayWorkerSessionWork");
          const interrupted = vi.fn();
          const admission = await beginSessionWorkAdmission({
            scope: resolveGatewaySessionStoreTarget({
              cfg: world.issuer.cfg,
              key: world.identity.sessionKey,
              agentId: "main",
            }).storePath,
            identities: [world.identity.sessionKey, world.identity.sessionId],
            assertAllowed: world.assertIssuerCurrent,
            onInterrupt: () => {
              interrupted();
              admission.release();
            },
          });
          try {
            const local = await admission.run(() =>
              world.reclaimBarriers.runFailedReclaimBarrier({
                ...world.identity,
                authorize: world.assertIssuerCurrent,
                preserveCurrentAdmission: true,
                reclaim: async (authorize) =>
                  world.placements.transition(
                    {
                      sessionId: world.identity.sessionId,
                      from: "failed",
                      to: "local",
                      expectedGeneration: world.readPlacement()!.generation,
                    },
                    authorize,
                  ),
              }),
            );
            expect(
              interrupted,
              "retained recovery preserves incoming admission",
            ).not.toHaveBeenCalled();
            expect(admission.isActive()).toBe(true);
            expect(cancellation).not.toHaveBeenCalled();
            expect(world.readPlacement()).toEqual(local);
            const repeated = await admission.run(() =>
              world.reclaimBarriers.runFailedReclaimBarrier({
                ...world.identity,
                authorize: world.assertIssuerCurrent,
                reclaim: async () => local,
              }),
            );
            expect(repeated).toBe(local);
            expect(cancellation).not.toHaveBeenCalled();
            expect(
              interrupted,
              "idempotent local cleanup cannot cancel new work",
            ).not.toHaveBeenCalled();
            expect(admission.isActive()).toBe(true);
          } finally {
            admission.release();
            cancellation.mockRestore();
          }
        }
      },
      { executionMode },
    );
  },
  60_000,
);

it.each(["image", "repository"] as const)(
  "fills %s capacity, claims it without cold allocation and commits the same session checkpoint",
  async (kind) => {
    await withWorkerLifecycle(async (world) => {
      const ready = await world.preparePresence(kind);
      expect(ready).toHaveLength(3);
      expect(
        ready.map((record) => ({
          state: record.state,
          error: record.lastError,
          image: Boolean(readImageReserveProject(record.profileSnapshot.project)),
        })),
      ).toEqual(
        Array.from({ length: 3 }, () => ({ state: "ready", error: null, image: kind === "image" })),
      );
      if (kind === "repository") vi.stubEnv("FACTORY_AUTH_MODE", "");
      await expect(
        world.environments.attachSession({
          environmentId: ready[0]!.environmentId,
          ownerEpoch: ready[0]!.ownerEpoch,
          sessionId: world.identity.sessionId,
        }),
      ).rejects.toThrow("placement reservation");
      expect(world.environmentStore.getCredential(ready[0]!.environmentId)?.sessionId).toBeNull();
      const wrongMode = {
        ...world.identity,
        sessionId: "wrong-mode",
        sessionKey: "agent:main:dashboard:wrong-mode",
        executionMode: "worker-turn" as const,
      };
      const wrongPlacement = await world.placements.startDispatch(wrongMode);
      const candidate = ready[0]!;
      expect(
        await world.placements.bindPreparedEnvironment({
          ...wrongMode,
          expectedGeneration: wrongPlacement.generation,
          environmentId: candidate.environmentId,
          ownerEpoch: candidate.ownerEpoch,
          providerId: candidate.providerId,
          profileId: candidate.profileId,
          preparationKey: candidate.preparation!.key,
          nodeDeviceId: candidate.nodeDeviceId!,
          leaseId: candidate.leaseId!,
          bundleHash: candidate.bootstrapReceipt!.bundleHash,
          assertCurrent: world.assertIssuerCurrent,
        }),
      ).toBeUndefined();
      const intents = vi.spyOn(world.environments, "prepareProjectIntent");
      // Delay only the notification: the explicit presence call below joins the real refill owner.
      const refill = vi
        .spyOn(world.environments, "schedulePreparedRefill")
        .mockImplementation(() => {});
      const cold = vi.spyOn(world.environments, "createWithRequest");
      const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
      const active = await world.dispatch({ runSetupScript: false });
      expect(ready.map((record) => record.environmentId)).toContain(active.environmentId);
      expect(cold).not.toHaveBeenCalled();
      expect(bind).toHaveBeenCalledTimes(kind === "repository" ? 1 : 0);
      expect(
        world.environmentStore.get(active.environmentId)?.preparation?.consumedAtMs,
      ).not.toBeNull();
      const selected = await intents.mock.results[0]!.value;
      expect(selected.profileSnapshot.executionMode).toBe("remote-exec");
      expect(ready.every((record) => record.preparation?.key === candidate.preparation?.key)).toBe(
        true,
      );
      expect(candidate.preparation?.key === selected.preparationKey).toBe(kind === "repository");
      expect(
        world.environmentStore.list().filter((record) => record.preparation?.consumedAtMs === null),
      ).toHaveLength(2);
      expect(world.environmentStore.getCredential(active.environmentId)).toMatchObject({
        sessionId: world.identity.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      expect(refill).toHaveBeenCalledWith(active.environmentId);
      refill.mockRestore();
      await world.environments.setHumanPresence(true);
      expect(
        world.environmentStore
          .list()
          .filter(
            (record) =>
              record.preparation?.consumedAtMs === null &&
              record.destroyRequestedAtMs === null &&
              record.state === "ready",
          ),
      ).toHaveLength(3);
      expect((await world.readRepository())?.baseCommit).toBe(world.originalCommit);
      expect(world.workspaceSyncs.at(-1)?.selectedGitCredential).toBe(true);
      await world.runEffect("prepared-image-effect", "prepared image accepted effect");
      await withSessionRepositoryCheckpoint(
        { workspaceId: world.repositoryId },
        async (snapshot) => {
          expect(await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8")).toBe(
            "prepared image accepted effect",
          );
        },
      );
      expect(world.readEntry()?.sessionId).toBe(world.identity.sessionId);
      await world.environments.setHumanPresence(false);
      expect((await world.reclaim()).state).toBe("reclaimed");
      if (kind === "repository") {
        let previous = "prepared image accepted effect";
        for (const runSetupScript of [false, true]) {
          const checkpoint = await world.readRepository();
          const continued = await world.dispatch({ runSetupScript });
          expect(continued.environmentId).not.toBe(active.environmentId);
          expect(continued.workspaceBaseManifestRef).toBe(checkpoint?.manifestHash);
          expect(await world.readRepository()).toEqual(checkpoint);
          expect(world.workspaceSyncs.at(-1)).toMatchObject({
            prepared: true,
            runSetupScript: false,
            baseCommit: world.originalCommit,
            hasCheckpoint: true,
          });
          const next = "continued setup=" + runSetupScript;
          await world.runEffect("continued-" + runSetupScript, next, previous);
          previous = next;
          expect((await world.reclaim()).state).toBe("reclaimed");
        }
        expect(cold).not.toHaveBeenCalled();
        expect(bind).toHaveBeenCalledTimes(3);
      }
    });
  },
  120_000,
);

it.each([
  "settled",
  "cleanup-unknown",
  "caller-revoked",
  "node-changed",
  "registration-changed",
] as const)(
  "settles native missing-registration before allocating a replacement (%s)",
  async (mode) => {
    await withWorkerLifecycle(async (world) => {
      const ready = await world.preparePresence("repository", 1);
      expect(ready).toHaveLength(1);
      expect(ready.every((record) => record.state === "ready")).toBe(true);
      for (const record of ready) world.losePreparedRegistration(record.environmentId);
      const cold = vi.spyOn(world.environments, "createWithRequest");
      const binding = vi.spyOn(world.environments, "bindPreparedWorkspace");
      const checkout = vi.spyOn(workerGitHub, "prepareWorkerRepositoryGitHubIdentity");
      const destroy = world.environments.destroy;
      const cleanup = vi
        .spyOn(world.environments, "destroy")
        .mockImplementation(async (...args) => {
          if (mode === "cleanup-unknown") throw new Error("warm cleanup unconfirmed");
          const result = await destroy(...args);
          if (mode === "caller-revoked") await world.revokeIssuer();
          return result;
        });
      let nodeCurrent = true;
      const isCurrent = world.transport.isCurrent;
      vi.spyOn(world.transport, "isCurrent").mockImplementation(
        (node) => nodeCurrent && isCurrent(node),
      );
      const nativeInvoke = world.transport.invoke;
      let missingObserved = false;
      vi.spyOn(world.transport, "invoke").mockImplementation(async (request) => {
        const result = await nativeInvoke(request);
        if (
          !result.ok &&
          result.error?.message === "INVALID_REQUEST: prepared workspace registration is missing"
        ) {
          missingObserved = true;
          if (mode === "node-changed") nodeCurrent = false;
          if (mode === "registration-changed")
            return {
              ...result,
              error: {
                ...result.error,
                message:
                  "INVALID_REQUEST: prepared workspace registration does not match this environment",
              },
            };
        }
        return result;
      });
      if (mode === "settled") {
        const active = await world.dispatch();
        expect(ready.map((record) => record.environmentId)).not.toContain(active.environmentId);
        expect(cold).toHaveBeenCalledOnce();
        expect(world.environmentStore.get(binding.mock.calls[0]![0].environmentId)?.state).toBe(
          "destroyed",
        );
        expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(cold.mock.invocationCallOrder[0]!);
        await world.runEffect("first-bind-cold-replacement", "cold replacement accepted effect");
        await withSessionRepositoryCheckpoint(
          { workspaceId: world.repositoryId },
          async (snapshot) => {
            expect(await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8")).toBe(
              "cold replacement accepted effect",
            );
          },
        );
      } else {
        await expect(world.dispatch()).rejects.toThrow();
        expect(cold).not.toHaveBeenCalled();
      }
      expect(binding).toHaveBeenCalledOnce();
      expect(checkout).toHaveBeenCalledTimes(mode === "settled" ? 1 : 0);
      expect(missingObserved).toBe(true);
      const claimed = world.environmentStore.get(binding.mock.calls[0]![0].environmentId)!;
      expect(claimed.preparation?.consumedAtMs).not.toBeNull();
      if (mode === "cleanup-unknown") expect(claimed.state).not.toBe("destroyed");
    });
  },
  120_000,
);

it.each(["ready", "failed", "revoked"] as const)(
  "holds real repository readiness through delayed %s settlement",
  async (outcome) => {
    await withWorkerLifecycle(async (world) => {
      const entered = createDeferred();
      const release = createDeferred();
      const prepare = world.environments.prepareProjectIntent;
      vi.spyOn(world.environments, "prepareProjectIntent").mockImplementation(async (...args) => {
        if (args[1]?.repository) {
          entered.resolve();
          await release.promise;
          if (outcome === "failed") throw new Error("repository source unavailable");
        }
        return prepare(...args);
      });
      const prepareActive = repositoryPreparation.prepareActiveRepository;
      let completion: ReturnType<typeof prepareActive> | undefined;
      const releases: ReturnType<typeof vi.fn>[] = [];
      vi.spyOn(repositoryPreparation, "prepareActiveRepository").mockImplementation((params) => {
        const releaseAuthority = vi.fn(params.releaseAuthority);
        releases.push(releaseAuthority);
        completion = prepareActive({ ...params, releaseAuthority });
        void completion.catch(() => {});
        return completion;
      });
      const dispatch = world.dispatch({ repositoryReadiness: true });
      try {
        const active = await dispatch;
        await entered.promise;
        expect(active).toMatchObject({
          state: "active",
          repositoryPreparation: "pending",
          workspaceBaseManifestRef: null,
        });
        expect(releases).toHaveLength(1);
        expect(releases[0]).not.toHaveBeenCalled();
        if (outcome === "revoked") await world.revokeIssuer();
        release.resolve();
        expect(completion).toBeDefined();
        if (outcome === "ready") {
          await completion;
          expect(world.readPlacement()).toMatchObject({
            generation: active.generation,
            state: "active",
            repositoryPreparation: "ready",
          });
          await world.runEffect("repository-ready-effect", "readiness accepted effect");
          await withSessionRepositoryCheckpoint(
            { workspaceId: world.repositoryId },
            async (snapshot) => {
              expect(
                await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8"),
              ).toBe("readiness accepted effect");
            },
          );
          expect((await world.reclaim()).state).toBe("reclaimed");
        } else {
          await expect(completion).rejects.toThrow();
          expect(world.readPlacement()).toMatchObject({
            generation: active.generation,
            state: "active",
            repositoryPreparation: "failed",
            workspaceBaseManifestRef: null,
          });
        }
      } finally {
        release.resolve();
        await dispatch.catch(() => {});
        await completion?.catch(() => {});
        expect(releases[0]).toHaveBeenCalledOnce();
      }
    });
  },
  120_000,
);
