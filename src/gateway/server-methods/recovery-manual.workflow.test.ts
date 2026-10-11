import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import * as attempts from "../../agents/command/attempt-execution.runtime.js";
import { makeAttemptResult } from "../../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createCreateGoalTool } from "../../agents/tools/goal-tools.js";
import { createMainRestartRecoveryCycle } from "../../config/sessions/main-session-recovery.types.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import * as pendingStore from "../../config/sessions/session-pending-input-store.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { handleGatewayRequest } from "../server-methods.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import * as placementDiagnostics from "../worker-environments/placement-diagnostics.js";
import { withWorkerLifecycle } from "../worker-environments/worker-lifecycle.test-support.js";
import {
  appendUnresolvedCall,
  commandResult,
  manualRecoverySession,
  withManualRecovery,
} from "./recovery-manual.test-support.js";
import * as continuation from "./session-recovery-continuation.js";

const nativeAttempt = vi.hoisted(() => vi.fn<AgentHarnessV2["runAttempt"]>());
// mock-isolation: Substitute only the external native model attempt; keep the registered Codex harness real.
vi.mock("../../../extensions/codex/src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: nativeAttempt,
}));

const acceptedCases = [
  ["recover", null],
  ["cancelled", /No unconsumed accepted input/],
  ["effect", /external action.*no verified outcome/],
  ["opaque capacity", /unverified provider capacity wait/],
  ["live owner", /active work/],
  ["foreign issuer", /original authenticated issuer/],
  ["late role revoke", /Gateway access is not active/],
  ["late lifecycle change", /Session changed/],
  ["late Goal completion", /Session changed/],
  ["mutation await role revoke", /Gateway access is not active/],
  ["committed shutdown", null],
  ["committed foreign issuer", /Original Factory actor profile binding changed/],
  ["committed mutation await role revoke", /Your operator role changed/],
  ["committed untrusted sender", /provenance/],
  ["committed effect", /external action.*no verified outcome/],
  ["committed predecessor effect", /external action.*no verified outcome/],
  ["committed cross-turn result", /external action.*no verified outcome/],
  ["committed newer pending", /provenance/],
] as const;

