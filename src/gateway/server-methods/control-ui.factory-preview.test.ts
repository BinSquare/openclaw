import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as oauth from "../../agents/github-oauth-client.js";
import * as nativeIdentity from "../../agents/github-read-identity.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import * as configRuntime from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { linkCanonicalUserProfileEmail } from "../../state/user-profile-writes.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "../control-ui-session-pr-access.test-support.js";
import {
  prepareControlUiSessionPrRead,
  prepareControlUiSessionGitHubIdentity,
} from "../control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "../control-ui-session-pr-subscriptions.js";
import {
  FACTORY_GITHUB_PROOF_ENV,
  factoryGitHubRequestDigest,
  redeemFactoryGitHubProof,
} from "../factory-github-proof.js";
import * as oauthLifecycle from "../github-oauth-lifecycle.js";
import { gitHubPublicApi } from "../github-public-api.js";
import {
  factoryPublicationPreflightCredential,
  prepareCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationOptionsIdentity,
} from "../github-publication-availability.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { exerciseReclaimedFactoryCredential } from "../operator-run-authority.factory.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayOperatorIngressMetadata } from "../server/ws-connection/connect-device-metadata.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { REQUEST } from "../worker-environments/placement-dispatch-test-fixtures.js";
import { createControlUiHandlers } from "./control-ui.js";
import {
  initializeSessionReadContext,
  disposeSessionReadContexts,
} from "./sessions-read-cache.test-support.js";

const host = "microsoft.ghe.com";
let sharedState: OpenClawTestState | undefined;
afterAll(async () => {
  await sharedState?.cleanup();
});

async function withFixture(
  scope: Parameters<typeof createFixture>[0],
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  useDefaultLoader = false,
) {
  sharedState ??= await createOpenClawTestState({ scenario: "minimal" });
  sharedState.applyEnv();
  const fixture = await createFixture(scope, useDefaultLoader);
  try {
    fixture.cfg.gateway = {
      ...fixture.cfg.gateway,
      github: { host, apiBaseUrl: `https://api.${host}` },
      projects: { nativeGitHubSearch: true },
    };
    setRuntimeConfigSnapshot(fixture.cfg);
    await linkCanonicalUserProfileEmail(`github:${host}:101`, fixture.profile.id);
    await run(fixture);
  } finally {
    await fixture.close();
    await fixture.removeSessions();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetTestPluginRegistry();
});

