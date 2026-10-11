import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  parseWorkerGitHubLaunchBinding,
  prepareWorkerGitHubBindingGrant,
  writeManagedGitHubProfileFiles,
} from "openclaw/plugin-sdk/github-worker-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { exerciseNativeStartup } from "./session-recovery-startup.test-support.js";

const nativeAttempt = vi.hoisted(() => vi.fn<AgentHarnessV2["runAttempt"]>());
afterEach(() => closeSkillsWatchers(true));
// mock-isolation: Replace only model execution; importing the real attempt installs the process-global Codex client disposer.
vi.mock("../../../extensions/codex/src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: nativeAttempt,
}));

it.each(["current", "revoked"] as const)(
  "automatically continues an accepted no-goal turn through startup with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode),
);

it.each(["goal", "turn"] as const)(
  "carries restored original %s authority through the SDK grant and exact managed worker workspace",
  (intent) =>
    exerciseNativeStartup(
      nativeAttempt,
      "current",
      intent,
      "failed-cleanup",
      undefined,
      false,
      async (input) => {
        const authority = expectDefined(
          getGatewayToolCallerIdentity()?.operatorAuthority ??
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
          "current original SDK issuer",
        );
        authority.assertCurrent();
        const grant = expectDefined(
          await prepareWorkerGitHubBindingGrant({
            ...input.workspace,
            agentId: input.agentId,
            operatorAuthority: authority,
            assertCurrent: () => {
              input.assertCurrent();
              return true;
            },
          }),
          "original issuer SDK launch grant",
        );
        const profile = path.join(input.workspace.workspaceDir, ".sdk-github");
        let acquired: Awaited<ReturnType<typeof input.acquireManagedWorkspaceAsync>> | undefined;
        try {
          const assertGrantCurrent = expectDefined(grant.assertCurrent, "current SDK grant guard");
          const assertCurrent = () => {
            input.assertCurrent();
            assertGrantCurrent();
          };
          acquired = await input.acquireManagedWorkspaceAsync(input.workspace);
          assertCurrent();
          const binding = expectDefined(
            parseWorkerGitHubLaunchBinding(grant.binding),
            "canonical node launch binding",
          );
          expect(binding).toMatchObject({
            login: "fixture-original-issuer",
            host: "microsoft.ghe.com",
          });
          await writeManagedGitHubProfileFiles(profile, binding, {
            assertCurrent,
          });
          assertCurrent();
          expect((await fs.stat(path.join(profile, "hosts.yml"))).mode & 0o077).toBe(0);
          await expect(
            input.acquireManagedWorkspaceAsync({
              ...input.workspace,
              sessionId: "different-session",
            }),
          ).rejects.toThrow("does not own");
          await expect(
            input.acquireManagedWorkspaceAsync({
              ...input.workspace,
              ownerEpoch: input.workspace.ownerEpoch + 1,
            }),
          ).rejects.toThrow("does not own");
          const result = await input.runWorkspaceCommand({
            transportRetry: "never",
            argv: [
              "node",
              "-e",
              "process.stdout.write(require('node:fs').readFileSync('accepted.txt', 'utf8'))",
            ],
            timeoutMs: 10_000,
            assertCurrent,
          });
          assertCurrent();
          return result;
        } finally {
          acquired?.release();
          await grant.revoke();
          await fs.rm(profile, { recursive: true, force: true });
        }
      },
    ),
);

it.each(["current", "revoked-after-disposal"] as const)(
  "automatically disposes failed owned compute before recovering the accepted no-goal turn with %s authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "turn", "failed-cleanup"),
);

it.each(["current", "revoked"] as const)(
  "automatically continues an originally active Goal through startup with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal"),
);

it.each(["current", "revoked-after-disposal"] as const)(
  "automatically recovers an active Goal from its FAILED owned source with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal", "failed"),
);

it.each(["warm", "miss", "unknown-claim", "target-replaced"] as const)(
  "continues startup through canonical prepared-worker %s selection with original native authority",
  (scenario) => exerciseNativeStartup(nativeAttempt, "current", "goal", "reclaimed", scenario),
);

it("denies a warm startup native effect after current original role revocation", () =>
  exerciseNativeStartup(nativeAttempt, "revoked", "goal", "reclaimed", "warm"));

it.each(["current", "revoked-after-read"] as const)(
  "fences a delayed original native result through fresh startup with %s authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal", "reclaimed", "warm", true),
);
