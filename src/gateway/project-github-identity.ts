import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import {
  prepareGitHubReadIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../agents/github-tool-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import {
  factoryGitHubClientProof,
  readFactoryGitHubToken,
  type FactoryGitHubProofClaim,
} from "./factory-github-proof.js";
import { requestCurrentGitHubOAuthRefresh } from "./github-oauth-lifecycle.js";
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
  const managed = (["agent", "system"] as const).some((scope) =>
    resolveConfiguredGitHubToolIdentity({ config: params.config, agentId: params.agentId, scope }),
  );
  if (!managed && params.config.gateway?.projects?.nativeGitHubSearch !== true) {
    return undefined;
  }
  const credential = params.factoryCredential;
  const assertCallerCurrent = () => {
    params.assertActive();
    credential?.assertCurrent();
  };
  const factory = process.env.FACTORY_AUTH_MODE === "github";
  if (factory && !credential) {
    throw new Error("Factory GitHub repository access requires current caller authority.");
  }
  const factoryProof =
    factory && credential
      ? factoryGitHubClientProof({
          client: params.client,
          claim: credential.claim,
          assertCurrent: () => {
            assertCallerCurrent();
            if (process.env.FACTORY_AUTH_MODE !== "github") {
              throw new Error("Factory project requester changed during preparation");
            }
          },
        })
      : undefined;
  const assertActive = factoryProof?.assertCurrent ?? assertCallerCurrent;
  const factoryEnv = factoryProof
    ? factoryGitHubActorEnvironment(factoryProof, params.sessionKey ?? "")
    : undefined;
  const identity = await prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId: params.agentId,
    env: factoryEnv ?? process.env,
    readNativeCredential: factoryProof
      ? (currentEnv, admission) => readFactoryGitHubToken(currentEnv, factoryProof, admission)
      : undefined,
    getCurrentConfig: params.context.getRuntimeConfig,
    assertActive,
    refresh: () => requestCurrentGitHubOAuthRefresh(params.agentId),
  });
  assertActive();
  return identity;
}

/** Project picker/clone have no session agent; use only an unambiguous configured owner. */
export async function prepareConfiguredProjectGitHubIdentity(params: {
  config: OpenClawConfig;
  getCurrentConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  readNativeCredential?: import("../agents/github-credential-reader.js").GitHubCredentialReader;
}) {
  const agentId = tryResolveAmbientOwnerAgentId(params.config) ?? "";
  if (
    !(["agent", "system"] as const).some((scope) =>
      resolveConfiguredGitHubToolIdentity({ config: params.config, agentId, scope }),
    )
  ) {
    return undefined;
  }
  return prepareGitHubReadIdentity({
    config: params.config,
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? params.config,
    agentId,
    readNativeCredential: params.readNativeCredential,
    getCurrentConfig: params.getCurrentConfig,
    assertActive: params.assertCurrent,
    refresh: () => requestCurrentGitHubOAuthRefresh(agentId),
  });
}
