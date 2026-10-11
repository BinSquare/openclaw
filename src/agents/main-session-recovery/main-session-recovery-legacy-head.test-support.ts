import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { createChatAbortOps } from "../../gateway/chat-abort-ops.js";
import { abortChatRunById } from "../../gateway/chat-abort.js";
import { loadSessionEntry as loadGatewaySessionEntry } from "../../gateway/session-utils.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { runAgentAttempt } from "../command/attempt-execution.runtime.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import {
  createOriginalIssuerFixture,
  createOriginalIssuerGateway,
  startOriginalIssuerEvents,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";
import {
  markRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "./main-session-restart-recovery-marking.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery-runtime.js";

type IssuerFixture = Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
type Target = { agentId: string; sessionKey: string; sessionId: string };

/** Keep an unissued predecessor while fresh accepted work survives a real restart. */
export async function createLegacyHeadRecoveryFixture(first: IssuerFixture, target: Target) {
  const legacy = expectDefined(
    await stageSessionPendingInput(target, {
      runId: "legacy-predecessor",
      message: {
        role: "user",
        content: "Earlier accepted input",
        timestamp: 1,
        idempotencyKey: "legacy-predecessor:user",
      },
      assertCurrent: first.original!.authority.assertCurrent,
      trackCompletion: true,
    }),
    "earlier host-owned input without Factory capture",
  );
  legacy.finish("interrupted");
  await legacy.settled?.();
  const entered = createDeferred();
  const release = createDeferred();
  const completed = createDeferred();
  let recovering = false;
  const runs: string[] = [];
  let restoredProfileId: string | undefined;
  const runId = "new-after-held";
  const text = "New authenticated accepted work";
  return {
    async beforeAttempt(params: Parameters<typeof runAgentAttempt>[0]) {
      if (!recovering && params.runId === runId) {
        entered.resolve();
        await release.promise;
      }
    },
    run(params: Parameters<typeof runAgentAttempt>[0], authority: AdmittedRunOperatorAuthority) {
      if (!recovering) {
        return false;
      }
      authority.assertCurrent();
      expect(params.sessionId).toBe(target.sessionId);
      expect(authority.captureRestartRecoveryIssuer?.()?.grant).toBeNull();
      expect(authority.profileId).toBe(restoredProfileId);
      runs.push(params.runId);
      completed.resolve();
      return true;
    },
    async exercise(
      state: OpenClawTestState,
      gateway: ReturnType<typeof createOriginalIssuerGateway>,
      closePreviousEvents: () => Promise<void>,
    ) {
      const held = expectDefined(loadSessionEntry(target), "held historical head");
      expect(held.mainRestartRecovery?.turnIntent).toBeUndefined();
      expect(held.mainRestartRecovery?.queuedInputId).toBe(legacy.inputId);
      const oldInput = (await listSessionPendingInputs(target)).items.find(
        (item) => item.id === legacy.inputId,
      );
      const fresh = await createOriginalIssuerFixture(
        state,
        0,
        "current",
        false,
        { ...first, ...gateway },
        true,
      );
      const resolveGatewayContext = expectDefined(
        gateway.context.resolveGatewayContext,
        "original Gateway binding",
      );
      const ingress = await beginSessionWorkAdmission({
        scope: loadGatewaySessionEntry(target.sessionKey, { agentId: target.agentId }, first.cfg)
          .storePath,
        identities: [target.sessionKey, target.sessionId],
        resolveGatewayContext,
        assertAllowed: (signal) => {
          signal.throwIfAborted();
          fresh.original!.authority.assertCurrent();
        },
      });
      let restarted: ReturnType<typeof createOriginalIssuerGateway> | undefined;
      let closeRestartEvents: (() => Promise<void>) | undefined;
      try {
        restoredProfileId = fresh.profile.id;
        fresh.client.internal!.operatorRunAuthority = fresh.original!.authority;
        const facade = await gateway.runtime.createAgentTurnFacade({ client: fresh.client });
        await expect(
          facade.dispatch({ ...target, message: text, idempotencyKey: runId, deliver: false }),
        ).resolves.toMatchObject({ status: "accepted" });
        await entered.promise;
        const accepted = expectDefined(
          loadSessionEntry(target)?.mainRestartRecovery?.turnIntent,
          "new original accepted intent",
        );
        expect(accepted.runId).toBe(runId);
        expect(accepted.issuer.grant).toBeNull();
        await markRestartAbortedMainSessions({
          cfg: first.cfg,
          resolveGatewayContext,
          reason: "current accepted input restart",
          activeRuns: [
            {
              ...target,
              runId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              accepted: true,
            },
          ],
          isActiveRun: () => true,
        });
        expect(
          abortChatRunById(createChatAbortOps(gateway.context), {
            runId,
            sessionKey: target.sessionKey,
            stopReason: "restart",
          }).aborted,
        ).toBe(true);
        release.resolve();
        ingress.release();
        await first.work.runWhenIdle(() => {});
        fresh.original!.release();
        fresh.deviceSource.release();
        await closePreviousEvents();
        gateway.runtime.close();
        rotateAgentEventLifecycleGeneration();
        await closeOpenClawAgentDatabasesAsync();
        const interrupted = expectDefined(
          loadSessionEntry(target),
          "captured interruption snapshot",
        );
        expect(interrupted.restartRecoveryForceSafeTools).toBe(true);
        restarted = createOriginalIssuerGateway(first);
        first.context = restarted.context;
        closeRestartEvents = startOriginalIssuerEvents(restarted.context);
        recovering = true;
        await refreshPreparedModelRuntimeSnapshots(first.cfg, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
        await markStartupOrphanedMainSessionsForRecovery({
          cfg: first.cfg,
          stateDir: state.stateDir,
        });
        expect(loadSessionEntry(target)?.restartRecoveryForceSafeTools).toBe(
          interrupted.restartRecoveryForceSafeTools,
        );
        const recovery = await expectDefined(
          restarted.runtime.recovery.prepareGoalRecoveryAuthority,
          "canonical original-issuer restore",
        )(accepted, target);
        try {
          recovery.authority.assertCurrent();
        } finally {
          recovery.release();
        }
        await recoverRestartAbortedMainSessions({
          cfg: first.cfg,
          stateDir: state.stateDir,
          gatewayRuntime: restarted.runtime.recovery,
        });
        await completed.promise;
        await first.work.runWhenIdle(() => {});
        expect(runs).toHaveLength(1);
        const history = await readIssuerFixtureHistory(target, target.sessionId);
        expect(
          history.filter(
            (message) => isRecord(message) && message.idempotencyKey === runId + ":user",
          ),
        ).toEqual([expect.objectContaining({ role: "user", content: text })]);
        expect(loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.turnIntent).toBeUndefined();
        await markStartupOrphanedMainSessionsForRecovery({
          cfg: first.cfg,
          stateDir: state.stateDir,
        });
        await recoverRestartAbortedMainSessions({
          cfg: first.cfg,
          stateDir: state.stateDir,
          gatewayRuntime: restarted.runtime.recovery,
        });
        await first.work.runWhenIdle(() => {});
        expect(runs).toHaveLength(1);
        expect(
          (await listSessionPendingInputs(target)).items.find((item) => item.id === legacy.inputId),
        ).toEqual(oldInput);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.queuedInputId).toBe(legacy.inputId);
      } finally {
        ingress.release();
        release.resolve();
        await first.work.runWhenIdle(() => {});
        fresh.original!.release();
        fresh.deviceSource.release();
        await closeRestartEvents?.();
        restarted?.runtime.close();
      }
    },
  };
}
