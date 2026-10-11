import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ensureCanonicalFactoryGitHubProfile } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { installFactoryExternalTransport } from "../factory-github-external.test-support.js";
import { factoryGitHubRequestDigest } from "../factory-github-proof.js";
import type { readBoundGitHubPullRequest } from "../github-pull-request-read.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { prepareGatewayOperatorIngressMetadata } from "../server/ws-connection/connect-device-metadata.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearRuntimeConfigSnapshot();
});
const sessionKey = "agent:main:repository-read-workflow";
const sessionId = "repository-read-session";
const lifecycleRevision = "repository-read-lifecycle";
const repositoryUrl = "https://microsoft.ghe.com/bic/lobster.git";
const pullPath = "/repos/bic/lobster/pulls/15913";
let credentialSequence = 0;
type PullResult = Awaited<ReturnType<typeof readBoundGitHubPullRequest>>;

async function withReader(
  run: (flow: {
    client: ReturnType<typeof createOperatorClient>;
    close: () => void;
    external: ReturnType<typeof installFactoryExternalTransport>;
    read: (extra?: Record<string, unknown>) => Promise<PullResult>;
    patch: (patch: Record<string, unknown>) => Promise<void>;
  }) => Promise<void>,
  foreignHost = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const config = {
      gateway: {
        github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
        projects: { nativeGitHubSearch: true },
      },
    };
    setRuntimeConfigSnapshot(config);
    const profile = await ensureCanonicalFactoryGitHubProfile(
      "github:microsoft.ghe.com:101",
      "Repository reader",
    );
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.read"] });
    client.authenticatedFactoryGitHubAccountId = 101;
    client.internal = prepareGatewayOperatorIngressMetadata({
      role: "operator",
      authMethod: "token",
      clientId: client.connect.client.id,
      scopes: client.connect.scopes ?? [],
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: "main",
      sessionKey,
      url: foreignHost ? repositoryUrl.replace("microsoft.ghe.com", "github.com") : repositoryUrl,
      assertCurrent: () => {},
    });
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId,
      updatedAt: 1,
      lifecycleRevision,
      repositoryWorkspaceId: repository.workspaceId,
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    const original = expectDefined(
      await captureGatewayOperatorRunAuthority({ client, context }),
      "original source",
    );
    const admission = prepareSystemAgentRunAdmission(
      config,
      "repository-read-run",
      "main",
      "repository-read-test",
      undefined,
      original.authority,
    );
    try {
      const admitted = await admission.admit("embedded");
      original.release();
      bindGatewayContextResolver(admitted, () => context);
      const caller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey,
        }),
        "admitted caller",
      );
      const external = installFactoryExternalTransport({
        token: "synthetic-pr-token-" + ++credentialSequence,
        binding: () => ({ actorId: 101, profileId: profile.id, repositoryUrl, context }),
        executionAccountId: 731,
        assertVerdict: (claim) =>
          expect(claim).toMatchObject({
            purpose: "session-item-read",
            actorId: 101,
            profileId: profile.id,
            binding: {
              kind: "session",
              agentId: "main",
              sessionKey,
              sessionId,
              lifecycleRevision,
              requestDigest: factoryGitHubRequestDigest(repositoryUrl),
            },
          }),
      });
      external.responses.set(pullPath, {
        html_url: "https://microsoft.ghe.com/bic/lobster/pull/15913",
        title: "Admitted Factory PR",
        body: "b".repeat(30_000),
        state: "open",
        draft: false,
        user: { login: "contributor" },
        changed_files: 21,
        base: {
          label: "bic:main",
          ref: "main",
          sha: "base-sha",
          repo: { full_name: "bic/lobster" },
        },
        head: {
          label: "bic:feature",
          ref: "feature",
          sha: "head-sha",
          repo: { full_name: "bic/lobster" },
        },
      });
      external.responses.set(
        pullPath + "/files",
        Array.from({ length: 20 }, (_, index) => ({
          filename: "src/file-" + index + ".ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "p".repeat(5_000),
        })),
      );
      external.responses.set(
        pullPath + "/reviews",
        Array.from({ length: 21 }, (_, index) => ({
          user: { login: "reviewer-" + index },
          state: "APPROVED",
          submitted_at: "2026-09-24T00:00:00Z",
          body: "r".repeat(3_000),
        })),
      );
      await run({
        client,
        close: () => admission.close(),
        external,
        read: (extra) =>
          withGatewayToolCallerIdentity(caller, () =>
            callInProcessGatewayTool<PullResult>("sessions.github.pullRequest.read", {
              sessionKey,
              agentId: "main",
              pullRequest: 15913,
              ...extra,
            }),
          ),
        patch: async (patch) => {
          await replaceSessionEntry(scope, { ...loadSessionEntry(scope)!, ...patch });
          expect(loadSessionEntry(scope)).toMatchObject(patch);
        },
      });
    } finally {
      original.release();
      admission.close();
    }
  });
}

