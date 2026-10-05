import { prepareGitHubReadIdentity } from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import {
  factoryGitHubClientProof,
  readFactoryGitHubToken,
  type FactoryGitHubProofClaim,
} from "./factory-github-proof.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Prepare the protected native identity only for hosts that explicitly opted projects into it. */
export async function prepareGatewayProjectGitHubIdentity(params: {
  agentId: string;
  assertActive: () => void;
  config: OpenClawConfig;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
  client?: GatewayClient | null;
  sessionKey?: string;
  factoryCredential?: { claim: FactoryGitHubProofClaim; assertCurrent: () => void };
}) {
  if (params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  const purpose =
    params.factoryCredential?.claim.purpose === "session-item-read"
      ? "session-item-read"
      : undefined;
  const factoryEnv = factoryGitHubActorEnvironment(params.client, params.sessionKey ?? "", purpose);
  const profileId = params.client?.authenticatedUserProfile?.profileId;
  const assertActive = () => {
    params.assertActive();
    params.factoryCredential?.assertCurrent();
    if (
      factoryEnv &&
      (factoryGitHubActorEnvironment(params.client, params.sessionKey ?? "", purpose)
        ?.OPENCLAW_FACTORY_ACTOR_ID !== factoryEnv.OPENCLAW_FACTORY_ACTOR_ID ||
        params.client?.authenticatedUserProfile?.profileId !== profileId)
    ) {
      throw new Error("Factory project requester changed during preparation");
    }
  };
  if (factoryEnv && !params.factoryCredential) {
    throw new Error("Factory GitHub repository access requires current caller authority.");
  }
  const credential = factoryEnv ? params.factoryCredential : undefined;
  const identity = await prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId: params.agentId,
    env: factoryEnv ?? process.env,
    readNativeCredential: credential
      ? (currentEnv) =>
          readFactoryGitHubToken(
            currentEnv,
            factoryGitHubClientProof({
              client: params.client,
              claim: credential.claim,
              assertCurrent: assertActive,
            }),
          )
      : undefined,
    getCurrentConfig: params.context.getRuntimeConfig,
    assertActive,
    // A protected identity executable owns token refresh and revalidation.
    refresh: async () => {},
  });
  if (
    process.env.FACTORY_AUTH_MODE === "github" &&
    identity.selection.source !== "system-detected"
  ) {
    throw new Error("Factory GitHub repository access requires its native broker identity.");
  }
  return identity;
}
