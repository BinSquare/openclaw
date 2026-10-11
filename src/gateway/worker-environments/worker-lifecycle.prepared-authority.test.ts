import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  loadTranscriptEvents,
  patchSessionEntryCore,
  appendTranscriptMessageSync,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { factoryGitHubDispatchCredentialReader } from "../factory-github-proof.js";
import { createNodeRepositoryReadiness } from "./node-worker-repository-readiness.js";
import * as placementDiagnostics from "./placement-diagnostics.js";
import { createPlacementFailureActions } from "./placement-dispatch-failure.js";
import { createWorkerPlacementDispatchStartup } from "./placement-dispatch-startup.js";
import { PreparedEnvironmentBindingIndeterminateError } from "./placement-dispatch-store.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import {
  REPOSITORY_REF_WORKER_RECOVERY_ERROR,
  projectWorkerSessionTurnClaim,
} from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import * as workerGitHub from "./worker-github-binding.js";
import { withWorkerLifecycle } from "./worker-lifecycle.test-support.js";

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

it.each(["completed", "failed", "sink"] as const)(
  "measures the real prepared revalidation await (%s)",
  async (outcome) => {
    await withWorkerLifecycle(async (world) => {
      const [reserve] = await world.preparePresence("repository", 1);
      diagnostics.info.mockClear();
      let now = 100;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const revalidate = world.environments.revalidatePreparedIntentRepository;
      const failure = new Error("private repository failure");
      vi.spyOn(world.environments, "revalidatePreparedIntentRepository").mockImplementationOnce(
        async (...args) => {
          await revalidate(...args);
          now = 117;
          if (outcome === "failed") throw failure;
        },
      );
      const cold = vi.spyOn(world.environments, "createWithRequest");
      const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
      if (outcome === "sink")
        diagnostics.info.mockImplementation(() => {
          throw new Error("sink failed");
        });
      try {
        if (outcome === "failed") {
          await expect(world.dispatch({ runSetupScript: false })).rejects.toBe(failure);
          expect(cold).not.toHaveBeenCalled();
          expect(bind).not.toHaveBeenCalled();
        } else {
          expect(await world.dispatch({ runSetupScript: false })).toMatchObject({
            state: "active",
            environmentId: reserve!.environmentId,
          });
          expect(cold).not.toHaveBeenCalled();
        }
        const spans = diagnostics.info.mock.calls.filter(([, facts]) =>
          facts.stage?.startsWith("dispatch_prepared_repository_revalidation_"),
        );
        expect(spans.map(([, facts]) => facts.stage)).toEqual([
          "dispatch_prepared_repository_revalidation_started",
          "dispatch_prepared_repository_revalidation_" +
            (outcome === "failed" ? "failed" : "completed"),
        ]);
        expect(spans[1]?.[1]).toMatchObject({
          sessionId: world.identity.sessionId,
          generation: expect.any(Number),
          elapsedMs: 17,
        });
        expect(JSON.stringify(diagnostics.info.mock.calls)).not.toContain(failure.message);
      } finally {
        clock.mockRestore();
        diagnostics.info.mockReset();
      }
    });
  },
  60_000,
);

it.each(
  (["worker-turn", "remote-exec"] as const).flatMap((executionMode) =>
    [false, true].map((reconnect) => ({ executionMode, reconnect })),
  ),
)(
  "preserves a $executionMode reserve after hosting loss (reconnect=$reconnect)",
  async ({ executionMode, reconnect }) => {
    await withWorkerLifecycle(
      async (world) => {
        const [reserve] = await world.preparePresence("repository", 1);
        const nodeId = reserve!.nodeDeviceId!;
        await world.setHostingAvailable(nodeId, false, reconnect);
        const cold = vi.spyOn(world.environments, "createWithRequest");
        const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
        const active = await world.dispatch({ runSetupScript: false });
        expect(active.environmentId).not.toBe(reserve!.environmentId);
        expect(cold).toHaveBeenCalledOnce();
        expect(bind).not.toHaveBeenCalled();
        expect(
          world.environmentStore.get(reserve!.environmentId)?.preparation?.consumedAtMs,
        ).toBeNull();
        expect(world.environmentStore.getCredential(reserve!.environmentId)?.sessionId).toBeNull();
      },
      { executionMode },
    );
  },
  60_000,
);