it.each([false, true])(
  "reads bounded Factory PR data via original admitted actor; deleted fork: %s",
  async (deletedFork) => {
    await withReader(async (flow) => {
      if (deletedFork) {
        const pull = flow.external.responses.get(pullPath) as { head: { repo: unknown } };
        pull.head.repo = null;
      }
      const result = await flow.read();
      expect(result).toMatchObject({
        content_trust: "untrusted_external_content",
        repository: "bic/lobster",
        number: 15913,
        url: "https://microsoft.ghe.com/bic/lobster/pull/15913",
        title: "Admitted Factory PR",
        author: "contributor",
        state: "open",
        body_truncated: true,
        base: { repository: "bic/lobster", ref: "main", sha: "base-sha" },
        head: { ref: "feature", sha: "head-sha" },
        files_total: 21,
        files_truncated: true,
        reviews_truncated: true,
        issue_comments: {
          available: false,
          reason: expect.stringContaining("pull-request reads only"),
        },
      });
      expect(result.head.repository).toBe(deletedFork ? undefined : "bic/lobster");
      expect(result.body).toHaveLength(24 * 1024);
      expect(result.files).toHaveLength(20);
      expect(result.files[0]).toMatchObject({
        path: "src/file-0.ts",
        patch: "p".repeat(4 * 1024),
        patch_truncated: true,
        additions: 2,
        deletions: 1,
      });
      expect(result.reviews).toHaveLength(20);
      expect(result.reviews[0]).toMatchObject({
        author: "reviewer-0",
        body: "r".repeat(2 * 1024),
        body_truncated: true,
      });
      expect(
        flow.external.fetchFixture.mock.calls
          .map(([url]) => String(url))
          .filter((url) => url.includes("/pulls/")),
      ).toEqual([
        "https://api.microsoft.ghe.com" + pullPath,
        "https://api.microsoft.ghe.com" + pullPath + "/files?per_page=20",
        "https://api.microsoft.ghe.com" + pullPath + "/reviews?per_page=21",
      ]);
      expect(flow.external.verdicts.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain("synthetic-pr-token-");
      const lookups = flow.external.native.mock.calls.length;
      flow.close();
      await expect(flow.read()).rejects.toThrow(/no longer active/i);
      expect(flow.external.native.mock.calls.length).toBe(lookups);
    });
  },
);

it("rejects model-selected bindings and foreign workspace hosts before credential preparation", async () => {
  await withReader(async (flow) => {
    for (const extra of [
      { agentId: "research" },
      { sessionKey: "agent:main:another-session" },
      { repository: "other/repository" },
      { host: "github.com" },
      { token: "model-supplied-token" },
    ]) {
      await expect(flow.read(extra)).rejects.toThrow();
      expect(flow.external.native.mock.calls.length).toBe(0);
      expect(flow.external.fetchFixture).not.toHaveBeenCalled();
    }
  });
  await withReader(async (flow) => {
    const refusal = await flow.read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(flow.external.native.mock.calls.length).toBe(0);
    expect(flow.external.fetchFixture).not.toHaveBeenCalled();
    expect(refusal).toMatchObject({ message: expect.stringMatching(/configured GitHub host/) });
  }, true);
});

it.each([
  "unavailable",
  "expired",
  "actor",
  "caller",
  "session",
  "lifecycle",
  "workspace",
  "cancel",
  "mode",
  "credential",
] as const)("refuses late preparation or delivery changes: %s", async (fault) => {
  await withReader(async (flow) => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const fetchBytes = flow.external.fetchFixture.getMockImplementation()!;
    const stage = fault === "cancel" ? pullPath : "/user";
    flow.external.fetchFixture.mockImplementation(async (...args) => {
      const response = await fetchBytes(...args);
      if (new URL(String(args[0])).pathname !== stage) return response;
      entered.resolve();
      await resume.promise;
      return fault === "expired" ? new Response("expired", { status: 401 }) : response;
    });
    if (fault === "unavailable") {
      // A real native lookup failure, not two differently named copies of one mock rejection.
      flow.external.native.mockResolvedValue({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      });
      await expect(flow.read()).rejects.toThrow(/GitHub|credential/);
      expect(flow.external.native).toHaveBeenCalled();
      expect(flow.external.fetchFixture).not.toHaveBeenCalled();
      return;
    }
    const pending = flow.read();
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await Promise.race([
      entered.promise,
      outcome.then(() => {
        throw new Error("read settled before its external gate");
      }),
    ]);
    try {
      if (fault === "actor") flow.client.authenticatedFactoryGitHubAccountId = 202;
      if (fault === "caller") flow.client.invalidated = true;
      if (fault === "mode") vi.stubEnv("FACTORY_AUTH_MODE", "");
      if (fault === "credential") {
        const nativeBytes = flow.external.native.getMockImplementation()!;
        flow.external.native.mockImplementation(async (...args) => ({
          ...(await nativeBytes(...args)),
          stdout: Buffer.from("synthetic-rotated-token"),
        }));
      }
      if (fault === "session") await flow.patch({ sessionId: "replacement-session" });
      if (fault === "lifecycle") await flow.patch({ lifecycleRevision: "replacement-lifecycle" });
      if (fault === "workspace") {
        const foreign = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: "agent:main:foreign",
          url: repositoryUrl,
          assertCurrent: () => {},
        });
        await flow.patch({ repositoryWorkspaceId: foreign.workspaceId });
      }
      if (fault === "cancel") flow.close();
    } finally {
      resume.resolve();
      await outcome;
    }
    expect(await outcome).toHaveProperty("error");
    const pulls = flow.external.fetchFixture.mock.calls.filter(([url]) =>
      String(url).includes("/pulls/"),
    );
    expect(pulls).toHaveLength(fault === "cancel" ? 3 : 0);
    expect(flow.external.verdicts.length).toBeGreaterThan(0);
  });
});
