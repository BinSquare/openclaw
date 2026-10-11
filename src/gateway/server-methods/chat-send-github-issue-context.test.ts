import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  ensureCanonicalFactoryGitHubProfile,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import { attachSessionGitHubIssueContext } from "../chat-github-issue-context.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { installFactoryExternalTransport } from "../factory-github-external.test-support.js";
import { factoryGitHubRequestDigest } from "../factory-github-proof.js";
import * as sessionFacts from "../session-sharing-preparation.js";
import { rolePolicyConfig } from "../session-sharing.test-utils.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const issueUrl = "https://microsoft.ghe.com/example/project/issues/101";
const scenarios = [
  ["actor-a", issueUrl + ".", true],
  ["actor-b", issueUrl.replace("101", "00101") + ".", true],
  ["foreign-host", issueUrl.replace("microsoft.ghe.com", "github.com"), false],
  ["foreign-repository", issueUrl.replace("/project/", "/other/"), false],
  ["pull-url", issueUrl.replace("/issues/", "/pull/"), false],
  ["query-url", issueUrl + "?token=private-query", false],
  ["actor-switched", issueUrl, true],
  ["revoked", issueUrl, true],
  ["session-replaced", issueUrl, true],
  ["disabled", issueUrl, false],
] as const;

describe("registered Factory issue-context admission", () => {
  it.each(scenarios)(
    "keeps real parser, bounded content and original actor: %s",
    async (scenario, url, accepted) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
      const fixture = await createFixture({ active: false });
      const actorId = scenario === "actor-b" ? 202 : 101;
      const profile = await ensureCanonicalFactoryGitHubProfile(
        "github:microsoft.ghe.com:" + actorId,
        "Issue context actor " + actorId,
      );
      await setCanonicalUserProfileRole(profile.id, "write");
      fixture.client.authenticatedUserId = profile.id;
      fixture.client.authenticatedUserProfile = {
        profileId: profile.id,
        displayName: profile.displayName,
        hasAvatar: false,
        updatedAt: profile.updatedAt,
      };
      fixture.client.authenticatedFactoryGitHubAccountId = actorId;
      fixture.client.connect.scopes = ["operator.read", "operator.write"];
      prepareGatewayRecipientProfile(fixture.client);
      const policyConfig = rolePolicyConfig();
      const config = {
        ...policyConfig,
        gateway: {
          ...policyConfig.gateway,
          projects: { nativeGitHubSearch: scenario !== "disabled" },
          github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
        },
        session: { store: fixture.scope.storePath },
      };
      setRuntimeConfigSnapshot(config);
      fixture.context.getRuntimeConfig = () => config;
      fixture.params.message = "Read " + url;
      const repositoryUrl = "https://microsoft.ghe.com/example/project.git";
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: fixture.scope.agentId,
        sessionKey: fixture.scope.sessionKey,
        url: repositoryUrl,
        assertCurrent: () => {},
      });
      await patchSessionEntryCore(fixture.scope, (entry) => ({
        ...entry,
        repositoryWorkspaceId: repository.workspaceId,
      }));
      const original = loadSessionEntry(fixture.scope)!;
      const external = installFactoryExternalTransport({
        token: "synthetic-issue-token-" + scenario,
        binding: () => ({
          actorId,
          profileId: profile.id,
          repositoryUrl,
          context: fixture.context,
        }),
        assertVerdict: (claim) =>
          expect(claim).toMatchObject({
            purpose: "session-issue-read",
            actorId,
            profileId: profile.id,
            binding: {
              kind: "session",
              agentId: fixture.scope.agentId,
              sessionKey: fixture.scope.sessionKey,
              sessionId: fixture.scope.sessionId,
              lifecycleRevision: original.lifecycleRevision ?? null,
              requestDigest: factoryGitHubRequestDigest(issueUrl),
            },
          }),
      });
      external.responses.set("/repos/example/project/issues/101", {
        title: "Synthetic issue",
        body: "b".repeat(30_000),
        state: "open",
        user: { login: "owner" },
        comments: 9,
        created_at: "2026-09-24T00:00:00Z",
        updated_at: "2026-09-24T01:00:00Z",
      });
      external.responses.set(
        "/repos/example/project/issues/101/comments",
        Array.from({ length: 9 }, (_, index) => ({
          user: { login: "author-" + index },
          body: "c".repeat(3_000),
          created_at: "2026-09-24T02:00:00Z",
        })),
      );
      const fetchBytes = external.fetchFixture.getMockImplementation()!;
      let verified = false;
      external.fetchFixture.mockImplementation(async (...args) => {
        const response = await fetchBytes(...args);
        if (new URL(String(args[0])).pathname === "/user" && !verified) {
          verified = true;
          if (scenario === "actor-switched")
            fixture.client.authenticatedFactoryGitHubAccountId = 202;
          if (scenario === "revoked") fixture.client.invalidated = true;
          if (scenario === "session-replaced")
            await replaceSessionEntry(fixture.scope, {
              ...original,
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
            });
        }
        return response;
      });
      try {
        if (scenario === "disabled") {
          const prepareFacts = vi.spyOn(sessionFacts, "prepareSessionMutationFacts");
          const templateContext = {};
          await attachSessionGitHubIssueContext({
            ...fixture.scope,
            client: fixture.client,
            config,
            context: fixture.context,
            assertActive: () => {},
            message: fixture.params.message,
            repositoryWorkspaceId: repository.workspaceId,
            templateContext,
          });
          expect(prepareFacts).not.toHaveBeenCalled();
          expect(templateContext).toEqual({});
          prepareFacts.mockRestore();
        }
        const respond = await fixture.send(vi.fn(), { expectedProfileId: profile.id });
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls)).toBe(true);
        await fixture.finishDispatch();
        const invalidated = ["actor-switched", "revoked", "session-replaced"].includes(scenario);
        const issueCalls = external.fetchFixture.mock.calls
          .map(([input]) => String(input))
          .filter((input) => input.includes("/issues/"));
        if (accepted && !invalidated) {
          expect(issueCalls).toEqual([
            "https://api.microsoft.ghe.com/repos/example/project/issues/101",
            "https://api.microsoft.ghe.com/repos/example/project/issues/101/comments?per_page=8",
          ]);
          expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
          const delivered = dispatchInboundMessageMock.mock.calls[0]![0];
          const context = delivered.ctx.ChannelStructuredContext?.find(
            (entry) => entry.type === "github_issue",
          );
          expect(context?.label).toBe("GitHub issue context (untrusted external content)");
          expect(context?.payload).toMatchObject({
            url: issueUrl,
            repository: "example/project",
            number: 101,
            title: "Synthetic issue",
            author: "owner",
            state: "open",
            body: "b".repeat(24 * 1024),
            body_truncated: true,
            comments_total: 9,
            comments_truncated: true,
            created_at: "2026-09-24T00:00:00Z",
            updated_at: "2026-09-24T01:00:00Z",
            comments: Array.from({ length: 8 }, (_, index) => ({
              author: "author-" + index,
              body: "c".repeat(2 * 1024),
              body_truncated: true,
              created_at: "2026-09-24T02:00:00Z",
            })),
          });
          expect(external.verdicts.length).toBeGreaterThan(0);
          expect(JSON.stringify(delivered)).not.toContain("synthetic-issue-token-");
        } else {
          expect(issueCalls).toEqual([]);
          if (invalidated) {
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
            expect(verified).toBe(true);
          } else {
            expect(external.native.mock.calls.length).toBe(0);
            expect(external.fetchFixture).not.toHaveBeenCalled();
            expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
            expect(
              dispatchInboundMessageMock.mock.calls[0]![0].ctx.ChannelStructuredContext,
            ).toBeUndefined();
          }
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
