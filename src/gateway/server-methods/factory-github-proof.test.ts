import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as nativeIdentity from "../../agents/github-read-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as profiles from "../../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
} from "../../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { factoryGitHubActorEnvironment } from "../factory-github-actor.js";
import { installFactoryExternalTransport } from "../factory-github-external.test-support.js";
import {
  factoryGitHubClientProof,
  issueFactoryGitHubProof,
  readFactoryGitHubToken,
  type FactoryGitHubProofClaim,
} from "../factory-github-proof.js";
import {
  factoryPublicationPreflightCredential,
  prepareCurrentGitHubPublicationIdentity,
} from "../github-publication-availability.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearRuntimeConfigSnapshot();
});

const claim = {
  purpose: "publication-execution" as const,
  binding: {
    kind: "publication" as const,
    agentId: "main",
    sessionKey: "agent:main:room",
    sessionId: "session-1",
    lifecycleRevision: "revision-1",
    executionKind: "worktree" as const,
    requestId: "request-1",
    ownerId: "gateway-1:run-1",
    requestDigest: "digest-1",
  },
};

function brokerClient(overrides: Partial<GatewayClient> = {}): GatewayClient {
  return {
    connId: "broker-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    internal: {
      isLocalClient: true,
      authenticatedOperator: true,
      operatorRoleActor: { kind: "system" },
    },
    ...overrides,
  };
}

async function rpc(
  proof: string,
  clientOverrides: Partial<GatewayClient> = {},
  requestOverrides: Partial<
    Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal">
  > = {},
) {
  const respond = vi.fn();
  await coreGatewayHandlers["factory.githubPublication.redeem"]?.({
    client: brokerClient(clientOverrides),
    context: createDirectChatContext({ isConnectionActive: () => true }),
    req: {
      type: "req",
      id: "proof-request",
      method: "factory.githubPublication.redeem",
      params: { proof },
    },
    isWebchatConnect: () => false,
    params: { proof },
    respond,
    hasCurrentClientAuthority: () => true,
    ...requestOverrides,
  });
  return respond;
}

const sessionBinding = {
  agentId: "main",
  sessionKey: "agent:main:room",
  sessionId: "session-2",
  lifecycleRevision: null,
  requestDigest: "a".repeat(64),
};
const forbidden = (response: Awaited<ReturnType<typeof rpc>>) =>
  expect(response).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN" }),
  );

it.each([
  [claim, 101, "person-1"],
  [
    {
      purpose: "session-dispatch-project",
      binding: { ...sessionBinding, kind: "session-dispatch" },
    },
    202,
    "person-2",
  ],
  [
    { purpose: "session-issue-read", binding: { ...sessionBinding, kind: "session" } },
    202,
    "person-2",
  ],
] satisfies [FactoryGitHubProofClaim, number, string][])(
  "redeems exact %s once through the registered private method",
  async (claim, actorId, profileId) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const issued = issueFactoryGitHubProof({ actorId, profileId, claim, assertCurrent: () => {} });
    expect(await rpc(issued.proof)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        purpose: claim.purpose,
        actorId,
        actorPrincipal: "github:microsoft.ghe.com:" + actorId,
        profileId,
        binding: claim.binding,
      }),
    );
    forbidden(await rpc(issued.proof));
  },
);