it.each(acceptedCases)(
  "manual original input recovery keeps independent custody: %s",
  async (mode, refusal) => {
    await withManualRecovery(async (s) => {
      const { fixture, scope, target } = s;
      const { sessionId, sessionKey } = scope;
      const repository = expectDefined(await s.repository(), "original repository");
      const runId = "accepted-browser-run";
      // A historical missing predecessor is input to explicit recovery, never an issued authority.
      const predecessor = {
        ...scope,
        lifecycleRevision: "same-revision",
        lifecycleGeneration: "previous-process",
        runId: "missing-predecessor",
        inputId: "missing-original-input",
        idempotencyKey: "missing-predecessor:user",
        repositoryWorkspaceId: repository.workspaceId,
        issuer: expectDefined(
          s.authority.captureRestartRecoveryIssuer?.(),
          "host-captured original issuer",
        ),
      };
      const goal = {
        schemaVersion: 1 as const,
        id: "manual-goal",
        objective: "Keep original work",
        status: "paused" as const,
        createdAt: 1,
        updatedAt: 2,
        pausedAt: 2,
        tokenStart: 0,
        tokensUsed: 12,
        continuationTurns: 3,
      };
      await replaceSessionEntry(target, {
        sessionId,
        lifecycleRevision: predecessor.lifecycleRevision,
        updatedAt: 3,
        createdActor: { type: "human", source: "profile", id: fixture.profile.id },
        repositoryWorkspaceId: repository.workspaceId,
        status: "interrupted",
        abortedLastRun: true,
        goal,
        goalPauseOrigin: "manual",
        mainRestartRecovery: { ...createMainRestartRecoveryCycle(), turnIntent: predecessor },
      });
      const committed = mode.startsWith("committed ");
      const text = "Run the originally accepted next command on the saved branch";
      const finish = async (
        receipt: Awaited<ReturnType<typeof s.stage>>,
        state: "interrupted" | "cancelled" = "interrupted",
      ) => {
        receipt.finish(state);
        await receipt.settled?.();
      };
      if (committed)
        await finish(
          await s.stage(predecessor, "older-pending-run", "Earlier unresolved accepted input", 1),
        );
      const receipt = await s.stage(
        predecessor,
        runId,
        text,
        4,
        committed ? (mode === "committed untrusted sender" ? "observation" : "profile") : undefined,
      );
      if (committed) {
        if (mode === "committed predecessor effect" || mode === "committed cross-turn result")
          await appendUnresolvedCall(scope, "same-provider-call-id");
        await receipt.runAsync!(() => appendTranscriptMessage(scope, { message: receipt.message }));
        if (mode === "committed cross-turn result")
          await appendTranscriptMessage(scope, {
            message: {
              role: "toolResult",
              toolCallId: "same-provider-call-id",
              toolName: "github",
              content: [{ type: "text", text: "A result in another user turn" }],
            },
          });
        if (mode === "committed newer pending")
          await finish(
            await s.stage(predecessor, "newer-pending-run", "A newer accepted instruction", 6),
          );
      }
      await finish(receipt, mode === "cancelled" ? "cancelled" : "interrupted");
      if (mode === "recover")
        await finish(await s.stage(predecessor, "accepted-follower", "Next accepted FIFO item", 5));
      await s.reopen();
      expect(s.read().mainRestartRecovery?.turnIntent).toEqual(predecessor);
      const saved = await s.input(runId);
      if (committed) {
        expect(saved.committed?.messageId).toBe(receipt.inputId);
        expect(saved.existing).toBeUndefined();
      } else expect(saved.existing?.consumed_event_id).toBeNull();
      if (mode === "effect" || mode === "committed effect")
        await appendUnresolvedCall(scope, "unresolved-remote-write");
      if (mode === "opaque capacity")
        await replaceSessionEntry(target, {
          ...s.read(),
          mainRestartRecovery: {
            ...s.read().mainRestartRecovery!,
            capacityWait: {
              runId: "opaque-allocation",
              lifecycleGeneration: "old",
              sinceMs: 5,
              provider: {
                kind: "settled-shortage-v1",
                environmentId: "",
                ownerEpoch: 0,
                placementGeneration: 1,
                providerId: "fixture",
                profileId: "fixture",
                operationId: "",
                leaseId: "",
                attemptName: "",
                attemptNonce: "",
                providerCode: "",
                attempt: 1,
              },
            },
          },
        });
      if (mode === "foreign issuer" || mode === "committed foreign issuer")
        fixture.client.authenticatedFactoryGitHubAccountId = 999999;
      const lease = mode === "live owner" ? await s.hold() : undefined;
      let restoreReached = false;
      if (
        mode === "late role revoke" ||
        mode === "late lifecycle change" ||
        mode === "late Goal completion"
      ) {
        const prepare = fixture.runtime.recovery.prepareGoalRecoveryAuthority!;
        vi.spyOn(fixture.runtime.recovery, "prepareGoalRecoveryAuthority").mockImplementation(
          async (...args) => {
            const prepared = await prepare(...args);
            restoreReached = true;
            if (mode === "late role revoke")
              await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
            else
              await replaceSessionEntry(target, {
                ...s.read(),
                ...(mode === "late lifecycle change"
                  ? { lifecycleRevision: "replaced-revision" }
                  : { goal: { ...goal, status: "complete" } }),
              });
            return prepared;
          },
        );
      }
      let mutationKind: "recover-accepted" | "recover-committed" | undefined;
      if (
        mode === "mutation await role revoke" ||
        mode === "committed mutation await role revoke"
      ) {
        const prepare = pendingStore.preparePendingInputStore;
        vi.spyOn(pendingStore, "preparePendingInputStore").mockImplementation(async (...args) => {
          const store = await prepare(...args);
          return {
            ...store,
            async mutate(input, ...rest) {
              if (input.kind === "recover-accepted" || input.kind === "recover-committed") {
                mutationKind = input.kind;
                await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
              }
              return store.mutate(input, ...rest);
            },
          };
        });
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let effects = 0;
      vi.spyOn(attempts, "runAgentAttempt").mockImplementation(async (params) => {
        const authority = expectDefined(
          readAdmittedRunOperatorAuthority(await params.preparedRunAdmission.admit("embedded")),
          "recovered admitted authority",
        );
        authority.assertCurrent();
        expect(authority.profileId).toBe(fixture.profile.id);
        expect(params).toMatchObject({ sessionId, runId });
        expect(s.read().goal).toEqual(goal);
        expect((await s.repository())?.requestedRef).toBe(repository.requestedRef);
        expect(
          (await s.history()).filter(
            (message) => isRecord(message) && message.idempotencyKey === runId + ":user",
          ),
        ).toEqual([expect.objectContaining({ content: text, role: "user" })]);
        effects++;
        entered.resolve();
        await release.promise;
        return commandResult(sessionId, "Recovered accepted input");
      });
      const disposition = async () =>
        (await loadTranscriptEvents(scope)).filter(
          (event) => isRecord(event) && event.customType === "restart-recovery-unresolved-input",
        );
      await s.ready();
      try {
        if (!refusal) {
          await s.recover();
          expect(s.respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              sessionId,
              key: sessionKey,
              continuation: { status: "started", runId },
            }),
            undefined,
          );
          await entered.promise;
          await s.recover().catch(() => {});
          expect(effects).toBe(1);
          release.resolve();
          await fixture.runtime.recovery.waitForAgent({ runId, timeoutMs: 10_000 });
          await s.join();
          expect(s.read()).toMatchObject({ goal, repositoryWorkspaceId: repository.workspaceId });
          const unconsumed = await s.input(committed ? "older-pending-run" : "accepted-follower");
          expect(unconsumed.existing).toMatchObject({
            state: "interrupted",
            consumed_event_id: null,
          });
          if (committed) expect(unconsumed.existing?.run_id).toBe("older-pending-run");
          expect(await disposition()).toEqual([
            expect.objectContaining({ data: { intent: predecessor, disposition: "unresolved" } }),
          ]);
          await s.recover().catch(() => {});
          await s.join();
          expect(effects).toBe(1);
        } else {
          await expect(s.recover()).rejects.toThrow(refusal);
          if (mode.startsWith("late ")) expect(restoreReached).toBe(true);
          if (mode.includes("mutation await"))
            expect(mutationKind).toBe(committed ? "recover-committed" : "recover-accepted");
          await s.join();
          expect(effects).toBe(0);
          expect(s.read().mainRestartRecovery?.turnIntent).toEqual(predecessor);
          expect(await disposition()).toEqual([]);
          if (!committed) expect((await s.input(runId)).existing?.consumed_event_id).toBeNull();
        }
      } finally {
        release.resolve();
        lease?.release();
        await s.join();
      }
    });
  },
);

