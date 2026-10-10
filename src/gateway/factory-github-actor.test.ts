import { expect, it } from "vitest";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";

it("projects current prepared actor facts without forwarding ambient credentials", () => {
  let current = true;
  const authority = {
    actorId: 1186191,
    assertCurrent: () => {
      if (!current) {
        throw new Error("original authority revoked");
      }
    },
  };
  const env = {
    GH_TOKEN: "synthetic-ambient-token",
    GH_ENTERPRISE_TOKEN: "synthetic-enterprise-token",
    GITHUB_TOKEN: "synthetic-github-token",
    GITHUB_ENTERPRISE_TOKEN: "synthetic-github-enterprise-token",
    OPENCLAW_FACTORY_GITHUB_PROOF: "stale-proof",
    OPENCLAW_FACTORY_ACTOR_ID: "another-actor",
    OPENCLAW_FACTORY_SESSION_KEY: "another-session",
    PATH: "/synthetic/bin",
  };
  expect(factoryGitHubActorEnvironment(authority, "agent:main:own-session", env)).toEqual({
    PATH: "/synthetic/bin",
    GH_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    OPENCLAW_FACTORY_GITHUB_PROOF: undefined,
    OPENCLAW_FACTORY_ACTOR_ID: "1186191",
    OPENCLAW_FACTORY_SESSION_KEY: "agent:main:own-session",
  });
  expect(() => factoryGitHubActorEnvironment(authority, "")).toThrow();
  current = false;
  expect(() => factoryGitHubActorEnvironment(authority, "agent:main:own-session", env)).toThrow(
    "original authority revoked",
  );
});