describe("registered Factory session GitHub preview", () => {
  it.each([
    "foreign-repository",
    "foreign-host",
    "missing-identity",
    "actor-changed",
    "host-changed",
    "unredeemed-proof",
    "missing-credential",
    "grant",
    "cancelled",
    "visibility",
    "reselected",
  ] as const)("does not deliver or borrow another identity after %s", async (change) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await withFixture("operator.read", async (f) => {
      // The admitted WebSocket fixture retains the actual registered client and current access grant.
      f.client.internal = {
        ...f.client.internal,
        ...prepareGatewayOperatorIngressMetadata({
          role: "operator",
          authMethod: "token",
          clientId: f.client.connect.client.id,
          scopes: f.client.connect.scopes ?? [],
        }),
      };
      if (change !== "missing-identity") {
        f.client.authenticatedFactoryGitHubAccountId = 101;
      }
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: `https://${host}/bic/lobster.git`,
        branch: "preview-fixture",
        assertCurrent: () => {},
      });
      await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      const lookup = vi
        .spyOn(nativeIdentity, "readNativeGitHubToken")
        .mockImplementation(async (env) => {
          if (change !== "unredeemed-proof") {
            redeemFactoryGitHubProof(env?.[FACTORY_GITHUB_PROOF_ENV] ?? "");
          }
          return change === "missing-credential" ? undefined : "synthetic-reader-token";
        });
      vi.spyOn(oauth, "verifyGitHubCredential").mockImplementation(async () => {
        if (change === "actor-changed") {
          f.client.authenticatedFactoryGitHubAccountId = 202;
        }
        if (change === "host-changed") {
          setRuntimeConfigSnapshot({
            ...f.cfg,
            gateway: { ...f.cfg.gateway, github: { host: "github.com" } },
          });
        }
        return {
          status: "available",
          scopes: [],
          account: { accountId: 101, login: "reader", avatarUrl: null },
        };
      });
      const load = vi.fn<NonNullable<Parameters<typeof createControlUiHandlers>[0]>>(
        async (_target, identity) => {
          expect(identity?.token).toBe("synthetic-reader-token");
          if (change === "grant" || change === "visibility") {
            await f.changeReader(change);
          }
          if (change === "cancelled") {
            await f.changeReader("connection");
          }
          if (change === "reselected") {
            await f.seed(sessionKey, f.profile.id, {
              repositoryWorkspaceId: repository.workspaceId,
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
            });
          }
          return { title: "Do not deliver this late private item", number: 17420 };
        },
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "factory-preview-denied",
          method: "controlUi.githubPreview",
          params: {
            sessionKey,
            agentId: "main",
            kind: "pull",
            owner: "bic",
            repo: change === "foreign-repository" ? "other" : "lobster",
            ...(change === "foreign-host" ? { githubHost: "github.com" } : {}),
            number: 17420,
          },
        },
        client: f.client,
        context: f.context,
        extraHandlers: createControlUiHandlers(load),
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
      if (["foreign-repository", "foreign-host", "missing-identity"].includes(change)) {
        expect(lookup).not.toHaveBeenCalled();
      }
      if (
        [
          "foreign-repository",
          "foreign-host",
          "missing-identity",
          "actor-changed",
          "host-changed",
          "unredeemed-proof",
          "missing-credential",
        ].includes(change)
      ) {
        expect(load).not.toHaveBeenCalled();
      }
    });
  });
});

