import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import * as inbound from "../../auto-reply/dispatch.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import * as gitWorker from "../../infra/git-worker.js";
import * as command from "../../process/exec.js";
import * as projectClone from "../../projects/project-clone.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { loadTestSessionPullRequests } from "../control-ui-session-prs.test-support.js";
import { closeGatewayDeviceRevocation } from "../device-revocation.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import * as changeEvents from "../server-methods/session-change-event.js";
import { flushPendingSessionsChangedEvents } from "../server-methods/session-change-event.js";
import {
  initializeSessionReadContext,
  disposeSessionReadContexts,
} from "../server-methods/sessions-read-cache.test-support.js";
import { trackSessionReadProjection } from "../session-read-contexts.test-support.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { withWorkerLifecycle } from "./worker-lifecycle.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { workerWorkspaceResultRef } from "./workspace-result-staging.js";

it("creates a repository session, commits a native checkpoint and joins reclaimed runtime shutdown", async () => {
  const localClone = vi.spyOn(projectClone, "materializeProjectClone");
  await withWorkerLifecycle(
    async (world) => {
      expect(world.readEntry()).toMatchObject({
        sessionId: world.identity.sessionId,
        repositoryWorkspaceId: world.repositoryId,
        createdActor: { type: "human", source: "profile", id: world.issuerProfileId },
      });
      expect(world.readPlacement()).toBeUndefined();
      expect(world.readEntry()).not.toHaveProperty("worktree");
      expect(world.readEntry()).not.toHaveProperty("spawnedCwd");
      expect(world.environmentStore.list()).toHaveLength(0);
      const read = async () => {
        const listed = await world.rpc<{ sessions: GatewaySessionRow[] }>("sessions.list", {
          agentId: "main",
        });
        const described = await world.rpc<{ session: GatewaySessionRow }>("sessions.describe", {
          key: world.identity.sessionKey,
        });
        expect(
          listed.sessions.find((row) => row.sessionId === world.identity.sessionId),
        ).toMatchObject({
          key: described.session.key,
          sessionId: world.identity.sessionId,
          repositoryWorkspaceId: world.repositoryId,
          repository: described.session.repository,
        });
        expect(
          listed.sessions.find((row) => row.sessionId === world.identity.sessionId)?.placement,
        ).toEqual(described.session.placement);
        expect(
          listed.sessions.find((row) => row.sessionId === world.identity.sessionId)?.placementMove,
        ).toEqual(described.session.placementMove);
        return described.session;
      };
      expect((await read()).repositoryWorkspaceId).toBe(world.repositoryId);
      expect(await world.rpc("sessions.subscribe", {})).toEqual({ subscribed: true });
      expect(await world.observerRpc("sessions.subscribe", {})).toEqual({ subscribed: true });
      const before = expectDefined(await world.readRepository(), "created repository");
      expect(before).toMatchObject({
        url: "https://microsoft.ghe.com/acme/lifecycle.git",
        requestedRef: "refs/heads/default-fixture",
        branch: "default-fixture",
      });
      expect(JSON.stringify(before)).not.toContain("synthetic-restored-factory-token");
      expect(world.credentialProofCount).toBeGreaterThan(0);
      expect(world.metadataRequests).toHaveBeenCalled();
      const transition = world.placements.transition;
      let startingObserved = 0;
      const starting = vi
        .spyOn(world.placements, "transition")
        .mockImplementation(async (...args) => {
          if (args[0].from === "starting" && args[0].to === "active") {
            startingObserved++;
            expect(world.readPlacement()?.activeOwnerEpoch).toBeNull();
            expect((await read()).placement).toMatchObject({
              state: "starting",
              providerId: "lifecycle",
              profileId: "development",
            });
          }
          return await transition(...args);
        });
      const dispatched = await world.dispatch({ runSetupScript: true });
      expect(startingObserved).toBe(1);
      starting.mockRestore();
      expect(dispatched).toMatchObject({ state: "active", executionMode: "remote-exec" });
      const active = await read();
      expect(active.placement).toMatchObject({
        state: "active",
        generation: dispatched.generation,
        environmentId: dispatched.environmentId,
        activeOwnerEpoch: dispatched.activeOwnerEpoch,
        providerId: "lifecycle",
        profileId: "development",
      });
      const worker = expectDefined(dispatched.remoteWorkspaceDir, "real node checkout");
      expect(await requireWorkspaceResultGit(worker, ["rev-parse", "HEAD"])).toBe(
        world.originalCommit,
      );
      expect(await fs.readFile(path.join(worker, "accepted.txt"), "utf8")).toBe(
        "initial accepted bytes",
      );
      const getMany = vi.spyOn(world.placements, "getMany");
      await read();
      expect(getMany).not.toHaveBeenCalled();
      getMany.mockRestore();
      expect(await requireWorkspaceResultGit(worker, ["branch", "--show-current"])).toBe(
        "default-fixture",
      );
      await world.runEffect("lifecycle-first-effect");
      const accepted = expectDefined(
        await world.readRepository(),
        "accepted repository checkpoint",
      );
      expect(accepted.baseCommit).toBe(world.originalCommit);
      expect(accepted.revision).toBeGreaterThan(before.revision);
      expect(accepted.checkpointRef).toBeTruthy();
      expect(accepted.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      await withSessionRepositoryCheckpoint(
        { workspaceId: world.repositoryId },
        async (snapshot) => {
          expect(await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8")).toBe(
            "accepted worker effect",
          );
        },
      );
      expect(world.readPlacement()).toMatchObject({ state: "active", turnClaim: null });
      expect(world.readEntry()?.sessionId).toBe(world.identity.sessionId);
      await flushPendingSessionsChangedEvents(world.issuer.context);
      const broadcasts = vi.mocked(world.issuer.context.broadcastToConnIds);
      broadcasts.mockClear();
      const reclaimed = await world.rpc<{ placement: { state: string; generation: number } }>(
        "sessions.reclaim",
        { key: world.identity.sessionKey },
      );
      expect(reclaimed.placement.state).toBe("reclaimed");
      expect(world.readPlacement()).toMatchObject(reclaimed.placement);
      await flushPendingSessionsChangedEvents(world.issuer.context);
      expect(broadcasts.mock.calls).toContainEqual([
        "sessions.changed",
        expect.objectContaining({
          reason: "reclaim",
          sessionKey: world.identity.sessionKey,
          placement: expect.objectContaining({ state: "reclaimed" }),
        }),
        new Set([world.issuer.client.connId, world.observerConnectionId]),
        expect.anything(),
      ]);
      expect((await read()).placement?.state).toBe("reclaimed");
      broadcasts.mockClear();
      expect(await world.rpc("sessions.reclaim", { key: world.identity.sessionKey })).toMatchObject(
        reclaimed,
      );
      await flushPendingSessionsChangedEvents(world.issuer.context);
      expect(broadcasts).not.toHaveBeenCalled();
      expect(await world.pendingResults()).toEqual([]);
      expect(world.destroyedLeases).toHaveLength(1);
      expect((await world.readRepository())?.manifestHash).toBe(accepted.manifestHash);
      await world.recover();
      expect(world.destroyedLeases).toHaveLength(1);
      const fresh = await world.dispatch({ runSetupScript: true });
      expect(fresh.environmentId).not.toBe(dispatched.environmentId);
      expect((await read()).placement?.environmentId).toBe(fresh.environmentId);
      await world.runEffect(
        "second-after-rpc-reclaim",
        "second accepted effect",
        "accepted worker effect",
      );
      const move = world.placements.beginPlacementMove({
        sessionId: world.identity.sessionId,
        source: {
          generation: fresh.generation,
          environmentId: fresh.environmentId,
          ownerEpoch: fresh.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      });
      expect(
        world.placements.recordPlacementMoveError({
          sessionId: world.identity.sessionId,
          operationId: move.intent.operationId,
          error: "workspace reconciliation is waiting",
        }),
      ).toBe(true);
      expect((await read()).placementMove).toEqual({
        target: { kind: "gateway" },
        error: "workspace reconciliation is waiting",
        updatedAtMs: world.placements.getPlacementMove(world.identity.sessionId)!.updatedAtMs,
      });
      world.placements.cancelPlacementMove(move.intent);
      expect((await read()).placementMove).toBeUndefined();
      const emit = changeEvents.emitSessionsChanged;
      const reportFailure = vi
        .spyOn(changeEvents, "emitSessionsChanged")
        .mockImplementation((context, payload, options) => {
          if (payload.reason === "reclaim")
            throw new Error("Synthetic subscriber reporting failure");
          return emit(context, payload, options);
        });
      try {
        expect(
          await world.rpc("sessions.reclaim", { key: world.identity.sessionKey }),
        ).toMatchObject({ placement: { state: "reclaimed" } });
        expect(world.readPlacement()?.state).toBe("reclaimed");
        expect(reportFailure).toHaveBeenCalledWith(world.issuer.context, {
          reason: "reclaim",
          sessionKey: world.identity.sessionKey,
        });
      } finally {
        reportFailure.mockRestore();
      }
      expect(world.destroyedLeases).toHaveLength(2);
      expect(world.readEntry()?.sessionId).toBe(world.identity.sessionId);
      const roots = new Set([worker]);
      const repositories = getSessionRepositoryWorkspaceStore();
      for (const choice of [
        { key: "agent:main:current-selected", ref: "selected/branch", worktree: false },
        { key: "agent:main:new-selected", ref: "selected/branch", worktree: true },
      ]) {
        const allocated = world.environmentStore.list().length;
        const beforeCreation = world.metadataRequests.mock.calls.length;
        const session = await world.createRepositorySession(choice);
        if (!choice.worktree) {
          expect(world.metadataRequests).toHaveBeenCalledTimes(beforeCreation);
          const retry = await session.rpc<{ entry: { repositoryWorkspaceId: string } }>(
            "sessions.create",
            {
              key: choice.key,
              agentId: "main",
              repository: {
                url: expectDefined(
                  await repositories.get(session.repositoryId),
                  "repository source",
                ).url,
                ref: choice.ref,
              },
              worktree: false,
            },
          );
          expect(retry.entry.repositoryWorkspaceId).toBe(session.repositoryId);
          expect(world.metadataRequests).toHaveBeenCalledTimes(beforeCreation);
        }
        expect(world.environmentStore.list()).toHaveLength(allocated);
        const repository = expectDefined(
          await repositories.get(session.repositoryId),
          "selected repository",
        );
        expect(repository.requestedRef).toBe(
          choice.worktree ? choice.ref : "refs/heads/" + choice.ref,
        );
        expect(repository.branch).toBe(
          choice.worktree ? "openclaw/" + session.repositoryId : "selected/branch",
        );
        expect(world.placements.get(session.identity.sessionId)).toBeUndefined();
        const placement = await world.dispatch({ runSetupScript: true }, session);
        const checkout = expectDefined(placement.remoteWorkspaceDir, "selected node checkout");
        roots.add(checkout);
        expect(await requireWorkspaceResultGit(checkout, ["rev-parse", "HEAD"])).toBe(
          world.sourceCommit("selected/branch"),
        );
        expect(await requireWorkspaceResultGit(checkout, ["branch", "--show-current"])).toBe(
          repository.branch,
        );
        expect(await fs.readFile(path.join(checkout, "accepted.txt"), "utf8")).toBe(
          "selected branch bytes",
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey: choice.key })).not.toHaveProperty(
          "worktree",
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey: choice.key })).not.toHaveProperty(
          "spawnedCwd",
        );
        if (choice.worktree) {
          await flushPendingSessionsChangedEvents(world.issuer.context);
          broadcasts.mockClear();
          const destroy = vi
            .spyOn(world.provider, "destroy")
            .mockRejectedValueOnce(new Error("Synthetic provider cleanup unavailable"));
          try {
            await expect(session.rpc("sessions.reclaim", { key: choice.key })).rejects.toThrow(
              "Synthetic provider cleanup unavailable",
            );
          } finally {
            destroy.mockRestore();
          }
          expect(world.placements.get(session.identity.sessionId)?.state).toBe("draining");
          await flushPendingSessionsChangedEvents(world.issuer.context);
          expect(broadcasts.mock.calls).toContainEqual([
            "sessions.changed",
            expect.objectContaining({
              reason: "reclaim",
              sessionKey: choice.key,
              placement: expect.objectContaining({ state: "draining" }),
            }),
            new Set([world.issuer.client.connId, world.observerConnectionId]),
            expect.anything(),
          ]);
          await world.recover();
          expect(world.placements.get(session.identity.sessionId)?.state).toBe("reclaimed");
        } else
          expect(await session.rpc("sessions.reclaim", { key: choice.key })).toMatchObject({
            placement: { state: "reclaimed" },
          });
      }
      expect(roots.size).toBe(3);
      const beforeValidation = world.metadataRequests.mock.calls.length;
      for (const [index, invalid] of [
        { repository: { url: "file:///tmp/repository" } },
        { repository: { url: "https://token@github.com/openclaw/openclaw.git" } },
        {
          repository: {
            url: "https://microsoft.ghe.com/acme/lifecycle.git",
            ref: "--upload-pack=anything",
          },
        },
        { cwd: "/tmp/repository" },
        { execNode: "device" },
        { projectId: "workspace:main" },
        { projectGitUrl: "https://github.com/openclaw/openclaw.git" },
        { worktreeBaseRef: "main" },
        { message: "Start before dispatch" },
      ].entries()) {
        const key = "agent:main:invalid-repository-" + index;
        await expect(
          world.rpc("sessions.create", {
            agentId: "main",
            key,
            repository: { url: "https://microsoft.ghe.com/acme/lifecycle.git" },
            ...invalid,
          }),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toBeUndefined();
        expect(await repositories.find({ agentId: "main", sessionKey: key })).toBeUndefined();
      }
      expect(world.metadataRequests).toHaveBeenCalledTimes(beforeValidation);
      const proofCount = world.credentialProofCount;
      const reads = world.metadataRequests.mock.calls.length;
      const revokedKey = "agent:main:revoked-creation";
      world.revokeAtNextCredentialLookup();
      await expect(
        world.createRepositorySession({ key: revokedKey, worktree: false }),
      ).rejects.toThrow();
      expect(world.credentialProofCount).toBe(proofCount + 1);
      expect(world.metadataRequests).toHaveBeenCalledTimes(reads);
      expect(await repositories.find({ agentId: "main", sessionKey: revokedKey })).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", sessionKey: revokedKey })).toBeUndefined();
      expect(localClone).not.toHaveBeenCalled();
      expect(
        await fs.stat(world.issuer.cfg.agents!.defaults!.workspace!).catch(() => undefined),
      ).toBeUndefined();
      await world.stop();
      await world.stop();
    },
    {
      defaultBranch: "default-fixture",
      additionalBranch: "selected/branch",
      absentGatewayWorkspace: true,
      admin: true,
    },
  );
}, 60_000);

