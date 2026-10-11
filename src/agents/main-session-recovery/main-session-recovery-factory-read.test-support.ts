import { expect } from "vitest";
import { installFactoryExternalTransport } from "../../gateway/factory-github-external.test-support.js";
import { factoryGitHubRequestDigest } from "../../gateway/factory-github-proof.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";

type Binding = {
  actorId: number;
  profileId: string;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  repositoryUrl: string;
  context: GatewayRequestContext;
};

export const factoryRestartChanges = [
  "current grant",
  "missing factory actor",
  "forged only",
  "actor mismatch",
  "host mismatch",
  "alias moved",
  "device removed",
  "grant ended",
  "grant unavailable",
  "role revoked",
  "wrong repository",
  "late repository replaced",
  "broker lease missing",
  "broker actor changed",
  "late role revoke",
  "manual pause",
  "cancel",
  "complete",
  "unknown effect",
] as const;

/** Recovery keeps its exact accepted binding; the shared leaf never manufactures a verdict. */
export function installFactoryRestartRepositoryFixture(params: {
  binding: () => Binding;
  afterLookup: () => Promise<void>;
  broker: () => "current" | "missing lease" | "different actor";
  repositorySnapshot?: () => { commit: string; tree: string } | undefined;
  allowPublicationPreflight?: true;
  allowSessionCreate?: true;
}) {
  return installFactoryExternalTransport({
    ...params,
    executionLogin: "fixture-original-issuer",
    broker: () => params.broker() === "current",
    assertVerdict: (verdict) => {
      const b = params.binding();
      const purpose =
        params.allowPublicationPreflight && verdict.purpose === "publication-preflight"
          ? "publication-preflight"
          : params.allowSessionCreate && verdict.purpose === "session-create-project"
            ? "session-create-project"
            : "session-dispatch-project";
      const binding = {
        kind:
          purpose === "publication-preflight"
            ? "session"
            : purpose === "session-create-project"
              ? "session-create"
              : "session-dispatch",
        agentId: b.agentId,
        sessionKey: b.sessionKey,
        ...(purpose === "session-create-project" && !b.sessionId ? {} : { sessionId: b.sessionId }),
        ...(purpose === "publication-preflight"
          ? {}
          : { requestDigest: factoryGitHubRequestDigest(b.repositoryUrl) }),
      };
      expect(verdict.purpose).toBe(purpose);
      if (purpose === "publication-preflight") expect(verdict.binding).toMatchObject(binding);
      else expect(verdict.binding).toEqual(binding);
      if (purpose !== "session-create-project") expect(b.sessionId).toBeTruthy();
    },
  });
}