it("binds authenticated read-only item previews without granting publication authority", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const client = createOperatorClient({ profileId: "person-read", scopes: ["operator.read"] });
  client.authenticatedFactoryGitHubAccountId = 1358766;
  client.internal = { authenticatedOperator: true };
  let current = true;
  const read = {
    purpose: "session-item-read" as const,
    binding: {
      kind: "session" as const,
      agentId: "main",
      sessionKey: "agent:main:room",
      sessionId: "session-read",
      lifecycleRevision: "revision-read",
      requestDigest: "b".repeat(64),
    },
  };
  const proofInput = factoryGitHubClientProof({
    client,
    claim: read,
    assertCurrent: () => {
      if (!current) {
        throw new Error("Original item access revoked");
      }
    },
  });
  expect(
    factoryGitHubActorEnvironment(proofInput, "agent:main:room", {
      GH_TOKEN: "ambient",
      GITHUB_TOKEN: "ambient",
      GH_ENTERPRISE_TOKEN: "ambient",
      GITHUB_ENTERPRISE_TOKEN: "ambient",
      OPENCLAW_FACTORY_GITHUB_PROOF: "stale-proof",
      OPENCLAW_FACTORY_ACTOR_ID: "another-actor",
      OPENCLAW_FACTORY_SESSION_KEY: "another-session",
      PATH: "/synthetic/bin",
    }),
  ).toEqual({
    OPENCLAW_FACTORY_ACTOR_ID: "1358766",
    OPENCLAW_FACTORY_SESSION_KEY: "agent:main:room",
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    OPENCLAW_FACTORY_GITHUB_PROOF: undefined,
    PATH: "/synthetic/bin",
  });
  expect(() => factoryGitHubActorEnvironment(proofInput, "")).toThrow();
  const issued = issueFactoryGitHubProof(proofInput);
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      purpose: "session-item-read",
      actorId: 1358766,
      profileId: "person-read",
      binding: read.binding,
    }),
  );
  forbidden(await rpc(issued.proof));
  expect(() => factoryGitHubClientProof({ client, claim, assertCurrent: () => {} })).toThrow();
  const revoked = issueFactoryGitHubProof(proofInput);
  current = false;
  expect(() => factoryGitHubActorEnvironment(proofInput, "agent:main:room")).toThrow(
    "Original item access revoked",
  );
  forbidden(await rpc(revoked.proof));
  current = true;
  client.internal.syntheticClient = true;
  expect(() =>
    factoryGitHubClientProof({ client, claim: read, assertCurrent: () => {} }),
  ).toThrow();
});

it.each([
  ["proxied loopback", { internal: { authenticatedOperator: true } }, {}],
  ["invalidated client", { invalidated: true }, {}],
  ["revoked authority", {}, { hasCurrentClientAuthority: () => false }],
] satisfies [
  string,
  Partial<GatewayClient>,
  Partial<Pick<GatewayRequestHandlerOptions, "hasCurrentClientAuthority" | "signal">>,
][])("rejects a %s caller without consuming its proof", async (_label, client, request) => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  const issued = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {},
  });
  forbidden(await rpc(issued.proof, client, request));
  expect(await rpc(issued.proof)).toHaveBeenCalledWith(true, expect.any(Object));
});

it("consumes stale or expired proof without returning actor authority", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  let current = true;
  const stale = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {
      if (!current) {
        throw new Error("role or session changed");
      }
    },
  });
  current = false;
  forbidden(await rpc(stale.proof));
  current = true;
  forbidden(await rpc(stale.proof));
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const expired = issueFactoryGitHubProof({
    actorId: 101,
    profileId: "person-1",
    claim,
    assertCurrent: () => {},
  });
  clock.mockReturnValue(now + 60_000);
  forbidden(await rpc(expired.proof));
});

it.each(["actor", "profile", "scopes", "invalidation", "connection"] as const)(
  "rejects a captured client's %s change at proof redemption",
  async (change) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const connection = new AbortController();
    const client = brokerClient({
      connectionSignal: connection.signal,
      authenticatedFactoryGitHubAccountId: 101,
      authenticatedUserProfile: {
        profileId: "person-1",
        displayName: null,
        hasAvatar: false,
        updatedAt: 0,
      },
    });
    const input = factoryGitHubClientProof({
      client,
      claim: {
        purpose: "project-add",
        binding: { kind: "connection", connectionId: "connection-1", requestDigest: "digest-1" },
      },
      assertCurrent: () => {},
    });
    const issued = issueFactoryGitHubProof(input);
    switch (change) {
      case "actor":
        client.authenticatedFactoryGitHubAccountId = 202;
        break;
      case "profile":
        client.authenticatedUserProfile = {
          profileId: "person-2",
          displayName: null,
          hasAvatar: false,
          updatedAt: 0,
        };
        break;
      case "scopes":
        client.connect.scopes = ["operator.read"];
        break;
      case "invalidation":
        client.invalidated = true;
        break;
      case "connection":
        connection.abort();
        break;
    }
    forbidden(await rpc(issued.proof));
  },
);