it("admits non-admin Factory and credentialless public Current creation without setup intent", async () => {
  const originalDispatch = vi.spyOn(inbound, "dispatchInboundMessageWithProjectedDispatcher");
  const originalClone = vi.spyOn(projectClone, "materializeProjectClone");
  const key = "agent:main:repository-replay";
  const repository = { url: "git@github.com:Acme/Lifecycle.git", ref: "release/next" };
  const anonymousEnv = {
    FACTORY_AUTH_MODE: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: undefined,
    PATH: "",
  };
  let createdWorkspaceId: string | undefined;
  let previousDatabase: ReturnType<typeof openOpenClawStateDatabase> | undefined;
  await withWorkerLifecycle(
    async (world) => {
      expect(world.issuer.client.connect.scopes).not.toContain("operator.admin");
      expect(await world.readRepository()).toMatchObject({
        url: "https://microsoft.ghe.com/acme/lifecycle.git",
        branch: "main",
        requestedRef: "refs/heads/main",
        runSetupScript: false,
      });
      expect(world.readEntry()?.createdActor).toEqual({
        type: "human",
        source: "profile",
        id: world.issuerProfileId,
      });
      expect(JSON.stringify(await world.readRepository())).not.toContain(
        "synthetic-restored-factory-token",
      );
      expect(world.readPlacement()).toBeUndefined();
      expect(world.credentialProofCount).toBeGreaterThan(0);
      vi.mocked(command.runCommandBuffered).mockRestore();
      const nativeAttempts = vi.spyOn(command, "runCommandBuffered");
      const proofCount = world.credentialProofCount;
      const url = "https://github.com/acme/lifecycle.git";
      const tree = world.sourceTree("main");
      const originalFetch = globalThis.fetch;
      const originalHost = world.issuer.cfg.gateway!.github;
      const publicFetch = vi.fn<typeof fetch>(async (input, init) => {
        const request = new URL(input instanceof Request ? input.url : input.toString());
        expect(request.origin).toBe("https://api.github.com");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        if (request.pathname === "/repos/acme/lifecycle")
          return Response.json({
            node_id: "R_public_lifecycle",
            clone_url: url,
            private: false,
            default_branch: "main",
          });
        if (decodeURIComponent(request.pathname) === "/repos/acme/lifecycle/commits/heads/main")
          return Response.json({ sha: world.originalCommit, commit: { tree: { sha: tree.sha } } });
        if (request.pathname === "/repos/acme/lifecycle/git/trees/" + tree.sha)
          return Response.json(tree);
        throw new Error("Public metadata left the exact repository");
      });
      let created: { entry: { sessionId: string; repositoryWorkspaceId: string } };
      try {
        world.issuer.cfg.gateway!.github = undefined;
        setRuntimeConfigSnapshot(world.issuer.cfg, world.issuer.cfg);
        vi.stubGlobal("fetch", publicFetch);
        created = await withEnvAsync(anonymousEnv, async () => {
          const current = await world.rpc<typeof created>("sessions.create", {
            key: "agent:main:public-current",
            agentId: "main",
            repository: { url },
            worktree: false,
          });
          const replay = await world.rpc<typeof created>("sessions.create", { key, repository });
          expect(replay).not.toHaveProperty("worktree");
          const saved = loadSessionEntry({ agentId: "main", sessionKey: key });
          expect(saved).toMatchObject({
            repositoryWorkspaceId: replay.entry.repositoryWorkspaceId,
          });
          for (const field of [
            "worktree",
            "projectId",
            "pendingProjectGitUrl",
            "pendingWorktree",
            "spawnedCwd",
            "sessionRoot",
            "sessionDiffBaselineCapture",
          ])
            expect(saved).not.toHaveProperty(field);
          await world.rpc("sessions.list", { agentId: "main" });
          const projection = expectDefined(
            getSessionRowProjection(world.issuer.context),
            "original projection",
          );
          trackSessionReadProjection(projection);
          createdWorkspaceId = replay.entry.repositoryWorkspaceId;
          previousDatabase = openOpenClawStateDatabase();
          return current;
        });
      } finally {
        vi.stubGlobal("fetch", originalFetch);
        world.issuer.cfg.gateway!.github = originalHost;
        setRuntimeConfigSnapshot(world.issuer.cfg, world.issuer.cfg);
      }
      expect(publicFetch).toHaveBeenCalledTimes(4);
      expect(nativeAttempts).toHaveBeenCalled();
      for (const [index, [argv, options]] of nativeAttempts.mock.calls.entries()) {
        expect(argv).toEqual(["gh", "auth", "token", "--hostname", "github.com"]);
        expect(options?.env?.PATH).toBe("");
        expect(await nativeAttempts.mock.results[index]!.value).toMatchObject({
          termination: "error",
          error: { code: "ENOENT" },
        });
      }
      expect(world.credentialProofCount).toBe(proofCount);
      expect(
        await getSessionRepositoryWorkspaceStore().get(created.entry.repositoryWorkspaceId),
      ).toMatchObject({
        url,
        branch: "main",
        requestedRef: "refs/heads/main",
        runSetupScript: false,
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:public-current" })?.sessionId,
      ).toBe(created.entry.sessionId);
      expect(world.placements.get(created.entry.sessionId)).toBeUndefined();
      expect(world.environmentStore.list()).toHaveLength(0);
      expect(originalDispatch).not.toHaveBeenCalled();
      expect(originalClone).not.toHaveBeenCalled();
    },
    {
      absentGatewayWorkspace: true,
      async afterShutdown(state) {
        const workspaceId = expectDefined(createdWorkspaceId, "original repository creation");
        const originalDatabase = expectDefined(previousDatabase, "original native database");
        await disposeSessionReadContexts();
        await closeOpenClawStateDatabaseAsync();
        expect(originalDatabase.db.isOpen).toBe(false);
        closeOpenClawStateDatabaseForTest();
        vi.stubEnv("FACTORY_AUTH_MODE", "github");
        const reopened = await createOriginalIssuerFixture(state, 0, "current", true);
        const connected = new Set([reopened.client]);
        reopened.context.getClientConnIds = (filter) =>
          new Set(
            [...connected]
              .filter((client) => !filter || filter(client))
              .map((client) => client.connId!),
          );
        const clone = vi.spyOn(projectClone, "materializeProjectClone");
        const dispatch = vi.spyOn(inbound, "dispatchInboundMessageWithProjectedDispatcher");
        const cache = new AbortController();
        try {
          reopened.cfg.gateway!.github = undefined;
          reopened.cfg.agents!.defaults!.workspace = state.path("no-gateway-checkout");
          for (const [key, value] of Object.entries(anonymousEnv)) vi.stubEnv(key, value);
          setRuntimeConfigSnapshot(reopened.cfg, reopened.cfg);
          expect(openOpenClawStateDatabase().db === originalDatabase.db).toBe(false);
          const rpc = <R>(method: string, params: unknown) =>
            dispatchGatewayRequestInProcess<R>(method, params, {
              context: reopened.context,
              client: reopened.client,
              methodRegistry: reopened.methods,
              hasCurrentClientAuthority: reopened.deviceSource.isCurrent,
              sessionMutationCommitGuard: reopened.original!.authority.assertCurrent,
            });
          const replay = await rpc<{ entry: { repositoryWorkspaceId: string } }>(
            "sessions.create",
            {
              key,
              repository,
            },
          );
          expect(replay.entry.repositoryWorkspaceId).toBe(workspaceId);
          await initializeSessionReadContext(reopened.context);
          const listed = await rpc<{ sessions: GatewaySessionRow[] }>("sessions.list", {
            agentId: "main",
          });
          expect(listed.sessions.find((row) => row.key === key)).toMatchObject({
            repositoryWorkspaceId: workspaceId,
            repository: {
              url: "https://github.com/acme/lifecycle.git",
              ref: "release/next",
              branch: "openclaw/" + workspaceId,
            },
          });
          const git = vi
            .spyOn(gitWorker, "runGitWorkerOperation")
            .mockImplementation(async (operation) => {
              if (operation.type === "checkout.revision") return "unchanged";
              if (operation.type === "checkout.context")
                return {
                  root: operation.input.root,
                  owner: "acme",
                  repo: "lifecycle",
                  branch: "previous-local-branch",
                  defaultBranch: "main",
                };
              if (operation.type === "pull-request.branch-facts") return undefined;
              throw new Error("Unexpected Git operation");
            });
          const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([]));
          let pins: number | undefined;
          for (const resolveGitRoot of [
            undefined,
            async () => state.path("no-gateway-checkout"),
            undefined,
          ]) {
            git.mockClear();
            const preview = await loadTestSessionPullRequests(
              { sessionKey: key, agentId: "main" },
              { cacheSignal: cache.signal, fetchImpl, resolveGitRoot },
            );
            pins ??= getEventListeners(cache.signal, "abort").length;
            expect(pins).toBeGreaterThan(0);
            expect(getEventListeners(cache.signal, "abort")).toHaveLength(pins);
            if (!resolveGitRoot) {
              expect(preview.branch).toMatchObject({
                owner: "acme",
                repo: "lifecycle",
                branch: "openclaw/" + workspaceId,
              });
              expect(git).not.toHaveBeenCalled();
            }
          }
          expect(fetchImpl).toHaveBeenCalled();
          cache.abort();
          expect(getEventListeners(cache.signal, "abort")).toHaveLength(0);
          for (const changed of [
            undefined,
            { ...repository, ref: "main" },
            { url: "https://github.com/octocat/hello-world.git" },
          ])
            await expect(
              rpc("sessions.create", { key, ...(changed ? { repository: changed } : {}) }),
            ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
          expect(
            await fs.stat(state.path("no-gateway-checkout")).catch(() => undefined),
          ).toBeUndefined();
          expect(clone).not.toHaveBeenCalled();
          expect(dispatch).not.toHaveBeenCalled();
        } finally {
          cache.abort();
          connected.clear();
          await reopened.work.drain();
          await disposeSessionReadContexts();
          reopened.original?.release();
          reopened.deviceSource.release();
          closeGatewayDeviceRevocation(reopened.context);
          reopened.runtime.close();
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
        }
      },
    },
  );
}, 60_000);

it.each(["lost acknowledgement", "retired actor", "role revoked"] as const)(
  "preserves native reclaim custody after %s without replaying reconciliation",
  async (mode) => {
    await withWorkerLifecycle(async (world) => {
      const originalPlacement = await world.dispatch();
      await world.runEffect("published-before-reclaim");
      const before = expectDefined(await world.readRepository(), "original accepted checkpoint");
      const reconciliations = world.reconcileCount;
      let published = false;
      const stage = checkpoints.stageSessionRepositoryCheckpoint;
      const publication = vi
        .spyOn(checkpoints, "stageSessionRepositoryCheckpoint")
        .mockImplementation(async (...args) => {
          const prepared = await stage(...args);
          return {
            ...prepared,
            publish: async () => {
              const accepted = await prepared.publish();
              expect(accepted.revision).toBe(before.revision + 1);
              published = true;
              if (mode === "role revoked") {
                await world.revokeIssuer();
                return accepted;
              }
              throw new Error("synthetic reply lost after native checkpoint commit");
            },
          };
        });
      try {
        await expect(world.reclaim()).rejects.toThrow();
      } finally {
        publication.mockRestore();
      }
      expect(published, "the real native publication must precede the fault").toBe(true);
      expect(world.reconcileCount).toBe(reconciliations + 1);
      const pending = expectDefined((await world.pendingResults())[0], "original pending reclaim");
      expect(pending).toMatchObject({
        workspaceAcceptedAtMs: null,
        stagedResultRef: null,
        recoveryRequestedAtMs: null,
      });
      expect((await world.readRepository())?.checkpointRef).toBe(
        workerWorkspaceResultRef(pending.claimId),
      );
      expect(world.readPlacement()?.state).toBe("draining");
      expect(world.destroyedLeases).toEqual([]);
      if (mode === "role revoked") {
        expect(world.assertIssuerCurrent).toThrow();
        return;
      }
      if (mode === "retired actor") {
        await world.revokeIssuer();
        expect(world.assertIssuerCurrent).toThrow();
      }
      await world.recover();
      expect(world.reconcileCount).toBe(reconciliations + 1);
      expect((await world.readRepository())?.revision).toBe(before.revision + 1);
      expect(await world.pendingResults()).toEqual([]);
      expect(world.readPlacement()?.state).toBe("reclaimed");
      expect(world.destroyedLeases).toHaveLength(1);
      await world.recover();
      expect(world.destroyedLeases).toHaveLength(1);
      await withSessionRepositoryCheckpoint(
        { workspaceId: world.repositoryId },
        async (snapshot) => {
          expect(await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8")).toBe(
            "accepted worker effect",
          );
        },
      );
      if (mode === "retired actor") {
        expect(world.assertIssuerCurrent).toThrow();
        await expect(world.dispatch()).rejects.toThrow();
        expect(world.destroyedLeases).toHaveLength(1);
      } else {
        const fresh = await world.dispatch();
        expect(fresh.environmentId).not.toBe(originalPlacement.environmentId);
        await world.runEffect("fresh-after-recovery", "fresh authorized worker effect");
        await withSessionRepositoryCheckpoint(
          { workspaceId: world.repositoryId },
          async (snapshot) => {
            expect(await fs.readFile(path.join(snapshot.stagingRoot, "accepted.txt"), "utf8")).toBe(
              "fresh authorized worker effect",
            );
          },
        );
        expect(world.readEntry()?.sessionId).toBe(world.identity.sessionId);
        expect((await world.reclaim()).state).toBe("reclaimed");
        expect(new Set(world.destroyedLeases).size).toBe(2);
        expect(world.destroyedLeases).toHaveLength(2);
      }
      await world.stop();
    });
  },
  120_000,
);