it.each(["worker-turn", "remote-exec"] as const)(
  "rechecks %s hosting after an awaited admission",
  async (executionMode) => {
    await withWorkerLifecycle(
      async (world) => {
        const [reserve] = await world.preparePresence("repository", 1);
        const entered = createDeferred();
        const release = createDeferred();
        const availability = world.availability.getMockImplementation()!;
        world.availability.mockImplementationOnce(async (id) => {
          const result = await availability(id);
          entered.resolve();
          await release.promise;
          return result;
        });
        const cold = vi.spyOn(world.environments, "createWithRequest");
        const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
        const pending = world.dispatch({ runSetupScript: false });
        try {
          await entered.promise;
          await world.setHostingAvailable(reserve!.nodeDeviceId!, false);
          release.resolve();
          expect((await pending).environmentId).not.toBe(reserve!.environmentId);
          expect(cold).toHaveBeenCalledOnce();
          expect(bind).not.toHaveBeenCalled();
          expect(
            world.environmentStore.get(reserve!.environmentId)?.preparation?.consumedAtMs,
          ).toBeNull();
          expect(
            world.environmentStore.getCredential(reserve!.environmentId)?.sessionId,
          ).toBeNull();
        } finally {
          release.resolve();
          await pending.catch(() => {});
        }
      },
      { executionMode },
    );
  },
  60_000,
);

it.each(["pool policy", "profile", "post-binding node"] as const)(
  "fences the real prepared boundary when %s changes",
  async (change) => {
    await withWorkerLifecycle(async (world) => {
      const [reserve] = await world.preparePresence("repository", 1);
      const cold = vi.spyOn(world.environments, "createWithRequest");
      const attach = vi.spyOn(world.environments, "attachSession");
      const destroy = vi.spyOn(world.environments, "destroy");
      const refill = vi.spyOn(world.environments, "schedulePreparedRefill");
      if (change === "pool policy") {
        const candidates = world.environments.getPreparedCandidates;
        vi.spyOn(world.environments, "getPreparedCandidates")
          .mockImplementationOnce(candidates)
          .mockReturnValue([]);
      } else if (change === "profile") {
        const available = world.availability.getMockImplementation()!;
        world.availability.mockImplementationOnce(async (id) => {
          const result = await available(id);
          world.issuer.cfg.cloudWorkers!.profiles!.development!.settings = { changed: true };
          return result;
        });
      } else {
        const bind = world.environments.bindPreparedWorkspace;
        vi.spyOn(world.environments, "bindPreparedWorkspace").mockImplementation(
          async (...args) => {
            const result = await bind(...args);
            await world.setHostingAvailable(reserve!.nodeDeviceId!, false);
            return result;
          },
        );
      }
      if (change === "pool policy") {
        expect((await world.dispatch({ runSetupScript: false })).environmentId).not.toBe(
          reserve!.environmentId,
        );
        expect(cold).toHaveBeenCalledOnce();
      } else {
        await expect(world.dispatch({ runSetupScript: false })).rejects.toThrow();
        expect(cold).not.toHaveBeenCalled();
        if (change === "profile") expect(attach).not.toHaveBeenCalled();
        else {
          expect(world.workspaceSyncs).toHaveLength(0);
          expect(destroy).toHaveBeenCalledWith(reserve!.environmentId);
          expect(refill).not.toHaveBeenCalled();
        }
      }
      expect(
        world.environmentStore.get(reserve!.environmentId)?.preparation?.consumedAtMs === null,
      ).toBe(change !== "post-binding node");
    });
  },
  60_000,
);