async function exerciseNoGoalRecovery(
  s: ReturnType<typeof manualRecoverySession>,
  settleFresh: () => Promise<void>,
) {
  const { fixture, scope, target } = s;
  const { sessionId } = scope;
  const repository = expectDefined(await s.repository(), "held repository");
  const runId = "original-unknown-run";
  // Explicit historical interrupted action; transcript anchors come from the real writer.
  const held = {
    createdActor: { type: "human" as const, source: "profile" as const, id: fixture.profile.id },
    sessionId,
    updatedAt: 100,
    lifecycleRevision: "original-lifecycle",
    repositoryWorkspaceId: repository.workspaceId,
    status: "interrupted" as const,
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: runId,
    restartRecoveryDeliverySourceRunId: runId,
    restartRecoveryRuns: [{ runId, lifecycleGeneration: "old-generation" }],
    mainRestartRecovery: {
      cycleId: "original-cycle",
      revision: 2,
      chargedAttempts: 0,
      pause: {
        reason: "unverifiable-external-effect" as const,
        pausedAtMs: 100,
        toolCallId: "original-call",
        toolName: "exec",
      },
      turnIntent: {
        ...scope,
        lifecycleRevision: "original-lifecycle",
        repositoryWorkspaceId: repository.workspaceId,
        runId,
        inputId: "original-input",
        idempotencyKey: runId + ":user",
        lifecycleGeneration: "old-generation",
        issuer: expectDefined(s.authority.captureRestartRecoveryIssuer?.(), "original issuer"),
      },
    },
  };
  await replaceSessionEntry(target, held);
  const persisted = await persistSessionTranscriptTurn(scope, {
    messages: [
      {
        message: {
          role: "user",
          content: "Synthetic build",
          idempotencyKey: runId + ":user",
          timestamp: 1,
        },
      },
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "original-call",
              name: "exec",
              arguments: { command: "synthetic-build" },
            },
          ],
          timestamp: 2,
        },
      },
      {
        message: {
          role: "toolResult",
          toolCallId: "original-call",
          toolName: "exec",
          isError: true,
          details: { reason: "missing_tool_result" },
          content: [{ type: "text", text: "Synthetic missing result" }],
          timestamp: 3,
        },
      },
    ],
    updateMode: "none",
  });
  held.mainRestartRecovery.turnIntent.inputId = expectDefined(
    persisted.messages[0]?.messageId,
    "original transcript input anchor",
  );
  await replaceSessionEntry(target, held);
  const history = await s.history();
  const launched = vi.spyOn(continuation, "launchSessionRecoveryContinuation");
  const dispatch = vi.spyOn(fixture.runtime.recovery, "dispatchAgent");
  const attempted = vi.spyOn(attempts, "runAgentAttempt");
  const decision = {
    sessionId,
    lifecycleRevision: held.lifecycleRevision,
    cycleId: held.mainRestartRecovery.cycleId,
    revision: 2,
    pausedAtMs: 100,
    toolCallId: "original-call",
    runId,
  };
  const base = { key: target.sessionKey, agentId: target.agentId };
  const heldUnchanged = () =>
    expect(s.read().mainRestartRecovery?.pause).toEqual(held.mainRestartRecovery.pause);
  await s.recover(base);
  expect(s.respond).toHaveBeenLastCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
  heldUnchanged();
  for (const change of [
    "revision",
    "call",
    "lifecycle",
    "foreign issuer",
    "settling owner",
  ] as const) {
    const altered = structuredClone(held);
    if (change === "foreign issuer")
      altered.mainRestartRecovery.turnIntent.issuer.profileId = "foreign-profile";
    await replaceSessionEntry(target, altered);
    const admission = change === "settling owner" ? await s.hold() : undefined;
    try {
      await s.recover({
        ...base,
        acknowledgeUnknownOutcome: {
          ...decision,
          ...(change === "revision" ? { revision: 1 } : {}),
          ...(change === "call" ? { toolCallId: "stale-call" } : {}),
          ...(change === "lifecycle" ? { lifecycleRevision: "stale-lifecycle" } : {}),
        },
      });
      expect(s.respond.mock.calls.at(-1)?.[0], change).toBe(false);
      heldUnchanged();
    } finally {
      admission?.release();
    }
  }
  await replaceSessionEntry(target, held);
  const confirmed = { ...base, acknowledgeUnknownOutcome: decision };
  await s.recover(confirmed);
  expect(s.respond).toHaveBeenLastCalledWith(
    true,
    { ok: true, key: target.sessionKey, sessionId, continuation: { status: "idle" } },
    undefined,
  );
  const acknowledged = s.read();
  await s.recover(confirmed);
  expect(s.respond.mock.calls.at(-1)?.[0]).toBe(true);
  expect(s.read()).toEqual(acknowledged);
  expect(await s.history()).toEqual(history);
  expect(launched).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(attempted).not.toHaveBeenCalled();
  expect((await s.repository())?.requestedRef).toBe(repository.requestedRef);

  await s.ready();
  expect(await s.fresh("fresh-next-run", "A new harmless turn")).toMatchObject({
    status: "accepted",
    runId: "fresh-next-run",
  });
  await s.join();
  expect(attempted).toHaveBeenCalledOnce();
  expect(s.read()).toMatchObject({ sessionId, repositoryWorkspaceId: repository.workspaceId });
  expect((await s.repository())?.requestedRef).toBe(repository.requestedRef);
  const after = await s.history();
  expect(after.slice(0, history.length)).toEqual(history);
  expect(after).toContainEqual(
    expect.objectContaining({ role: "user", content: "A new harmless turn" }),
  );
  await settleFresh();
  // A different window: current role can disappear while the acknowledgment commit awaits.
  await replaceSessionEntry(target, held);
  const commit = recoveryStore.commitMainSessionRecovery;
  let commitReached = false;
  vi.spyOn(recoveryStore, "commitMainSessionRecovery").mockImplementationOnce(async (params) => {
    commitReached = true;
    await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
    return await commit(params);
  });
  await s.recover(confirmed);
  expect(commitReached).toBe(true);
  expect(s.respond.mock.calls.at(-1)?.[0]).toBe(false);
  heldUnchanged();
}

