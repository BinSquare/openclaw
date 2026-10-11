import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { SessionsGoalUpdateParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import {
  installMockGateway,
  defaultControlUiFeatureMethods,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Reviewed recovery lifecycle" });
suite.define(() => {
  it("reviews NoGoal and Goal recovery without replay or stale operations", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:11111111-2222-4333-8444-555555555555";
        const sessionId = "synthetic-original-session";
        const decision = {
          sessionId,
          lifecycleRevision: "synthetic-lifecycle",
          cycleId: "synthetic-cycle",
          revision: 2,
          pausedAtMs: 100,
          toolCallId: "synthetic-call",
          runId: "synthetic-run",
        };
        const row = {
          label: "Original conversation",
          key: sessionKey,
          sessionId,
          lifecycleRevision: decision.lifecycleRevision,
          kind: "direct",
          updatedAt: 100,
          status: "interrupted",
          hasActiveRun: false,
          interruptedAction: {
            reason: "unverifiable-external-effect",
            toolName: "exec",
            toolCallId: decision.toolCallId,
            decision,
          },
        };
        const list = {
          ts: 100,
          path: "",
          count: 1,
          defaults: { model: "test-model", modelProvider: "test", contextTokens: 128000 },
          sessions: [row],
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [{ ...row, interruptedAction: undefined }],
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.recover"],
          heldMethods: ["sessions.recover", "sessions.goal.update"],
          historyMessages: [
            { role: "user", content: "Synthetic build" },
            {
              role: "assistant",
              content: "The build action was interrupted. Its outcome is unknown.",
            },
          ],
          methodResponses: {
            "sessions.list": { ...list, sessions: [{ ...row, interruptedAction: undefined }] },
          },
        });
        await page.goto(suite.server.baseUrl + "chat/main/111111112222433384445555555555");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        const sockets = await gateway.getSocketCount();
        const sendsBefore = (await gateway.getRequests("chat.send")).length;
        const creationsBefore = (await gateway.getRequests("sessions.create")).length;
        expect(sendsBefore).toBe(0);
        expect(creationsBefore).toBe(0);
        expect(sockets).toBe(1);
        const recoveries = (await gateway.getRequests("sessions.recover")).length;
        expect(recoveries).toBe(0);
        const reads = (await gateway.getRequests("sessions.list")).length;
        await gateway.setSessionsListResponse(list);
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "recovery",
        });
        await gateway.waitForRequest("sessions.list", { after: reads });
        const review = page.getByRole("button", { name: "Review interrupted action", exact: true });
        await review.waitFor();
        expect(await composer.count()).toBe(0);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(recoveries);
        await review.click();
        const checkbox = page.getByRole("checkbox", {
          name: "I acknowledge the unknown outcome and choose not to replay this interrupted turn.",
          exact: true,
        });
        const acknowledge = page.getByRole("button", {
          name: "Acknowledge and return to idle",
          exact: true,
        });
        await checkbox.waitFor();
        expect(await checkbox.isChecked()).toBe(false);
        expect(await acknowledge.isEnabled()).toBe(false);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(recoveries);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(recoveries);
        await review.click();
        await checkbox.check();
        await acknowledge.click();
        const request = await gateway.waitForRequest("sessions.recover", { after: recoveries });
        expect(request.params).toEqual({
          key: sessionKey,
          acknowledgeUnknownOutcome: decision,
        });
        await gateway.setSessionsListResponse({
          ...list,
          ts: 101,
          sessions: [{ ...row, updatedAt: 101, status: "killed", interruptedAction: undefined }],
        });
        await gateway.resolveDeferred("sessions.recover", {
          ok: true,
          key: sessionKey,
          sessionId,
          continuation: { status: "idle" },
        });
        await composer.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(sendsBefore);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(creationsBefore);
        expect(await gateway.getRequests("sessions.recover")).toHaveLength(recoveries + 1);
        expect(await gateway.getSocketCount()).toBe(sockets);
        expect(page.url()).toContain("11111111");
        const now = Date.now();
        const goal = {
          schemaVersion: 1,
          id: "reviewed-goal",
          objective: "Finish the sample deployment",
          status: "paused",
          createdAt: now,
          updatedAt: now,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        };
        const method = "sessions.goal.update";
        const recoveryDecision = { cycleId: "reviewed-cycle", revision: 4, pausedAtMs: now };
        const listReads = (await gateway.getRequests("sessions.list")).length;
        await gateway.setSessionsListResponse({
          ...list,
          ts: now,
          sessions: [
            { ...row, updatedAt: now, status: "idle", interruptedAction: undefined, goal },
          ],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "goal",
        });
        await gateway.waitForRequest("sessions.list", { after: listReads });
        const resume = page.getByRole("button", { name: "Resume goal", exact: true });
        await resume.waitFor();
        const goalBefore = (await gateway.getRequests(method)).length;
        expect(goalBefore).toBe(0);
        await resume.click();
        const first = await gateway.waitForRequest(method, { after: goalBefore });
        expect(first.params).not.toHaveProperty("recoveryDecision");
        const refusal = {
          code: "INVALID_REQUEST",
          message: "Review the interrupted action before continuing.",
          details: {
            code: "GOAL_RECOVERY_DECISION_REQUIRED",
            reason: "goal-recovery-decision-required",
            sessionId,
            goalId: goal.id,
            recoveryDecision,
          },
        };
        await gateway.rejectDeferred(method, refusal);
        const reviewed = page.getByRole("checkbox", {
          name: "I have reviewed the uncertain action and choose to continue this goal.",
          exact: true,
        });
        const confirm = page.getByRole("button", { name: "Continue goal", exact: true });
        await reviewed.waitFor();
        expect(await reviewed.isChecked()).toBe(false);
        expect(await confirm.isEnabled()).toBe(false);
        const savedOperations = () =>
          page.evaluate(() =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith("openclaw.control.goalOperation.v1:"),
            ),
          );
        expect(await savedOperations()).toEqual([]);
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await resume.waitFor();
        expect(await gateway.getRequests(method)).toHaveLength(goalBefore + 1);
        expect(await savedOperations()).toEqual([]);
        expect(await page.getByRole("button", { name: "Check outcome", exact: true }).count()).toBe(
          0,
        );
        const retryBefore = await gateway.deferNext(method);
        await resume.click();
        const retry = await gateway.waitForRequest(method, { after: retryBefore });
        expect(retry.params).not.toHaveProperty("recoveryDecision");
        await gateway.rejectDeferred(method, refusal);
        await reviewed.waitFor();
        expect(await reviewed.isChecked()).toBe(false);
        expect(await confirm.isEnabled()).toBe(false);
        const acceptedBefore = await gateway.deferNext(method);
        expect(acceptedBefore).toBe(goalBefore + 2);
        await reviewed.check();
        await confirm.click();
        const accepted = await gateway.waitForRequest(method, { after: acceptedBefore });
        for (const request of [first, retry, accepted])
          expect(Value.Check(SessionsGoalUpdateParamsSchema, request.params)).toBe(true);
        if (!isRecord(first.params) || !isRecord(retry.params) || !isRecord(accepted.params))
          throw new Error("Expected Goal update request parameters");
        expect(accepted.params).toMatchObject({
          sessionKey,
          sessionId,
          goalId: goal.id,
          action: "resume",
          recoveryDecision,
        });
        expect(
          new Set([first.params.operationId, retry.params.operationId, accepted.params.operationId])
            .size,
        ).toBe(3);
        await gateway.setSessionsListResponse({
          ...list,
          ts: now + 1,
          sessions: [
            {
              ...row,
              updatedAt: now + 1,
              status: "running",
              interruptedAction: undefined,
              goal: { ...goal, status: "active", updatedAt: now + 1 },
            },
          ],
        });
        await gateway.resolveDeferred(method, {
          status: "started",
          operationId: accepted.params.operationId,
          sessionId,
          goalId: goal.id,
          goal: { ...goal, status: "active", updatedAt: now + 1 },
          runId: "reviewed-run",
        });
        await expect.poll(() => reviewed.count()).toBe(0);
        await page.getByRole("button", { name: "Pause goal", exact: true }).waitFor();
        expect(await gateway.getRequests(method)).toHaveLength(goalBefore + 3);
        expect(await savedOperations()).toEqual([]);
        expect(await gateway.getRequests("chat.send")).toHaveLength(sendsBefore);
        expect(await gateway.getRequests("sessions.create")).toHaveLength(creationsBefore);
        expect(await gateway.getSocketCount()).toBe(sockets);
      },
    );
  });
});
