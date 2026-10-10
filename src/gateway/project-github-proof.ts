import type { GitHubCredentialReader } from "../agents/github-credential-reader.js";
import { factoryGitHubActorEnvironment } from "./factory-github-actor.js";
import {
  factoryGitHubClientProof,
  factoryGitHubRequestDigest,
  readFactoryGitHubToken,
} from "./factory-github-proof.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

export function prepareFactoryProjectCredential(
  options: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "signal" | "hasCurrentClientAuthority"
  > & { assertCurrent: () => void },
  purpose: "project-add" | "project-search",
  request: string,
) {
  if (process.env.FACTORY_AUTH_MODE !== "github") {
    return undefined;
  }
  const { client, context, signal, hasCurrentClientAuthority } = options;
  const connectionId = client?.connId;
  if (!connectionId) {
    throw new Error("Factory GitHub connection is unavailable.");
  }
  const proof = factoryGitHubClientProof({
    client,
    claim: {
      purpose,
      binding: {
        kind: "connection",
        connectionId,
        requestDigest: factoryGitHubRequestDigest(request),
      },
    },
    assertCurrent: () => {
      options.assertCurrent();
      signal?.throwIfAborted();
      if (
        process.env.FACTORY_AUTH_MODE !== "github" ||
        client?.connId !== connectionId ||
        hasCurrentClientAuthority?.() === false ||
        context.isConnectionActive?.(connectionId) === false ||
        context.getClientConnIds?.((current) => current === client).has(connectionId) === false
      ) {
        throw new Error("Factory GitHub connection authority changed.");
      }
    },
  });
  const env = factoryGitHubActorEnvironment(proof, connectionId);
  const readNativeCredential: GitHubCredentialReader = (_env, admission) =>
    readFactoryGitHubToken(env, proof, admission);
  return { assertCurrent: proof.assertCurrent, readNativeCredential };
}
