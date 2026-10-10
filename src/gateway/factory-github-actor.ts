import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { factoryGitHubClientProof } from "./factory-github-proof.js";

/** Immutable Factory ingress subject; this shape alone never grants authority. */
export type FactoryGitHubActor = Readonly<{ host: "microsoft.ghe.com"; accountId: number }>;

export function isFactoryGitHubActor(value: unknown): value is FactoryGitHubActor {
  return (
    isRecord(value) &&
    value.host === "microsoft.ghe.com" &&
    typeof value.accountId === "number" &&
    Number.isSafeInteger(value.accountId) &&
    value.accountId > 0
  );
}

/** Project prepared actor facts into the login edge, never infer authority from env strings. */
export function factoryGitHubActorEnvironment(
  authority: Pick<ReturnType<typeof factoryGitHubClientProof>, "actorId" | "assertCurrent">,
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  authority.assertCurrent();
  if (!sessionKey) {
    throw new Error("Factory GitHub session binding is unavailable.");
  }
  return {
    ...env,
    GH_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    OPENCLAW_FACTORY_GITHUB_PROOF: undefined,
    OPENCLAW_FACTORY_ACTOR_ID: String(authority.actorId),
    OPENCLAW_FACTORY_SESSION_KEY: sessionKey,
  };
}