describe("native broker lookup", () => {
  let state: OpenClawTestState;
  let profileId: string;
  beforeAll(async () => {
    state = await createOpenClawTestState({
      label: "factory-proof",
      layout: "state-only",
      applyEnv: false,
    });
    profileId = (
      await ensureCanonicalUserProfileForEmail("github:microsoft.ghe.com:101", {
        env: state.env,
      })
    ).id;
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", state.configPath);
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
      },
    });
  });
  afterAll(async () => {
    await state?.cleanup();
  });

  it.each(["current", "missing", "ambiguous", "revoked"] as const)(
    "runs native publication preflight and releases canonical profile after %s",
    async (change) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      vi.stubEnv("GH_TOKEN", "ambient-token");
      const profile =
        change === "current"
          ? { id: profileId }
          : await ensureCanonicalUserProfileForEmail("preflight-" + change + "@example.test");
      if (change === "revoked" || change === "ambiguous")
        await linkCanonicalUserProfileEmail("github:microsoft.ghe.com:401", profile.id);
      if (change === "ambiguous")
        await linkCanonicalUserProfileEmail("github:microsoft.ghe.com:402", profile.id);
      const replacement =
        change === "revoked"
          ? await ensureCanonicalUserProfileForEmail("replacement@example.test")
          : undefined;
      const original = profiles.prepareUserProfileIdentity;
      const releases: MockInstance<() => void>[] = [];
      vi.spyOn(profiles, "prepareUserProfileIdentity").mockImplementation(async (...args) => {
        const prepared = await original(...args);
        releases.push(vi.spyOn(prepared, "release"));
        return prepared;
      });
      const external = installFactoryExternalTransport({
        binding: () => ({
          actorId: change === "current" ? 101 : 401,
          profileId: profile.id,
          repositoryUrl: "https://microsoft.ghe.com/acme/project.git",
          context: createDirectChatContext({ isConnectionActive: () => true }),
        }),
        executionAccountId: 731,
        assertVerdict: (verdict) =>
          expect(verdict).toMatchObject({
            purpose: "publication-preflight",
            binding: {
              kind: "session",
              agentId: "main",
              sessionKey: "agent:main:own",
              sessionId: "session-1",
              lifecycleRevision: "revision-1",
            },
          }),
        afterLookup: async () => {
          if (replacement)
            await linkCanonicalUserProfileEmail("github:microsoft.ghe.com:401", replacement.id);
        },
      });
      const credential = factoryPublicationPreflightCredential({
        agentId: "main",
        sessionKey: "agent:main:own",
        sessionId: "session-1",
        lifecycleRevision: "revision-1",
        assertCurrent: () => {},
      });
      const prepare = () =>
        prepareCurrentGitHubPublicationIdentity(
          "main",
          { profileId: profile.id, sessionKey: "agent:main:own" },
          credential,
        );
      if (change === "current") {
        const first = await prepare();
        const second = await prepare();
        expect(first.account.accountId).toBe(731);
        expect(first.env.OPENCLAW_FACTORY_GITHUB_PROOF).toBeUndefined();
        expect(second.env.OPENCLAW_FACTORY_GITHUB_PROOF).toBeUndefined();
        expect(external.proofs.size).toBe(2);
        expect(external.verdicts).toHaveLength(2);
      } else {
        await expect(prepare()).rejects.toThrow(
          change === "revoked"
            ? /binding|profile|changed/i
            : "actor binding is unavailable or ambiguous",
        );
        expect(external.native).toHaveBeenCalledTimes(change === "revoked" ? 1 : 0);
      }
      expect(releases).toHaveLength(change === "current" ? 2 : 1);
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
    },
  );

  it("rejects a native token returned without broker redemption", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockResolvedValue("ambient-token");
    await expect(
      readFactoryGitHubToken(
        { GH_TOKEN: "ambient-token" },
        { actorId: 101, profileId, claim, assertCurrent: () => {} },
      ),
    ).rejects.toThrow("did not authorize");
  });

  it("does not mistake expiry pruning for broker redemption", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async () => {
      clock.mockReturnValue(now + 60_000);
      issueFactoryGitHubProof({
        actorId: 101,
        profileId,
        claim,
        assertCurrent: () => {},
      }).release();
      return "unbrokered-token";
    });
    await expect(
      readFactoryGitHubToken({}, { actorId: 101, profileId, claim, assertCurrent: () => {} }),
    ).rejects.toThrow("did not authorize");
  });

  it("drops a redeemed token if the original authority closes before lookup settles", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    let current = true;
    vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async (env) => {
      await rpc(env.OPENCLAW_FACTORY_GITHUB_PROOF ?? "");
      current = false;
      return "broker-token";
    });
    await expect(
      readFactoryGitHubToken(
        {},
        {
          actorId: 101,
          profileId,
          claim,
          assertCurrent: () => {
            if (!current) {
              throw new Error("publication authority closed");
            }
          },
        },
      ),
    ).rejects.toThrow("publication authority closed");
  });
});
