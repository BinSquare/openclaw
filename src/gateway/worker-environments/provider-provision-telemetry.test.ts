import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerEnvironmentRecord } from "./store.js";

const sink = vi.hoisted(() => vi.fn<(message: string, facts: Record<string, unknown>) => void>());
vi.mock("../../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ info: sink, warn: sink }),
}));

import { withWorkerProvisionStage } from "./provider-provision-telemetry.js";

const record = {
  environmentId: "worker-1",
  provisionOperationId: "operation-1",
  leaseId: null,
  attachedSessionIds: [],
} satisfies Pick<
  WorkerEnvironmentRecord,
  "environmentId" | "provisionOperationId" | "leaseId" | "attachedSessionIds"
>;

beforeEach(() => {
  sink.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("Gateway worker provisioning telemetry", () => {
  it.each(["safe", "unsafe", "hostile"] as const)(
    "correlates a failed stage and excludes raw error contents (%s name)",
    async (kind) => {
      const failure = new Error("Bearer secret-value");
      if (kind === "unsafe") {
        failure.name = "Bearer secret-value";
      } else if (kind === "hostile") {
        Object.defineProperty(failure, "name", {
          get: () => {
            throw new Error("private metadata failure");
          },
        });
      }
      const clock = vi.spyOn(performance, "now").mockReturnValue(100);
      const wall = vi.spyOn(Date, "now").mockReturnValue(5_000);
      await expect(
        withWorkerProvisionStage(
          record,
          "node-bundle-install",
          async () => {
            clock.mockReturnValue(112.6);
            wall.mockReturnValue(1);
            throw failure;
          },
          "cbx_1",
        ),
      ).rejects.toBe(failure);
      expect(sink.mock.calls).toEqual([
        [
          "worker provision stage",
          {
            environmentId: "worker-1",
            provisionOperationId: "operation-1",
            leaseId: "cbx_1",
            sessionId: null,
            stage: "node-bundle-install",
            outcome: "started",
            elapsedMs: 0,
          },
        ],
        [
          "worker provision stage",
          {
            environmentId: "worker-1",
            provisionOperationId: "operation-1",
            leaseId: "cbx_1",
            sessionId: null,
            stage: "node-bundle-install",
            outcome: "failed",
            elapsedMs: 13,
            errorCode: kind === "safe" ? "Error" : "unknown",
          },
        ],
      ]);
      expect(JSON.stringify(sink.mock.calls)).not.toContain("secret-value");
    },
  );

  it.each(["started", "completed", "failed"] as const)(
    "preserves required work and its outcome when the %s sink throws",
    async (outcome) => {
      sink.mockImplementation((_message, facts) => {
        if (facts.outcome === outcome) {
          throw new Error("synthetic diagnostic sink failure");
        }
      });
      const result = { committed: true };
      const failure = new Error("required provision work failed");
      const run = vi.fn(async () => {
        if (outcome === "failed") {
          throw failure;
        }
        return result;
      });
      const operation = withWorkerProvisionStage(record, "ready-commit", run);
      if (outcome === "failed") {
        await expect(operation).rejects.toBe(failure);
      } else {
        await expect(operation).resolves.toBe(result);
      }
      expect(run).toHaveBeenCalledOnce();
      expect(sink.mock.calls.map(([, facts]) => facts.outcome)).toEqual([
        "started",
        outcome === "failed" ? "failed" : "completed",
      ]);
    },
  );
});
