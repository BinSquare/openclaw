import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";

/** Refuse one fixture's real worker commit without replacing its mutation or settlement. */
export function refusePendingInputCommit(params: {
  operation: "stage" | "complete" | "finish" | "withdraw";
  message: string;
  sessionId: string;
  runId: string;
}) {
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  return vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((callback, attachment) =>
      createAdmission((request, grant) => {
        const publication = isRecord(request.facts) ? request.facts.publication : undefined;
        const withdrawal = params.operation === "withdraw";
        const receipt = isRecord(publication) && !withdrawal ? publication.receipt : publication;
        if (
          request.stage === "commit" &&
          isRecord(publication) &&
          publication.kind ===
            (withdrawal
              ? "session-pending-input-withdrawal"
              : "pending-input-settlement-custody") &&
          isRecord(receipt) &&
          (withdrawal || receipt.operation === params.operation) &&
          receipt.sessionId === params.sessionId &&
          receipt.runId === params.runId
        ) {
          throw new Error(params.message);
        }
        callback(request, grant);
      }, attachment),
    );
}