it("captures a changed INITIAL checkpoint from a warm unpinned repository", async () => {
  await withWorkerLifecycle(async (world) => {
    const [reserve] = await world.preparePresence("repository", 1);
    const bind = world.environments.bindPreparedWorkspace;
    vi.spyOn(world.environments, "bindPreparedWorkspace").mockImplementation(async (...args) => {
      const result = await bind(...args);
      // Change real node-owned bytes after binding, before the real startup snapshot.
      await fs.writeFile(
        path.join(result.workspaceDir, "initial-change.txt"),
        "accepted initial change\n",
      );
      return result;
    });
    const cold = vi.spyOn(world.environments, "createWithRequest");
    const refill = vi.spyOn(world.environments, "schedulePreparedRefill");
    const active = await world.dispatch({ runSetupScript: false });
    expect(active.environmentId).toBe(reserve!.environmentId);
    expect(cold).not.toHaveBeenCalled();
    const repository = (await world.readRepository())!;
    expect(repository.baseCommit).toBe(world.originalCommit);
    expect(repository.manifestHash).not.toBe(repository.baseManifestHash);
    expect(repository.checkpointRef).toMatch(/^refs\/openclaw\/worker-results\//u);
    expect(active.workspaceBaseManifestRef).toBe(repository.manifestHash);
    expect(world.reconcileCount).toBe(1);
    expect(refill).toHaveBeenCalledWith(reserve!.environmentId);
    await withSessionRepositoryCheckpoint({ workspaceId: world.repositoryId }, async (snapshot) => {
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "initial-change.txt"), "utf8")).toBe(
        "accepted initial change\n",
      );
    });
  });
}, 60_000);

it("rejects incompatible Factory images and unauthorized executable setup", async () => {
  await withWorkerLifecycle(
    async (world) => {
      const ready = await world.preparePresence("image", 1);
      const repository = (await world.readRepository())!;
      const base = {
        executionMode: "remote-exec" as const,
        repository: { agentId: world.identity.agentId, url: repository.url },
        runSetupScript: false,
        setupAuthorized: true,
        readNativeCredential: factoryGitHubDispatchCredentialReader({
          ...world.identity,
          repositoryUrl: repository.url,
          issuerAuthority: world.issuer.original!.authority,
          assertCurrent: world.assertIssuerCurrent,
        }),
      };
      for (const override of [
        { machineClass: "large" },
        { os: "darwin" },
        { executionMode: "worker-turn" as const },
      ]) {
        const intent = await world.environments.prepareProjectIntent("development", {
          ...base,
          ...override,
        });
        expect(world.environments.getPreparedCandidates(intent, "development")).toEqual([]);
      }
      world.build.bundleHash = "3".repeat(64);
      const changed = await world.environments.prepareProjectIntent("development", base);
      expect(world.environments.getPreparedCandidates(changed, "development")).toEqual([]);
      world.build.bundleHash = ready[0]!.bootstrapReceipt!.bundleHash;
      const bootstrap = world.build.nodeBootstrapSha256;
      world.build.nodeBootstrapSha256 = "4".repeat(64);
      const changedBootstrap = await world.environments.prepareProjectIntent("development", base);
      expect(
        readWorkerProjectPreparation(changedBootstrap.profileSnapshot.project)?.artifacts,
      ).toEqual({
        ...readWorkerProjectPreparation(ready[0]!.profileSnapshot.project)!.artifacts,
        nodeBootstrapSha256: world.build.nodeBootstrapSha256,
      });
      expect(world.environments.getPreparedCandidates(changedBootstrap, "development")).toEqual([]);
      world.build.nodeBootstrapSha256 = bootstrap;
      const unprivileged = {
        executionMode: base.executionMode,
        repository: base.repository,
        readNativeCredential: base.readNativeCredential,
      };
      for (const request of [
        unprivileged,
        { ...unprivileged, runSetupScript: true, setupAuthorized: false },
      ]) {
        const unauthorized = await world.environments.prepareProjectIntent("development", request);
        expect(unauthorized.preparationKey).toBeUndefined();
        expect(world.environments.getPreparedCandidates(unauthorized, "development")).toEqual([]);
      }
    },
    { setupScript: "#!/bin/sh\nprintf setup > setup-output.txt\n" },
  );
}, 60_000);

