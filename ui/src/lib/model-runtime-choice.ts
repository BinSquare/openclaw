import type { GatewaySessionRow } from "../api/types.ts";

export function isSessionRuntimePinned(runtime: GatewaySessionRow["agentRuntime"]): boolean {
  return runtime?.source === "session-key" || runtime?.source === "session";
}
