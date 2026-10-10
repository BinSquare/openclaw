import type { OpenClawConfig } from "../../config/types.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderPreparedIntent } from "./preparation-identity.js";
import type { PreparedPoolPresenceOptions } from "./prepared-pool-presence.js";
import type { createWorkerProviderIntent } from "./provider-intent.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

export type PreparedPoolPolicy = {
  providerId: string | undefined;
  target: number;
  maxTotal: number;
};

export type PreparedPoolAdmission = {
  policy: (profileId: string) => PreparedPoolPolicy;
  reserve: (input: {
    profileId: string;
    intent: WorkerProviderPreparedIntent;
    projectKey: string;
    preparationKey: string;
    demandAtMs: number;
    expiresAtMs: number;
    limits: Pick<PreparedPoolPolicy, "target" | "maxTotal">;
    assertCurrent: () => void;
  }) => Promise<WorkerEnvironmentRecord | undefined>;
};

export type PreparedWorkerPoolOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareIntent: (
    profileId: string,
    options: NonNullable<
      Parameters<ReturnType<typeof createWorkerProviderIntent>["prepareIntent"]>[1]
    >,
  ) => Promise<WorkerProviderPreparedIntent>;
  assertIntentCurrent: (profileId: string, intent: WorkerProviderPreparedIntent) => void;
  prepareRetention: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
  ) => Promise<{ isCurrent: () => boolean } | undefined>;
  reconcile: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    beforeReconcile: () => void,
  ) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
  warn: (message: string) => void;
  resolveHumanPresenceDemand?: PreparedPoolPresenceOptions["resolveHumanPresenceDemand"];
  resolveStandingImageDemand?: PreparedPoolPresenceOptions["resolveStandingImageDemand"];
  presenceDemandStore?: PreparedPoolPresenceOptions["presenceDemandStore"];
};