it.each([
  "no-match",
  "settled-claim-miss",
  "host-preparation-failure",
  "checkout-failure",
  "cleanup-unknown",
  "binding-indeterminate",
] as const)(
  "preserves canonical Factory allocation and uncertain claim custody (%s)",
  async (scenario) => {
    const executionMode = [
      "settled-claim-miss",
      "cleanup-unknown",
      "binding-indeterminate",
    ].includes(scenario)
      ? "remote-exec"
      : "worker-turn";
    await withWorkerLifecycle(
      async (world) => {
        const ready = await world.preparePresence("image", 1, "remote-exec");
        const cold = vi.spyOn(world.environments, "createWithRequest");
        const workspace = vi.spyOn(world.environments, "bindPreparedWorkspace");
        const checkout = vi.spyOn(workerGitHub, "prepareWorkerRepositoryGitHubIdentity");
        const destroy = vi.spyOn(world.environments, "destroy");
        const bind = world.placements.bindPreparedEnvironment;
        if (scenario === "settled-claim-miss")
          vi.spyOn(world.placements, "bindPreparedEnvironment").mockImplementation((input) =>
            bind({ ...input, nodeDeviceId: "wrong-node" }),
          );
        if (scenario === "host-preparation-failure") {
          const prepare = world.environments.prepareProjectIntent;
          vi.spyOn(world.environments, "prepareProjectIntent").mockImplementation((...args) => {
            if (!args[1]?.repository) throw new Error("cold host preparation rejected");
            return prepare(...args);
          });
        }
        if (scenario === "checkout-failure")
          checkout.mockRejectedValue(new Error("selected GitHub credential unavailable"));
        const uncertain = scenario === "cleanup-unknown" || scenario === "binding-indeterminate";
        if (uncertain) {
          vi.spyOn(world.placements, "bindPreparedEnvironment").mockImplementation(
            async (input) => {
              expect(
                await bind(input),
                "real SQL claim committed before transport failure",
              ).toBeDefined();
              if (scenario === "binding-indeterminate")
                throw new PreparedEnvironmentBindingIndeterminateError(
                  new Error("claim reply lost"),
                );
              throw new Error("claim reply lost");
            },
          );
          destroy.mockRejectedValue(new Error("cleanup unconfirmed"));
        }
        const pending = world.dispatch({ runSetupScript: false });
        if (uncertain || scenario.endsWith("failure")) {
          await expect(pending).rejects.toThrow(
            scenario === "binding-indeterminate"
              ? "indeterminate"
              : scenario === "cleanup-unknown"
                ? "claim reply lost"
                : scenario === "checkout-failure"
                  ? "GitHub credential unavailable"
                  : "cold host preparation rejected",
          );
        } else {
          const active = await pending;
          expect(active.state).toBe("active");
          expect(active.environmentId).not.toBe(ready[0]!.environmentId);
          expect(checkout).toHaveBeenCalledOnce();
        }
        expect(cold).toHaveBeenCalledTimes(
          uncertain || scenario === "host-preparation-failure" ? 0 : 1,
        );
        expect(workspace).not.toHaveBeenCalled();
        if (cold.mock.calls.length) {
          expect(cold.mock.calls[0]![0].admittedIntent?.profileSnapshot.project).toBeUndefined();
          expect(cold.mock.calls[0]![0].admittedIntent?.profileSnapshot.executionMode).toBe(
            executionMode,
          );
        }
        const retained = world.environmentStore.get(ready[0]!.environmentId)!;
        expect(retained.preparation?.consumedAtMs === null).toBe(!uncertain);
        if (uncertain) {
          expect(retained.leaseId).toBe(ready[0]!.leaseId);
          expect(retained.state).not.toBe("destroyed");
          if (scenario === "binding-indeterminate") expect(destroy).not.toHaveBeenCalled();
        }
        if (scenario === "checkout-failure")
          expect((await world.readRepository())?.baseCommit).toBeNull();
      },
      { executionMode },
    );
  },
  60_000,
);