it("keeps one admitted Factory issuer through preflight, registered reads, reclaim and retirement", async () => {
  await exerciseReclaimedFactoryCredential("current", async (flow) => {
    const { context, config, profileId, external, assertCurrent } = flow;
    config.gateway = { ...config.gateway, projects: { nativeGitHubSearch: true } };
    const reader = createOperatorWsClient({
      connId: "factory-workflow-reader",
      scopes: ["operator.read"],
    });
    reader.authenticatedUserProfile = {
      ...expectDefined(flow.client.authenticatedUserProfile, "original profile"),
      avatarRevision: "fixture",
    };
    reader.authenticatedUserId = flow.client.authenticatedUserId;
    reader.authenticatedFactoryGitHubAccountId = 101;
    const access = new AbortController();
    reader.internal = {
      ...prepareGatewayOperatorIngressMetadata({
        role: "operator",
        authMethod: "token",
        clientId: reader.connect.client.id,
        scopes: ["operator.read"],
      }),
      operatorAccessAuthority: {
        signal: access.signal,
        assertCurrent: () => access.signal.throwIfAborted(),
      },
    };
    context.getClientConnIds = (filter) =>
      new Set(
        [flow.client, reader]
          .filter((client) => !filter || filter(client))
          .flatMap((client) => (client.connId ? [client.connId] : [])),
      );
    context.isConnectionActive = () => !reader.invalidated;
    await initializeSessionReadContext(context);
    const root = "/repos/acme/project";
    const base = "https://api.microsoft.ghe.com" + root;
    const item = {
      number: 17420,
      title: "Synthetic private item",
      state: "closed",
      html_url: "https://microsoft.ghe.com/acme/project/pull/17420",
      repository_url: base,
      created_at: "2026-10-03T00:00:00Z",
      updated_at: "2026-10-03T00:00:00Z",
      user: { login: "reader" },
      comments: 0,
      head: { sha: "a".repeat(40) },
      base: {
        ref: "main",
        repo: { name: "project", owner: { login: "acme" }, full_name: "acme/project", url: base },
      },
    };
    external.responses.set(root, {
      full_name: "acme/project",
      private: true,
      node_id: "R_reclaimed_fixture",
      clone_url: flow.repository.url,
      default_branch: "main",
    });
    external.responses.set(root + "/pulls", [
      { ...item, state: "open", draft: false, merged_at: null },
    ]);
    external.responses.set(root + "/pulls/17420", {
      ...item,
      additions: 0,
      deletions: 0,
      changed_files: 0,
    });
    external.responses.set(root + "/pulls/17420/commits", []);
    external.responses.set(root + "/issues/17436", { ...item, number: 17436 });
    external.responses.set(root + "/commits/" + "a".repeat(40) + "/check-runs", {
      total_count: 0,
      check_runs: [],
    });
    const credential = factoryPublicationPreflightCredential({
      ...REQUEST,
      lifecycleRevision: "setup-issuer-lifecycle",
      assertCurrent,
    });
    for (let index = 0; index < 2; index++) {
      const prepared = await prepareCurrentGitHubPublicationIdentity(
        "main",
        { profileId, sessionKey: REQUEST.sessionKey, assertCurrent },
        credential,
      );
      expect(prepared.account.accountId).toBe(731);
      expect(prepared.env.OPENCLAW_FACTORY_GITHUB_PROOF).toBeUndefined();
      expect(external.verdicts[index]).toMatchObject({
        purpose: "publication-preflight",
        actorId: 101,
        binding: credential.claim.binding,
      });
    }
    expect(external.proofs.size).toBe(2);
    const handlers = createControlUiHandlers((target, identity) =>
      gitHubPublicApi.loadControlUiGitHubPreview(target, identity, external.fetchFixture),
    );
    const { default: github } = await loadBundledPluginFacade<{
      default: OpenClawPluginDefinition;
    }>({ pluginId: "github", artifactBasename: "index.ts" });
    const registered = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      ...registered,
      id: "github",
      name: "GitHub",
      contracts: { gatewayMethodDispatch: ["authenticated-request"] },
      register: expectDefined(github.register, "GitHub registration"),
    });
    setTestPluginRegistry(registered.registry.registry);
    const methods = createGatewayMethodRegistry(
      [
        ...registered.registry.registry.gatewayMethodDescriptors,
        ...Object.entries(handlers).map(([name, handler]) => ({
          name,
          owner: { kind: "core" as const, area: "control-ui" },
          scope: "operator.read" as const,
          profileAccess: "independent" as const,
          handler,
        })),
      ],
      registered.registry.registry,
    );
    context.getGatewayMethodRegistry = () => methods;
    const harness = createDispatchTestHarness({ buildRequestContext: () => context });
    harness.clients.add(reader);
    let sequence = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const id = "factory-workflow-" + ++sequence;
      await harness.dispatcher.dispatch({ type: "req", id, method, params }, reader);
      return await harness.awaitResponseFrame(id);
    };
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const broadcast = vi.fn();
    const prepareRead = () =>
      prepareControlUiSessionPrRead({
        client: reader,
        ...REQUEST,
        getRuntimeConfig: () => config,
        getSessionRowProjection: () => getSessionRowProjection(context),
        isCurrentClient: () => !reader.invalidated,
      });
    const subscriptions = createControlUiSessionPullRequestSubscriptions({
      scheduler,
      broadcastToConnIds: broadcast,
      getSessionRowProjection: () => getSessionRowProjection(context),
      prepareRead,
      isConnectionActive: () => !reader.invalidated,
    });
    context.controlUiSessionPullRequests = subscriptions;
    try {
      for (const [kind, number] of [
        ["issue", 17436],
        ["pull", 17420],
      ] as const) {
        const url =
          "https://microsoft.ghe.com/acme/project/" +
          (kind === "pull" ? "pull/" : "issues/") +
          number;
        const response = await request("github.preview", {
          sessionKey: REQUEST.sessionKey,
          agentId: "main",
          url,
        });
        expect(response).toMatchObject({ ok: true, payload: { title: item.title, url } });
        expect(external.verdicts.at(-1)).toMatchObject({
          purpose: "session-item-read",
          actorId: 101,
          profileId,
          binding: {
            sessionId: REQUEST.sessionId,
            lifecycleRevision: "setup-issuer-lifecycle",
            requestDigest: factoryGitHubRequestDigest(url),
          },
        });
      }
      const previousTools = config.tools;
      const botProfileId = "ghp_" + "1".repeat(32);
      config.tools = { ...config.tools, github: { profileId: botProfileId } };
      setRuntimeConfigSnapshot(config);
      const botDirectory = resolveManagedGitHubProfileDir({
        agentId: "main",
        scope: "system",
        profileId: botProfileId,
      });
      await fs.mkdir(botDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(botDirectory, "hosts.yml"),
        `${host}:\n  oauth_token: synthetic-reclaimed-token\n`,
        { mode: 0o600 },
      );
      vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
      const botNativeCalls = external.native.mock.calls.length;
      const botUrl = "https://microsoft.ghe.com/acme/project/pull/17421";
      external.responses.set(root + "/pulls/17421", { ...item, number: 17421, html_url: botUrl });
      external.responses.set(root + "/pulls/17421/commits", []);
      try {
        expect(
          await request("github.preview", {
            sessionKey: REQUEST.sessionKey,
            agentId: "main",
            url: botUrl,
          }),
        ).toMatchObject({ ok: true, payload: { title: item.title, url: botUrl } });
        expect(external.native).toHaveBeenCalledTimes(botNativeCalls);
      } finally {
        config.tools = previousTools;
        setRuntimeConfigSnapshot(config);
      }
      external.responses.set(root + "/pulls/17420", {
        ...item,
        state: "open",
        draft: false,
        merged_at: null,
        additions: 0,
        deletions: 0,
        changed_files: 0,
      });
      external.responses.set(root + "/commits/" + "a".repeat(40) + "/status", {
        sha: "a".repeat(40),
        total_count: 0,
        statuses: [],
      });
      const assertMetadataProofs = (start: number, operation: string) => {
        const proofs = external.verdicts.slice(start);
        expect(proofs.length, operation + " must acquire a fresh proof").toBeGreaterThan(0);
        for (const proof of proofs)
          expect(proof, operation + " proof").toEqual(
            expect.objectContaining({
              purpose: "session-item-read",
              actorId: 101,
              profileId,
              binding: {
                kind: "session",
                agentId: REQUEST.agentId,
                sessionKey: REQUEST.sessionKey,
                sessionId: REQUEST.sessionId,
                lifecycleRevision: "setup-issuer-lifecycle",
                requestDigest: factoryGitHubRequestDigest("https://microsoft.ghe.com/acme/project"),
              },
            }),
          );
      };
      const catalogProofStart = external.verdicts.length;
      expect(
        await request("controlUi.sessionPullRequests.subscribe", {
          sessionKeys: [REQUEST.sessionKey],
        }),
      ).toMatchObject({ ok: true });
      await subscriptions.pollNow();
      expect(broadcast).toHaveBeenCalledWith(
        "controlUi.sessionPullRequests.changed",
        expect.objectContaining({
          sessions: {
            [REQUEST.sessionKey]: expect.objectContaining({
              status: "ready",
              repository: { owner: "acme", repo: "project", host },
            }),
          },
        }),
        new Set([reader.connId]),
        expect.objectContaining({ agentId: "main", sessionKeys: [REQUEST.sessionKey] }),
      );
      assertMetadataProofs(catalogProofStart, "catalog");
      const checkParams = {
        sessionKey: REQUEST.sessionKey,
        owner: "acme",
        repo: "project",
        number: 17420,
        headSha: "a".repeat(40),
      };
      const checksProofStart = external.verdicts.length;
      expect(await request("controlUi.sessionPullRequests.checks", checkParams)).toMatchObject({
        ok: true,
        payload: { owner: "acme", repo: "project", number: 17420, status: "ready", checks: [] },
      });
      assertMetadataProofs(checksProofStart, "checks");
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain("synthetic-reclaimed-token");
      const calls = external.native.mock.calls.length;
      const fetchCalls = external.fetchFixture.mock.calls.length;
      expect(
        await request("controlUi.sessionPullRequests.checks", { ...checkParams, repo: "foreign" }),
      ).toMatchObject({ ok: false });
      expect(external.native).toHaveBeenCalledTimes(calls);
      expect(external.fetchFixture).toHaveBeenCalledTimes(fetchCalls);
      const read = expectDefined(await prepareRead(), "retained current reader");
      const target = expectDefined(await read(), "retained session target");
      const identity = expectDefined(
        await prepareControlUiSessionGitHubIdentity({
          target,
          assertCurrent: target.assertCurrent!,
        }),
        "real read identity",
      );
      const cacheTarget = { kind: "pull" as const, owner: "acme", repo: "project", number: 17420 };
      await gitHubPublicApi.loadControlUiGitHubPreview(
        cacheTarget,
        identity,
        external.fetchFixture,
      );
      const beforeCache = external.fetchFixture.mock.calls.length;
      await gitHubPublicApi.loadControlUiGitHubPreview(
        cacheTarget,
        identity,
        external.fetchFixture,
      );
      expect(external.fetchFixture).toHaveBeenCalledTimes(beforeCache);
      access.abort(new Error("reader retired"));
      const beforeRetirement = external.native.mock.calls.length;
      await expect(
        gitHubPublicApi.loadControlUiGitHubPreview(cacheTarget, identity, external.fetchFixture),
      ).rejects.toThrow();
      expect(external.native).toHaveBeenCalledTimes(beforeRetirement);
      assertCurrent();
    } finally {
      await subscriptions.stop();
      await scheduler.stop();
      harness.clients.clear();
      await disposeSessionReadContexts();
    }
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each(["publication", "options"] as const)(
  "uses the selected bot for Factory %s while retaining human authority",
  async (usage) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("selected-bot-publication-"));
    const profileId = "ghp_11111111111111111111111111111111";
    let config = { tools: { github: { profileId } } };
    vi.spyOn(configRuntime, "getRuntimeConfig").mockImplementation(() => config);
    vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
    const directory = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
    });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(directory, "hosts.yml"),
      "github.com:\n  oauth_token: synthetic-bot-token\n",
      { mode: 0o600 },
    );
    const native = vi
      .spyOn(nativeIdentity, "readNativeGitHubToken")
      .mockRejectedValue(new Error("must not borrow native credentials"));
    let current = true;
    const assertCurrent = () => {
      if (!current) throw new Error("human authority revoked");
    };
    const actor = { profileId: "human-profile", sessionKey: "agent:main:own", assertCurrent };
    const credential = factoryPublicationPreflightCredential({
      agentId: "main",
      sessionKey: actor.sessionKey,
      sessionId: "same-session",
      lifecycleRevision: "same-life",
      assertCurrent,
    });
    const verify = vi.spyOn(oauth, "verifyGitHubCredential").mockImplementation(async (token) => {
      expect(token).toBe("synthetic-bot-token");
      return {
        status: "available",
        scopes: [],
        account: { accountId: 202, login: "system-bot", avatarUrl: null },
      };
    });
    const prepare = () =>
      usage === "publication"
        ? prepareCurrentGitHubPublicationIdentity("main", actor, credential)
        : prepareCurrentGitHubPublicationOptionsIdentity("main", actor, credential);
    expect(await prepare()).toMatchObject({
      source: "system-configured",
      account: { accountId: 202, login: "system-bot" },
    });
    verify.mockImplementation(async () => {
      current = false;
      return {
        status: "available",
        scopes: [],
        account: { accountId: 202, login: "system-bot", avatarUrl: null },
      };
    });
    await expect(prepare()).rejects.toThrow("human authority revoked");
    current = true;
    verify.mockImplementation(async () => {
      config = { tools: { github: { profileId: "ghp_22222222222222222222222222222222" } } };
      return {
        status: "available",
        scopes: [],
        account: { accountId: 202, login: "system-bot", avatarUrl: null },
      };
    });
    await expect(prepare()).rejects.toThrow("GitHub publication identity changed");
    expect(native).not.toHaveBeenCalled();
  },
);
