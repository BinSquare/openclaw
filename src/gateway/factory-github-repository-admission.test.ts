import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";
import type { FactoryGitHubProofClaim } from "./factory-github-proof.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";
const claim: FactoryGitHubProofClaim = {
  purpose: "publication-preflight",
  binding: {
    kind: "session",
    agentId: "main",
    sessionKey: "session-key",
    sessionId: "session-id",
    lifecycleRevision: "revision",
  },
};
const request: GitHubRepositoryAdmissionRequest = {
  kind: "repository-admission",
  host: "microsoft.ghe.com",
  selection: {
    profileId: "ghp_6128c113c0df8c1a366dfe690c062d8e",
    kind: "app-installation",
    app: {
      appId: 13361,
      installationId: 119386,
      accountId: 185961,
      repositories: [{ id: 1044511, fullName: "bic/lobster" }],
      permissions: { contents: "write" },
      privateKey: { source: "env", provider: "default", id: "OPENCLAW_GITHUB_APP_PRIVATE_KEY" },
      keyVersion: "synthetic",
    },
  },
};
const env = {
  OPENCLAW_GATEWAY_PASSWORD: "synthetic-password",
  OPENCLAW_FACTORY_GITHUB_PROOF: "synthetic-proof",
  OPENCLAW_FACTORY_ACTOR_ID: "42",
};
function receipt() {
  return {
    version: 1,
    kind: "repository-admission",
    host: request.host,
    appId: 13361,
    installationId: 119386,
    repository: { id: 1044511, fullName: "bic/lobster" },
    actor: { accountId: 42, profileId: "original-human" },
    ...claim,
    expiresAtMs: Date.now() + 60_000,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("Factory App repository admission", () => {
  it("uses only fixed private HTTP and matches original human, installation, repository and exact binding", async () => {
    const transport = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal("fetch", transport);
    const result = await readFactoryRepositoryAdmission({
      env,
      request,
      claim,
      profileId: "original-human",
      assertCurrent: () => {},
    });
    expect(result).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toEqual([
      "http://127.0.0.1:8080/__factory__/github/repository-admission",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: {
          authorization: "Bearer synthetic-password",
          "x-factory-github-proof": "synthetic-proof",
        },
      }),
    ]);
  });
  it.each(["actor", "profile", "installation", "binding", "expired", "bearer"])(
    "refuses %s receipt",
    async (mode) => {
      const value: Record<string, unknown> = receipt();
      if (mode === "actor") {
        value.actor = { accountId: 43, profileId: "original-human" };
      }
      if (mode === "profile") {
        value.actor = { accountId: 42, profileId: "foreign-human" };
      }
      if (mode === "installation") {
        value.installationId = 1;
      }
      if (mode === "binding") {
        value.binding = { ...claim.binding, sessionId: "replacement" };
      }
      if (mode === "expired") {
        value.expiresAtMs = Date.now();
      }
      if (mode === "bearer") {
        value.token = "synthetic-human-bearer";
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(value)),
      );
      await expect(
        readFactoryRepositoryAdmission({
          env,
          request,
          claim,
          profileId: "original-human",
          assertCurrent: () => {},
        }),
      ).rejects.toThrow("could not be verified");
    },
  );
  it("refuses late original authority and redacts transport failure", async () => {
    let current = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        current = false;
        return Response.json(receipt());
      }),
    );
    const assertCurrent = () => {
      if (!current) {
        throw new Error("original owner closed");
      }
    };
    await expect(
      readFactoryRepositoryAdmission({
        env,
        request,
        claim,
        profileId: "original-human",
        assertCurrent,
      }),
    ).rejects.toThrow("original owner closed");
    current = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic-password synthetic-proof");
      }),
    );
    await expect(
      readFactoryRepositoryAdmission({
        env,
        request,
        claim,
        profileId: "original-human",
        assertCurrent,
      }),
    ).rejects.toThrow("Factory repository admission could not be verified.");
  });
});