it.each(["build", "node", "exec-authority", "wrong-source", "pinned-base"] as const)(
  "rejects an actual selected candidate's %s evidence before workspace binding",
  async (fault) => {
    await withWorkerLifecycle(async (world) => {
      const [reserve] = await world.preparePresence("repository", 1);
      const candidates = world.environments.getPreparedCandidates;
      vi.spyOn(world.environments, "getPreparedCandidates").mockImplementation((...args) => {
        const found = candidates(...args);
        return found.flatMap((candidate) => {
          if (fault === "node") return [candidate];
          const project = readWorkerProjectSnapshot(candidate.profileSnapshot.project);
          if (!project || !("source" in project)) throw new Error("expected repository reserve");
          const altered = {
            ...candidate,
            bootstrapReceipt: {
              ...candidate.bootstrapReceipt!,
              ...(fault === "build"
                ? { bundleHash: "9".repeat(64) }
                : fault === "exec-authority"
                  ? { protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE] }
                  : {}),
            },
            profileSnapshot: {
              ...candidate.profileSnapshot,
              project: {
                ...project,
                preparation: readWorkerProjectPreparation(candidate.profileSnapshot.project),
                ...(fault === "wrong-source"
                  ? {
                      source: {
                        ...project.source,
                        url: "https://microsoft.ghe.com/acme/other.git",
                      },
                    }
                  : fault === "pinned-base"
                    ? { baseCommit: "f".repeat(40) }
                    : {}),
              },
            },
          };
          return fault === "build"
            ? Array.from({ length: 12 }, (_, index) => ({
                ...altered,
                environmentId: index === 0 ? candidate.environmentId : "rejected-spare-" + index,
              }))
            : [altered];
        });
      });
      if (fault === "node") {
        const current = world.transport.isCurrent;
        let admitted = false;
        const availability = world.availability.getMockImplementation()!;
        world.availability.mockImplementationOnce(async (id) => {
          const result = await availability(id);
          admitted = true;
          return result;
        });
        vi.spyOn(world.transport, "isCurrent").mockImplementation(
          (node, ...args) =>
            !(admitted && node.nodeId === reserve!.nodeDeviceId) && current(node, ...args),
        );
      }
      if (fault === "pinned-base") {
        const repository = (await world.readRepository())!;
        await getSessionRepositoryWorkspaceStore().bindBase({
          workspaceId: world.repositoryId,
          expectedRevision: repository.revision,
          baseCommit: world.originalCommit,
          baseManifestHash: "sha256:" + "a".repeat(64),
          assertCurrent: world.assertIssuerCurrent,
        });
      }
      const cold = vi.spyOn(world.environments, "createWithRequest");
      const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
      diagnostics.info.mockClear();
      if (fault === "wrong-source")
        await expect(world.dispatch({ runSetupScript: false })).rejects.toThrow(
          "Prepared repository does not match this session's source",
        );
      else if (fault === "pinned-base") {
        cold.mockRejectedValueOnce(new Error("cold selected for pinned base"));
        await expect(world.dispatch({ runSetupScript: false })).rejects.toThrow(
          "cold selected for pinned base",
        );
      } else
        expect((await world.dispatch({ runSetupScript: false })).environmentId).not.toBe(
          reserve!.environmentId,
        );
      expect(bind).not.toHaveBeenCalled();
      expect(cold).toHaveBeenCalledTimes(fault === "wrong-source" ? 0 : 1);
      expect(
        world.environmentStore.get(reserve!.environmentId)?.preparation?.consumedAtMs === null,
      ).toBe(fault !== "wrong-source");
      if (fault !== "wrong-source") {
        const code = {
          build: "build_mismatch",
          node: "node_authority_changed",
          "exec-authority": "launch_protocol_mismatch",
          "pinned-base": "repository_base_mismatch",
        }[fault];
        expect(diagnostics.info).toHaveBeenCalledWith(
          "worker prepared candidate rejected",
          expect.objectContaining({
            environmentId: reserve!.environmentId,
            code,
            atMs: expect.any(Number),
          }),
        );
      }
      if (fault === "build") {
        expect(
          diagnostics.info.mock.calls.filter(
            ([name]) => name === "worker prepared candidate rejected",
          ),
        ).toHaveLength(8);
        expect(diagnostics.info).toHaveBeenCalledWith(
          "worker placement stage",
          expect.objectContaining({
            stage: "prepared_selection_completed",
            candidateCount: 12,
            rejectedCount: 12,
            prepared: false,
          }),
        );
      }
    });
  },
  60_000,
);

it("releases a consumed reserve after issuer revocation during build validation", async () => {
  await withWorkerLifecycle(async (world) => {
    const [reserve] = await world.preparePresence("repository", 1);
    const prepare = world.prepareInstallation.getMockImplementation()!;
    world.prepareInstallation.mockImplementationOnce(async (...args) => {
      await world.revokeIssuer();
      return prepare(...args);
    });
    const tunnel = vi.spyOn(world.environments, "startTunnel");
    const destroy = vi.spyOn(world.environments, "destroy");
    await expect(world.dispatch({ runSetupScript: false })).rejects.toThrow();
    expect(
      world.environmentStore.get(reserve!.environmentId)?.preparation?.consumedAtMs,
    ).not.toBeNull();
    expect(tunnel).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith(reserve!.environmentId);
  });
}, 60_000);