it.each([
  "current",
  "role revoked",
  "session replaced",
  "same-session rewritten",
  "lifecycle replaced",
] as const)("fences pending-input postcommit publication when %s", async (change) => {
  await withManualRecovery(async (s) => {
    await replaceSessionEntry(s.target, {
      sessionId: s.scope.sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: s.fixture.profile.id },
    });
    const prepare = pendingStore.preparePendingInputStore;
    let publicationReached = false;
    vi.spyOn(pendingStore, "preparePendingInputStore").mockImplementation(async (...args) => {
      const store = await prepare(...args);
      const mutate = store.mutate;
      return {
        ...store,
        mutate: (input, guard, publish) =>
          mutate(input, guard, (facts, assertSourceCurrent) => {
            if (input.kind === "stage") {
              publicationReached = true;
              // These changes happen after the real worker commit, not at admission.
              if (change === "role revoked") setUserProfileRole(s.fixture.profile.id, "revoked");
              if (change === "session replaced" || change === "same-session rewritten") {
                replaceSessionEntrySync(s.target, {
                  ...s.read(),
                  sessionId: change === "session replaced" ? "foreign-session" : s.scope.sessionId,
                  updatedAt: 2,
                });
              }
              if (change === "lifecycle replaced") rotateAgentEventLifecycleGeneration();
            }
            publish?.(facts, assertSourceCurrent);
          }),
      };
    });
    const staged = stageSessionPendingInput(s.scope, {
      runId: "postcommit-input",
      message: {
        role: "user",
        content: "Accepted only under live custody",
        timestamp: 1,
        idempotencyKey: "postcommit-input:user",
      },
      assertCurrent: s.authority.assertCurrent,
      assertAdmittedCurrent: s.authority.assertCurrent,
    });
    if (change === "current") {
      const receipt = expectDefined(await staged, "published live input custody");
      try {
        let executed = false;
        await receipt.runAsync!(() => {
          executed = true;
        });
        expect(executed).toBe(true);
      } finally {
        receipt.finish("interrupted");
        await receipt.settled?.();
      }
    } else {
      await expect(staged).rejects.toThrow(
        change === "role revoked"
          ? /role changed|access is not active/i
          : change === "lifecycle replaced"
            ? /lifecycle/i
            : /authority changed before publication/,
      );
    }
    expect(publicationReached).toBe(true);
  });
});

