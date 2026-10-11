import { expectDefined } from "@openclaw/normalization-core/expect";
import { vi } from "vitest";
import type { SessionsRecoverParams } from "../../../packages/gateway-protocol/src/index.js";
import type { runAgentAttempt } from "../../agents/command/attempt-execution.runtime.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import type { TurnRecoveryIntent } from "../../config/sessions/main-session-recovery.types.js";
import {
  loadSessionEntry,
  appendTranscriptMessage,
} from "../../config/sessions/session-accessor.js";
import {
  readSessionPendingInputStage,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../../plugins/runtime.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { closeGatewayDeviceRevocation } from "../device-revocation.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils-store-lookup.js";
import { sessionRecoverHandlers } from "./sessions-recover.js";

export type ManualIssuer = Awaited<ReturnType<typeof createOriginalIssuerFixture>>;

/** The same authenticated RPC/read/admission bindings serve every manual recovery stage. */
export function manualRecoverySession(
  fixture: ManualIssuer,
  scope: { agentId: string; sessionKey: string; sessionId: string },
  repositoryId: string,
) {
  const authority = expectDefined(fixture.original, "original authenticated issuer").authority;
  const target = { agentId: scope.agentId, sessionKey: scope.sessionKey };
  const storePath = resolveGatewaySessionStoreTarget({
    cfg: fixture.cfg,
    key: scope.sessionKey,
    agentId: scope.agentId,
  }).storePath;
  const respond = vi.fn();
  return {
    fixture,
    scope,
    target,
    authority,
    respond,
    read: () => expectDefined(loadSessionEntry(target), "current manual-recovery session"),
    history: () => readIssuerFixtureHistory(target, scope.sessionId),
    repository: () => getSessionRepositoryWorkspaceStore().get(repositoryId),
    input: (runId: string) => readSessionPendingInputStage(scope, runId + ":user", () => {}),
    async recover(
      params: SessionsRecoverParams = { key: scope.sessionKey, agentId: scope.agentId },
    ) {
      respond.mockClear();
      await sessionRecoverHandlers["sessions.recover"]!({
        params,
        req: { type: "req", id: "manual-recovery", method: "sessions.recover" },
        client: fixture.client,
        context: fixture.context,
        respond,
        hasCurrentClientAuthority: fixture.deviceSource.isCurrent,
        isWebchatConnect: () => true,
      });
    },
    hold: () =>
      beginSessionWorkAdmission({
        scope: storePath,
        identities: [scope.sessionKey, scope.sessionId],
        assertAllowed: authority.assertCurrent,
      }),
    async reopen() {
      rotateAgentEventLifecycleGeneration();
      await closeOpenClawAgentDatabasesAsync();
    },
    ready: () =>
      refreshPreparedModelRuntimeSnapshots(fixture.cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
      }),
    async stage(
      predecessor: TurnRecoveryIntent,
      runId: string,
      text: string,
      timestamp: number,
      sender?: "profile" | "observation",
    ) {
      return expectDefined(
        await stageSessionPendingInput(scope, {
          runId,
          message: {
            role: "user",
            content: text,
            timestamp,
            idempotencyKey: runId + ":user",
            ...(sender
              ? {
                  __openclaw: {
                    senderId: fixture.profile.id,
                    senderIdentity: { type: sender, id: fixture.profile.id },
                    senderIsOwner: true,
                  },
                }
              : {}),
          },
          assertCurrent: authority.assertCurrent,
          trackCompletion: true,
          // Historical predecessor remains unresolved; newly accepted custody is produced by the real worker.
          turnIssuerAdmission: {
            assertCurrent: authority.assertCurrent,
            capture: (entry, input) => ({
              ...predecessor,
              ...entry,
              ...input,
              runId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            }),
          },
        }),
        "durable accepted input",
      );
    },
    async fresh(runId: string, message: string) {
      fixture.client.internal!.operatorRunAuthority = authority;
      const facade = await fixture.runtime.createAgentTurnFacade({ client: fixture.client });
      return await facade.dispatch({ ...scope, message, idempotencyKey: runId, deliver: false });
    },
    join: () => fixture.work.runWhenIdle(() => {}),
  };
}

export type ManualRecoverySession = ReturnType<typeof manualRecoverySession>;

/** No worker allocation is needed for accepted-input storage/decision contracts. */
export async function withManualRecovery(run: (session: ManualRecoverySession) => Promise<void>) {
  await withOpenClawTestState({ label: "manual-recovery-workflow" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const registry = captureActivePluginRegistrySnapshot();
    let fixture: ManualIssuer | undefined;
    try {
      fixture = await createOriginalIssuerFixture(state, 17, "current");
      fixture.context.isConnectionActive = (id) => id === fixture!.client.connId;
      await state.writeConfig(fixture.cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:manual-recovery",
        sessionId: "manual-recovery-session",
      };
      const repository = await getSessionRepositoryWorkspaceStore().create({
        ...scope,
        url: "https://microsoft.ghe.com/acme/accepted.git",
        requestedRef: "clawson/original-branch",
        runSetupScript: false,
        assertCurrent: fixture.original!.authority.assertCurrent,
      });
      await run(manualRecoverySession(fixture, scope, repository.workspaceId));
    } finally {
      try {
        await fixture?.work.drain();
      } finally {
        fixture?.original?.release();
        fixture?.deviceSource.release();
        if (fixture) {
          closeGatewayDeviceRevocation(fixture.context);
          fixture.runtime.close();
        }
        await closeSkillsWatchers(true);
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        restoreActivePluginRegistrySnapshot(registry);
      }
    }
  });
}

export function commandResult(
  sessionId: string,
  text: string,
): Awaited<ReturnType<typeof runAgentAttempt>> {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 0,
      agentMeta: {
        sessionId,
        provider: "fixture",
        model: "allowed",
        usage: { input: 0, output: 0, total: 0 },
      },
      stopReason: "stop",
    },
  };
}

export async function appendUnresolvedCall(scope: ManualRecoverySession["scope"], id: string) {
  await appendTranscriptMessage(scope, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "github", arguments: { action: "create_issue" } }],
    },
  });
}
