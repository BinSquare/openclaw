import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionPendingInputStage,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import * as pendingStore from "../../config/sessions/session-pending-input-store.js";
import { captureGatewayTurnIssuerAdmission } from "../../gateway/operator-run-authority.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";
import * as recoveryStore from "./main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";
import * as restartRecovery from "./main-session-restart-recovery.js";

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "current",
  "foreign owner",
  "settling owner",
  "late issuer revoke",
  "late lifecycle rotation",
  "late intent replacement",
  "unknown effect",
  "wrong issuer intent",
] as const)("retains fresh NoGoal foreground custody without replay: %s", async (mode) => {
  await withOpenClawTestState({ label: "current-recovery-input" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const fixture = await createOriginalIssuerFixture(state, 31, "current");
    const authority = fixture.original!.authority;
    const sessionKey = "agent:main:dashboard:current-recovery-input";
    const sessionId = "original-session";
    const runId = "new-accepted-run";
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const target = { agentId: "main", sessionKey, storePath };
    await replaceSessionEntry(target, {
      sessionId,
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: fixture.profile.id },
      status: "interrupted",
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "original-cycle", revision: 1, chargedAttempts: 0 },
    });
    const scope = { ...target, sessionId };
    const finishEntered = createDeferredCore();
    const releaseFinish = createDeferredCore();
    if (mode === "settling owner") {
      const prepare = pendingStore.preparePendingInputStore;
      vi.spyOn(pendingStore, "preparePendingInputStore").mockImplementationOnce(async (...args) => {
        const store = await prepare(...args);
        return {
          ...store,
          async mutate(input, ...rest) {
            if (input.kind === "finish") {
              finishEntered.resolve();
              await releaseFinish.promise;
            }
            return store.mutate(input, ...rest);
          },
        };
      });
    }
    const receipt = expectDefined(
      await stageSessionPendingInput(scope, {
        runId,
        message: {
          role: "user",
          content: "Fresh authorized conversation",
          timestamp: 2,
          idempotencyKey: `${runId}:user`,
        },
        assertCurrent: authority.assertCurrent,
        turnIssuerAdmission: captureGatewayTurnIssuerAdmission({
          authority,
          sessionKey,
          sessionId,
          lifecycleRevision: "original-revision",
          runId,
          assertCurrent: authority.assertCurrent,
        }),
      }),
      "fresh accepted custody",
    );
    const dispatch = vi.spyOn(fixture.runtime.recovery, "dispatchAgent");
    const warnings = vi.spyOn(mainSessionRecoveryLog, "warn");
    if (mode === "unknown effect") {
      await appendTranscriptMessage(scope, {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "unverified-effect",
              name: "github",
              arguments: { action: "create_issue" },
            },
          ],
        },
      });
    }
    if (mode === "wrong issuer intent") {
      const entry = loadSessionEntry(target)!;
      const intent = entry.mainRestartRecovery!.turnIntent!;
      await replaceSessionEntry(target, {
        ...entry,
        mainRestartRecovery: {
          ...entry.mainRestartRecovery!,
          turnIntent: {
            ...intent,
            issuer: {
              ...intent.issuer,
              factoryActor: { host: "microsoft.ghe.com", accountId: 999999 },
            },
          },
        },
      });
    }
    if (mode === "late intent replacement") {
      const claim = recoveryStore.claimMainSessionRecoveryOwner;
      vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner").mockImplementationOnce(
        async (params) => {
          const entry = loadSessionEntry(target)!;
          await replaceSessionEntry(target, {
            ...entry,
            mainRestartRecovery: {
              ...entry.mainRestartRecovery!,
              turnIntent: {
                ...entry.mainRestartRecovery!.turnIntent!,
                runId: "foreign-replacement-run",
              },
            },
          });
          const result = await claim(params);
          expect(result.kind).toBe("invalidated");
          return result;
        },
      );
    }
    const retryActual = restartRecovery.retryRestartAbortedMainSessionRecovery;
    vi.spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery").mockImplementation(
      async (request) => {
        const result = await retryActual(request);
        if (mode === "current" || mode.startsWith("late ")) {
          expect(result.currentInput?.kind).toBe("current-input");
        } else {
          expect(result.currentInput).toBeUndefined();
        }
        if (mode === "late issuer revoke") {
          await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
        } else if (mode === "late lifecycle rotation") {
          rotateAgentEventLifecycleGeneration();
        }
        return result;
      },
    );
    let operation: Awaited<ReturnType<typeof admitReplyTurn>> | undefined;
    try {
      const admit = () =>
        admitReplyTurn({
          ...target,
          sessionId,
          expectedSessionId: sessionId,
          kind: "visible",
          resetTriggered: false,
          resolveGatewayContext: () => fixture.context,
          assertRequestCurrent: authority.assertCurrent,
        });
      const admission =
        mode === "foreign owner"
          ? admit()
          : receipt.runAsync!(async () => {
              if (mode === "settling owner") {
                receipt.finish("interrupted");
                await finishEntered.promise;
              }
              return await admit();
            });
      if (mode !== "current") {
        await expect(admission).rejects.toThrow(
          mode === "late issuer revoke"
            ? /access|role|authority/i
            : mode === "late lifecycle rotation" || mode === "late intent replacement"
              ? /changed|ownership ended/i
              : mode === "unknown effect"
                ? /paused|verified outcome/i
                : /Restart recovery failed|ownership ended/i,
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
        expect(
          (await readIssuerFixtureHistory(target, sessionId)).filter(
            (message) =>
              message &&
              typeof message === "object" &&
              "idempotencyKey" in message &&
              message.idempotencyKey === `${runId}:user`,
          ),
        ).toEqual([]);
        expect(
          (await readSessionPendingInputStage(scope, `${runId}:user`, () => {})).existing
            ?.consumed_event_id,
        ).toBeNull();
        return;
      }
      operation = await admission.catch((error: unknown) => {
        throw new Error(JSON.stringify(warnings.mock.calls), { cause: error });
      });
      expect(operation.status).toBe("owned");
      expect(dispatch).not.toHaveBeenCalled();
      expect(loadSessionEntry(target)).toMatchObject({
        sessionId,
        lifecycleRevision: "original-revision",
        mainRestartRecovery: { turnIntent: { inputId: receipt.inputId, runId } },
      });
      expect(loadSessionEntry(target)?.goal).toBeUndefined();
      expect(loadSessionEntry(target)?.mainRestartRecovery?.chargedAttempts).toBe(0);
      expect(loadSessionEntry(target)?.mainRestartRecovery?.reservation).toBeUndefined();
      expect(
        (await readSessionPendingInputStage(scope, `${runId}:user`, authority.assertCurrent))
          .existing,
      ).toMatchObject({ input_id: receipt.inputId, consumed_event_id: null });
      await receipt.runAsync!(() => appendTranscriptMessage(scope, { message: receipt.message }));
      expect(
        (await readIssuerFixtureHistory(target, sessionId)).filter(
          (message) =>
            message &&
            typeof message === "object" &&
            "idempotencyKey" in message &&
            message.idempotencyKey === `${runId}:user`,
        ),
      ).toHaveLength(1);
    } finally {
      releaseFinish.resolve();
      if (operation?.status === "owned") {
        operation.operation.complete();
      }
      receipt.finish("interrupted");
      await receipt.settled?.();
      await fixture.work.runWhenIdle(() => {});
      fixture.original!.release();
      fixture.deviceSource.release();
      fixture.runtime.close();
    }
  });
});