it("continues a reviewed Goal, acknowledges NoGoal without replay, and admits fresh native work", async ({
  signal,
}) => {
  await withWorkerLifecycle(async (world) => {
    const s = manualRecoverySession(world.issuer, world.identity, world.repositoryId);
    const { fixture, target, scope } = s;
    const { sessionId } = scope;
    {
      for (const needsRecovery of [false, true]) {
        await world.dispatch();
        nativeAttempt.mockClear();
        const runId = `stop-native-${needsRecovery}`;
        const entered = createDeferredCore();
        const aborted = createDeferredCore();
        const recoveryEntered = createDeferredCore();
        const inspected = createDeferredCore();
        const releaseInspection = createDeferredCore();
        const releaseModel = createDeferredCore();
        let nativeSignal: AbortSignal | undefined;
        let nativeSettled = false;
        nativeAttempt.mockImplementation(async (params) => {
          nativeSignal = expectDefined(params.abortSignal, "native cancellation signal");
          expect(world.readPlacement()).toMatchObject({
            state: "active",
            turnClaim: { owner: "local", runId },
          });
          const onAbort = () => aborted.resolve();
          nativeSignal.addEventListener("abort", onAbort, { once: true });
          entered.resolve();
          try {
            await Promise.race([aborted.promise, releaseModel.promise]);
            if (!nativeSignal.aborted)
              throw new Error("Stop fixture released without cancellation");
            if (needsRecovery) {
              // Model cleanup joins the real in-flight inspection, as a native
              // cleanup dependency; no placement result or receipt is fabricated.
              recoveryEntered.resolve();
              await world.recover();
            }
            return makeAttemptResult({
              terminal: { kind: "aborted", source: "runtime" },
              sessionIdUsed: sessionId,
              agentHarnessId: "codex",
            });
          } finally {
            nativeSettled = true;
            nativeSignal.removeEventListener("abort", onAbort);
          }
        });
        const destroyCount = world.destroyedLeases.length;
        const inspect = expectDefined(world.provider.inspect, "provider inspection");
        const inspection = vi
          .spyOn(world.provider, "inspect")
          .mockImplementationOnce(async (...args) => {
            inspected.resolve();
            await releaseInspection.promise;
            return await inspect(...args);
          });
        let sweep: Promise<void> | undefined;
        let stopping: Promise<unknown> | undefined;
        let stale: Promise<unknown> | undefined;
        const recordAwait = placementDiagnostics.recordWorkerPlacementAwait;
        const ordering = vi
          .spyOn(placementDiagnostics, "recordWorkerPlacementAwait")
          .mockImplementation((id, phase, operation, facts, scope) => {
            if (
              id === sessionId &&
              ["pending_dispatch_settlement", "workspace_owner"].includes(phase)
            )
              expect(
                nativeSignal?.aborted,
                "Stop must cancel before joining inspection or cleanup",
              ).toBe(true);
            return recordAwait(id, phase, operation, facts, scope);
          });
        try {
          expect(await s.fresh(runId, `Hold native work ${needsRecovery}`)).toMatchObject({
            status: "accepted",
            runId,
          });
          await withinTest(
            awaitGateBeforeSettlement(entered.promise, s.join(), "native work never entered"),
            signal,
          );
          const controller = expectDefined(
            fixture.context.chatAbortControllers.get(runId),
            "real admitted chat controller",
          );
          expect(controller.controller.signal.aborted).toBe(false);
          sweep = world.recover();
          await withinTest(
            awaitGateBeforeSettlement(inspected.promise, sweep, "inspection not held"),
            signal,
          );
          stopping = world.rpc("sessions.reclaim", { key: scope.sessionKey });
          await withinTest(
            awaitGateBeforeSettlement(
              aborted.promise,
              stopping,
              "Stop did not cancel native work before inspection",
            ),
            signal,
          );
          expect(controller.controller.signal.aborted).toBe(true);
          expect(controller.abortStopReason).toBe("rpc");
          stale = s
            .fresh(runId + "-during-stop", "Must not revive stopped work")
            .catch((error) => error);
          if (needsRecovery) {
            await withinTest(
              awaitGateBeforeSettlement(
                recoveryEntered.promise,
                s.join(),
                "cancelled native work never entered recovery",
              ),
              signal,
            );
            await world.rpc("sessions.describe", { key: scope.sessionKey });
            expect(nativeSettled).toBe(false);
          }
          expect(world.destroyedLeases).toHaveLength(destroyCount);
          releaseInspection.resolve();
          expect(await stopping).toMatchObject({ placement: { state: "reclaimed" } });
          const [, staleOutcome] = await Promise.all([sweep, stale, s.join()]);
          expect(staleOutcome).toBeInstanceOf(GatewayClientRequestError);
          expect(staleOutcome).toMatchObject({
            code: "INVALID_REQUEST",
            message: "agent run aborted | OPENCLAW_DIRECT_ABORT",
          });
          expect(nativeAttempt.mock.calls.map(([params]) => params.runId)).toEqual([runId]);
          expect(nativeSettled).toBe(true);
          expect(world.destroyedLeases).toHaveLength(destroyCount + 1);
          expect(world.readPlacement()).toMatchObject({ state: "reclaimed", turnClaim: null });
          expect(fixture.context.chatAbortControllers.has(runId)).toBe(false);
        } finally {
          releaseModel.resolve();
          releaseInspection.resolve();
          await Promise.allSettled([sweep, stopping, stale, s.join()]);
          ordering.mockRestore();
          inspection.mockRestore();
        }
      }
    }
    nativeAttempt.mockReset();
    world.harnessAttempts.mockClear();
    await world.dispatch();
    await world.runEffect("accepted-before-review");
    await world.reclaim();
    const syncsBefore = world.workspaceSyncs.length;
    await replaceSessionEntry(target, {
      ...s.read(),
      status: "interrupted",
      abortedLastRun: true,
      totalTokens: 100,
    });
    const tool = createCreateGoalTool({
      agentSessionKey: scope.sessionKey,
      sessionAgentId: scope.agentId,
      config: fixture.cfg,
    });
    await withGatewayToolCallerIdentity(
      { ...target, operatorAuthority: s.authority, gatewayContextResolver: () => fixture.context },
      () =>
        tool.execute!("goal-create", { objective: "Complete accepted work", token_budget: 500 }),
    );
    const created = s.read();
    const storePath = resolveGatewaySessionStoreTarget({
      cfg: fixture.cfg,
      key: scope.sessionKey,
      agentId: scope.agentId,
    }).storePath;
    await recoveryStore.commitMainSessionRecovery({
      target: { ...target, storePath },
      requireWriteSuccess: true,
      command: {
        kind: "pause",
        now: Date.now(),
        observation: {
          sessionId,
          cycleId: created.mainRestartRecovery!.cycleId,
          revision: created.mainRestartRecovery!.revision,
        },
        effect: {
          reason: "unverifiable-external-effect",
          toolName: "bash",
          toolCallId: "uncertain-call",
        },
      },
    });
    const source = s.read();
    const goalId = expectDefined(source.goal, "original held Goal").id;
    let starts = 0;
    let reviewed = true;
    nativeAttempt.mockImplementation(async (params) => {
      const context = expectDefined(
        getPluginRuntimeGatewayRequestScope(),
        "actual native placement scope",
      );
      const authority = expectDefined(
        getGatewayToolCallerIdentity()?.operatorAuthority ??
          context.client?.internal?.operatorRunAuthority,
        "original actor at native admission",
      );
      expect(authority.profileId).toBe(world.issuerProfileId);
      expect(authority.scopes).toEqual(["operator.read", "operator.write"]);
      expect(authority.scopes).not.toContain("operator.admin");
      authority.assertCurrent();
      expect(params).toMatchObject({
        runId: reviewed ? "informed-operation" : "fresh-next-run",
        sessionId,
        agentHarnessId: "codex",
      });
      const placement = expectDefined(world.readPlacement(), "native placement");
      if (placement.state !== "active")
        throw new Error("Reviewed continuation has no active placement");
      expect(placement).toMatchObject({
        executionMode: "remote-exec",
        turnClaim: { owner: "local", runId: params.runId },
      });
      const environment = expectDefined(
        world.environments.get(placement.environmentId),
        "native environment",
      );
      const assertNative = expectDefined(context.assertNodeExecutionCurrent, "native effect guard");
      const input = {
        ...scope,
        runId: params.runId,
        nodeId: environment.nodeDeviceId!,
        workspace: {
          ...scope,
          workspaceDir: placement.remoteWorkspaceDir,
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        },
      };
      assertNative(input);
      expect(() => assertNative({ ...input, nodeId: "other-node" })).toThrow();
      if (reviewed) {
        expect(s.read()).toMatchObject({
          goal: { id: goalId, status: "active" },
          mainRestartRecovery: { goalIntent: { issuer: { profileId: authority.profileId } } },
        });
      } else {
        expect(s.read().goal).toBeUndefined();
      }
      expect(s.read().mainRestartRecovery?.pause).toBeUndefined();
      const tunnel = await world.environments.startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        authorize: authority.assertCurrent,
      });
      const output = await tunnel.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('accepted.txt','utf8'))",
        ],
        assertCurrent: () => {
          authority.assertCurrent();
          assertNative(input);
        },
        transportRetry: "never",
      });
      expect(output).toMatchObject({ code: 0, stdout: "accepted worker effect" });
      starts++;
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      return makeAttemptResult({
        terminal: { kind: "ok" },
        sessionIdUsed: sessionId,
        agentHarnessId: "codex",
        assistantTexts: ["Reviewed native continuation completed"],
        lastAssistant: makeAgentAssistantMessage({
          content: [{ type: "text", text: "Reviewed native continuation completed" }],
          timestamp: Date.now(),
        }),
      });
    });
    const request = {
      ...target,
      sessionId,
      goalId,
      action: "resume",
      operationId: "informed-operation",
      issuedAtMs: Date.now(),
    };
    const invoke = async (params: unknown) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "goal-resume", method: "sessions.goal.update", params },
        respond,
        context: fixture.context,
        client: fixture.client,
        isWebchatConnect: () => true,
        hasCurrentClientAuthority: fixture.deviceSource.isCurrent,
      });
      return respond;
    };
    const reference = {
      cycleId: source.mainRestartRecovery!.cycleId,
      revision: source.mainRestartRecovery!.revision,
      pausedAtMs: source.mainRestartRecovery!.pause!.pausedAtMs,
    };
    const confirmed = { ...request, recoveryDecision: reference };
    const refuses = async (params: unknown) => {
      expect(await invoke(params)).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(starts).toBe(0);
      expect(world.workspaceSyncs).toHaveLength(syncsBefore);
      expect(s.read().mainRestartRecovery?.pause).toBeDefined();
    };
    const absent = await invoke(request);
    expect(absent).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: expect.objectContaining({ code: "GOAL_RECOVERY_DECISION_REQUIRED" }),
      }),
    );
    await refuses({
      ...request,
      operationId: "changed-ref",
      recoveryDecision: { ...reference, revision: reference.revision + 1 },
    });
    fixture.client.internal!.syntheticClient = true;
    await refuses({ ...confirmed, operationId: "synthetic-decision" });
    delete fixture.client.internal!.syntheticClient;
    for (const capture of [
      undefined,
      {
        ...source.mainRestartRecovery!.goalIntent!,
        issuer: {
          ...source.mainRestartRecovery!.goalIntent!.issuer,
          factoryActor: { host: "microsoft.ghe.com" as const, accountId: 700101 },
        },
      },
    ]) {
      await replaceSessionEntry(target, {
        ...source,
        mainRestartRecovery: { ...source.mainRestartRecovery!, goalIntent: capture },
      });
      await refuses({ ...confirmed, operationId: capture ? "forged-issuer" : "missing-issuer" });
    }
    await replaceSessionEntry(target, source);
    const response = await invoke(confirmed);
    expect(response).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        goalId,
        sessionId,
        operationId: request.operationId,
        status: "started",
      }),
      undefined,
      expect.anything(),
    );
    await s.join();
    expect(starts).toBe(1);
    expect(nativeAttempt).toHaveBeenCalledOnce();
    expect(world.harnessAttempts).toHaveBeenCalledOnce();
    expect(world.workspaceSyncs).toHaveLength(syncsBefore + 1);
    expect(s.read().goal?.id).toBe(goalId);
    expect(await invoke(confirmed)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ replayed: true, goalId }),
      undefined,
      expect.anything(),
    );
    await s.join();
    expect(starts).toBe(1);
    expect((await world.reclaim()).state).toBe("reclaimed");
    reviewed = false;
    await exerciseNoGoalRecovery(s, async () => {
      expect((await world.reclaim()).state).toBe("reclaimed");
    });
    expect(starts).toBe(2);
    expect(nativeAttempt).toHaveBeenCalledTimes(2);
    nativeAttempt.mockReset();
  });
}, 120_000);
