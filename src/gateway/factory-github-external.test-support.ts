import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import * as command from "../process/exec.js";
import type { FactoryGitHubProofVerdict } from "./factory-github-proof.js";
import { factoryGitHubProofHandlers } from "./server-methods/factory-github-proof.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";

export type FactoryExternalBinding = {
  actorId: number;
  profileId: string;
  repositoryUrl: string;
  context: GatewayRequestContext;
};

/** Only external command/HTTP responses are simulated; issuance and redemption stay native. */
export function installFactoryExternalTransport(params: {
  binding: () => FactoryExternalBinding;
  assertVerdict: (verdict: FactoryGitHubProofVerdict) => void;
  afterLookup?: () => Promise<void>;
  token?: string;
  broker?: () => boolean;
  executionAccountId?: number;
  executionLogin?: string;
  nodeId?: string;
  allowAnonymousProbe?: boolean;
  repositorySnapshot?: () => { commit: string; tree: string } | undefined;
}) {
  const proofs = new Set<string>();
  const responses = new Map<string, unknown>();
  const verdicts: FactoryGitHubProofVerdict[] = [];
  const token = params.token ?? "synthetic-restored-factory-token";
  const result = (stdout = "", code = 0) => ({
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  });
  const original = command.runCommandBuffered;
  const native = vi
    .spyOn(command, "runCommandBuffered")
    .mockImplementation(async (argv, options) => {
      if (argv[0] === "git") return await original(argv, options);
      if (params.allowAnonymousProbe && argv[2] === "status") return result('{"hosts":{}}');
      expect(argv.slice(1)).toEqual(["auth", "token", "--hostname", "microsoft.ghe.com"]);
      const proof = options?.env?.OPENCLAW_FACTORY_GITHUB_PROOF;
      if (!proof && params.allowAnonymousProbe) return result("", 1);
      const issued = expectDefined(proof, "original-issuer proof");
      expect(proofs.has(issued)).toBe(false);
      proofs.add(issued);
      for (const key of [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
      ])
        expect(options?.env?.[key]).toBeUndefined();
      const binding = params.binding();
      const respond = vi.fn();
      const request: GatewayRequestHandlerOptions = {
        req: { type: "req", id: "factory-lookup", method: "factory.githubPublication.redeem" },
        params: { proof },
        respond,
        isWebchatConnect: () => false,
        client: {
          ...createOperatorClient({ profileId: binding.profileId, scopes: ["operator.admin"] }),
          internal: {
            isLocalClient: true,
            authenticatedOperator: true,
            operatorRoleActor: { kind: "system" },
          },
        },
        context: { ...binding.context, isConnectionActive: () => true },
        hasCurrentClientAuthority: () => true,
      };
      const redeem = expectDefined(
        factoryGitHubProofHandlers[request.req.method],
        "registered private proof handler",
      );
      await redeem(request);
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ actorId: binding.actorId, profileId: binding.profileId }),
      );
      const verdict = respond.mock.calls[0][1] as FactoryGitHubProofVerdict;
      params.assertVerdict(verdict);
      verdicts.push(verdict);
      const replay = vi.fn();
      await redeem({ ...request, respond: replay });
      expect(replay).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      await params.afterLookup?.();
      return params.broker?.() === false ? result("", 1) : result(token);
    });
  const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
    const binding = params.binding();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + token);
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("https://api.microsoft.ghe.com");
    const repositoryPath =
      "/repos" + new URL(binding.repositoryUrl).pathname.replace(/\.git$/u, "");
    const { commit, tree } = params.repositorySnapshot?.() ?? {
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    };
    const repository = {
      node_id: params.nodeId ?? "R_restored_factory",
      clone_url: binding.repositoryUrl,
      private: true,
      default_branch: "main",
    };
    let body: unknown = responses.get(url.pathname);
    if (body !== undefined) {
      // Test-supplied network bytes still pass through the real response/read owners.
    } else if (url.pathname === "/user") {
      body = {
        id: params.executionAccountId ?? binding.actorId,
        login: params.executionLogin ?? "fixture-system-account",
        type: "User",
      };
    } else if (url.pathname === "/graphql") {
      expect(typeof init?.body === "string" ? JSON.parse(init.body) : undefined).toMatchObject({
        variables: { repositoryId: repository.node_id, commit },
      });
      body = {
        data: {
          node: {
            ...repository,
            __typename: "Repository",
            object: { __typename: "Commit", sha: commit, tree: { sha: tree } },
          },
        },
      };
    } else if (url.pathname === repositoryPath) {
      body = repository;
    } else if (url.pathname === repositoryPath + "/git/commits/" + commit) {
      body = { sha: commit, tree: { sha: tree } };
    } else if (
      url.pathname === repositoryPath + "/commits/main" ||
      decodeURIComponent(url.pathname) === repositoryPath + "/commits/heads/main"
    ) {
      body = { sha: commit, commit: { tree: { sha: tree } } };
    } else if (url.pathname === repositoryPath + "/git/trees/" + tree) {
      body = { sha: tree, truncated: false, tree: [] };
    } else throw new Error("Repository read left the exact accepted target");
    return Response.json(body);
  });
  vi.stubGlobal("fetch", fetchFixture);
  return { proofs, verdicts, native, fetchFixture, responses };
}
