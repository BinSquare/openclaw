import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as attemptRuntime from "../command/attempt-execution.runtime.js";
import { emitAgentHarnessAttemptEvent } from "../harness/attempt-events.js";
import { registerAgentHarness } from "../harness/registry.js";
import type { AgentHarnessV2 } from "../harness/types.js";
import * as runtimePlugins from "../runtime-plugins.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

type Command = Parameters<typeof attemptRuntime.runAgentAttempt>[0];

/** Replace only inference; admission, persistence, terminal settlement and lanes stay real. */
export function installRecoveryModelLeaf(input: {
  cfg: OpenClawConfig;
  registry: PluginRegistry;
  beforeAttempt?: (command: Command) => Promise<void>;
  run: (command: Command, authority: AdmittedRunOperatorAuthority) => Promise<void>;
  failed: (error: unknown, command: Command) => void;
}) {
  const commands = new Map<string, Command>();
  const harness: AgentHarnessV2 = {
    id: "recovery-fixture",
    label: "Recovery fixture inference",
    nativeModelPolicySupport: "exact",
    supportsTurnScopedToolRestrictions: true,
    conversationToolPolicySupport: "exact",
    supports: () => ({ supported: true }),
    async runAttempt(params) {
      const command = expectDefined(commands.get(params.runId), "real command invocation");
      try {
        params.hostCapabilities.assertActive();
        const authority = expectDefined(
          command.preparedRunAdmission.readOperatorAuthority?.(),
          "real admitted operator source",
        );
        const recorder = expectDefined(command.userTurnTranscriptRecorder, "user recorder");
        expect(recorder.hasPersisted(), "input committed before model execution").toBe(true);
        expect(recorder.getAdmissionReceipt(), "real transcript admission receipt").toBeDefined();
        await emitAgentHarnessAttemptEvent(
          params,
          {
            stream: "lifecycle",
            data: { phase: "start", startedAt: Date.now() },
          },
          { label: "recovery fixture", log: mainSessionRecoveryLog },
        );
        await input.run(command, authority);
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          lastAssistant: makeAgentAssistantMessage({
            provider: params.provider,
            model: params.modelId,
            content: [{ type: "text", text: "Accepted queued work completed" }],
            timestamp: Date.now(),
          }),
          assistantTexts: ["Accepted queued work completed"],
        });
      } catch (error) {
        input.failed(error, command);
        throw error;
      }
    },
  };
  input.cfg.agents!.defaults!.models = {
    ...input.cfg.agents!.defaults!.models,
    "fixture/allowed": { agentRuntime: { id: harness.id } },
  };
  const register = (registry: PluginRegistry) =>
    withPluginRuntimeRegistryScope(registry, () => registerAgentHarness(harness));
  register(input.registry);
  const load = runtimePlugins.loadAgentRuntimePluginRegistryHandle;
  const loader = vi
    .spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle")
    .mockImplementation((...args) => {
      const registry = load(...args);
      register(registry);
      return registry;
    });
  const acquire = runtimePlugins.acquireAgentRuntimePluginRegistry;
  const acquirer = vi
    .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
    .mockImplementation(async (...args) => {
      const acquired = await acquire(...args);
      register(acquired.registry);
      return acquired;
    });
  const run = attemptRuntime.runAgentAttempt;
  const execution = vi
    .spyOn(attemptRuntime, "runAgentAttempt")
    .mockImplementation(async (command) => {
      commands.set(command.runId, command);
      try {
        await input.beforeAttempt?.(command);
        const result = await run(command);
        if (result.meta.error) {
          input.failed(result.meta.error, command);
        }
        return result;
      } catch (error) {
        input.failed(error, command);
        throw error;
      } finally {
        commands.delete(command.runId);
      }
    });
  return () => {
    execution.mockRestore();
    acquirer.mockRestore();
    loader.mockRestore();
  };
}
