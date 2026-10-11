import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/model-catalog.js";

export type ModelRuntimeEntry = Omit<ModelChoice, "unavailableReason"> & {
  unavailableReason?:
    | ModelChoice["unavailableReason"]
    | NonNullable<ModelChoice["runtimeChoices"]>[number]["unavailableReason"];
};

/** Runtime capabilities are a complete projection; missing fields must not inherit another harness. */
export function resolveModelRuntimeEntry(
  entry: ModelChoice | undefined,
  agentRuntime: string | null | undefined,
): ModelRuntimeEntry | undefined {
  if (!entry || !agentRuntime || entry.agentRuntime?.id === agentRuntime) {
    return entry;
  }
  const choice = entry.runtimeChoices?.find(
    (candidate) => candidate.agentRuntime.id === agentRuntime,
  );
  return choice
    ? {
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        alias: entry.alias,
        tags: entry.tags,
        apiKeySupported: entry.apiKeySupported,
        ...choice,
      }
    : undefined;
}

/** Ultrafast is offered only from authenticated catalog tiers; missing tiers mean unknown. */
export function runtimeOffersUltrafast(
  runtime: Pick<ModelRuntimeEntry, "available" | "serviceTiers"> | undefined,
): boolean {
  return runtime?.available === true && runtime.serviceTiers?.includes("ultrafast") === true;
}