it.each(["warm", "cold", "authority lost", "missing branch"] as const)(
  "recovers a failed native result from the exact accepted branch (%s)",
  async (mode) => {
    await withWorkerLifecycle(
      async (world) => {
        world.issuer.cfg.cloudWorkers!.profiles!.development!.lostWorkerRecovery = "repository-ref";
        await patchSessionEntryCore(
          world.identity,
          () => ({
            goal: {
              schemaVersion: 1,
              id: "original-goal",
              objective: "Keep original session",
              status: "paused",
              createdAt: 1,
              updatedAt: 1,
              tokenStart: 0,
              tokensUsed: 0,
              continuationTurns: 0,
            },
          }),
          { skipMaintenance: true },
        );
        appendTranscriptMessageSync(world.identity, {
          message: { role: "user", content: "Original accepted history", timestamp: 1 },
        });
        const entry = structuredClone(world.readEntry());
        const history = structuredClone(await loadTranscriptEvents(world.identity));
        const assertContinuity = async () => {
          expect(world.readEntry()).toEqual(entry);
          expect(await loadTranscriptEvents(world.identity)).toEqual(history);
        };
        const old = await world.dispatch({ runSetupScript: false });
        let oldClaim: ReturnType<typeof projectWorkerSessionTurnClaim>;
        const mark = world.placements.markWorkspaceResultPending;
        vi.spyOn(world.placements, "markWorkspaceResultPending").mockImplementation(
          async (...args) => {
            oldClaim = args[0];
            return await mark(...args);
          },
        );
        const stage = vi
          .spyOn(checkpoints, "stageSessionRepositoryCheckpoint")
          .mockImplementationOnce(async () => {
            throw new Error("native result publication unavailable");
          });
        const failure = await world
          .runEffect("failed-native-result", "unaccepted worker-only bytes")
          .catch((error: unknown) => error);
        expect(stage, String(failure)).toHaveBeenCalledOnce();
        stage.mockRestore();
        expect(failure).toBeInstanceOf(Error);
        expect(world.readPlacement()).toMatchObject({ state: "failed" });
        await assertContinuity();
        vi.spyOn(world.provider, "inspect").mockResolvedValueOnce({ status: "destroyed" });
        await world.environments.reconcileEnvironment(old.environmentId);
        await world.recover();
        await assertContinuity();
        expect(world.readPlacement()).toMatchObject({
          state: "failed",
          recoveryError: REPOSITORY_REF_WORKER_RECOVERY_ERROR,
          turnClaim: null,
        });
        expect(world.environmentStore.getCredential(old.environmentId)).toBeUndefined();
        expect(oldClaim).toBeDefined();
        expect(world.placements.validateTurnClaim(oldClaim!)).toBe(false);
        await expect(
          world.placements.recordStagedWorkspaceResult(
            oldClaim!,
            "refs/openclaw/worker-results/late",
          ),
        ).rejects.toThrow();
        expect(await world.pendingResults()).toEqual([]);
        const repository = (await world.readRepository())!;
        expect(repository.branch).toBe("session/original");
        expect(repository.requestedRef).toBe("refs/heads/session/original");
        const publishedHead = await world.advancePublishedBranch();
        expect(publishedHead).not.toBe(world.originalCommit);
        const ready = mode === "cold" ? [] : await world.preparePresence("repository", 1);
        const fetch = globalThis.fetch;
        const paths: string[] = [];
        vi.stubGlobal("fetch", (async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          paths.push(decodeURIComponent(url.pathname));
          const exact = decodeURIComponent(url.pathname).endsWith(
            "/commits/heads/session/original",
          );
          if (exact && mode === "missing branch") return new Response(null, { status: 404 });
          const result = await fetch(input, init);
          if (exact && mode === "authority lost") await world.revokeIssuer();
          return result;
        }) satisfies typeof globalThis.fetch);
        const cold = vi.spyOn(world.environments, "createWithRequest");
        const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
        if (mode === "authority lost" || mode === "missing branch") {
          await expect(world.dispatch({ runSetupScript: false })).rejects.toThrow();
          expect(cold).not.toHaveBeenCalled();
          expect(bind).not.toHaveBeenCalled();
          expect(await world.readRepository()).toEqual(repository);
        } else {
          const active = await world.dispatch({ runSetupScript: false });
          expect(active.state).toBe("active");
          expect(active.sessionId).toBe(world.identity.sessionId);
          expect(cold).toHaveBeenCalledTimes(mode === "cold" ? 1 : 0);
          if (mode === "warm") expect(active.environmentId).toBe(ready[0]!.environmentId);
          expect((await world.readRepository())?.baseCommit).toBe(publishedHead);
          expect(world.workspaceSyncs.at(-1)).toMatchObject({
            hasCheckpoint: false,
            baseCommit: publishedHead,
          });
          await world.runEffect(
            "recovered-original-branch",
            "recovered accepted bytes",
            "initial accepted bytes",
          );
        }
        expect(paths.some((pathname) => pathname.endsWith("/commits/heads/session/original"))).toBe(
          true,
        );
        expect(paths.some((pathname) => pathname.endsWith("/commits/heads/main"))).toBe(false);
        await assertContinuity();
      },
      { branch: "session/original" },
    );
  },
  120_000,
);

it("keeps a cold prepared workspace ordinary rather than registering a reserve", async () => {
  await withWorkerLifecycle(async (world) => {
    await world.preparePresence("repository", 1);
    await world.environments.setHumanPresence(false);
    vi.stubEnv("FACTORY_AUTH_MODE", "");
    const cold = vi.spyOn(world.environments, "createWithRequest");
    const bind = vi.spyOn(world.environments, "bindPreparedWorkspace");
    const revalidate = vi.spyOn(world.environments, "revalidatePreparedIntentRepository");
    const active = await world.dispatch({ runSetupScript: false });
    expect(cold).toHaveBeenCalledOnce();
    expect(cold).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "development",
        executionMode: "remote-exec",
        idempotencyKey: expect.any(String),
        admittedIntent: expect.objectContaining({
          profileSnapshot: expect.objectContaining({ project: expect.any(Object) }),
        }),
      }),
    );
    expect(bind).toHaveBeenCalledOnce();
    expect(world.environmentStore.get(active.environmentId)?.preparation).toBeNull();
    expect(revalidate).toHaveBeenCalledOnce();
    expect(cold.mock.invocationCallOrder[0]).toBeLessThan(bind.mock.invocationCallOrder[0]!);
    expect(world.workspaceSyncs.at(-1)?.prepared).toBe(true);
  });
}, 60_000);

it.each(["failed", "revoked", "retired"] as const)(
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
      const stage = vi.spyOn(placementDiagnostics, "recordWorkerPlacementStage");
      let current = true;
      const retired = new AbortController();
      const settleRepository = placementStore.settleRepository.bind(placementStore);
      vi.spyOn(placementStore, "settleRepository").mockImplementation(async (...args) => {
        const receipt = await settleRepository(...args);
        if (outcome === "retired") {
          await placementStore.startDrain({
            sessionId: receipt.sessionId,
            environmentId: harness.ready.environmentId,
            ownerEpoch: 2,
            expectedGeneration: receipt.generation,
          });
          retired.abort(new Error("fixture placement retired"));
        }
        return receipt;
      });
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
        signal: retired.signal,
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
        settleRepositoryWorkspace: vi.fn(readiness.settle),
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
        if (outcome !== "revoked") {
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
          assertRepositoryCleanupCurrent: () => {
            if (placementStore.get(REQUEST.sessionId)?.state !== "active") {
              throw new Error("fixture placement retired");
            }
          },
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
        outcome === "retired"
          ? "Operation aborted"
          : "Repository preparation failed; this operation did not run",
      );
      expect(repositoryCommand.mock.calls.some(([command]) => command.argv[0] === "git")).toBe(
        false,
      );
      expect(placementStore.get(REQUEST.sessionId)).toMatchObject({
        state: outcome === "retired" ? "draining" : "active",
        generation: active.generation + (outcome === "retired" ? 1 : 0),
        repositoryPreparation: "failed",
        workspaceBaseManifestRef: null,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(tunnel.settleRepositoryWorkspace).toHaveBeenCalledTimes(outcome === "retired" ? 0 : 1);
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
