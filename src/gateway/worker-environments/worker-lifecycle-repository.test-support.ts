import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { installFactoryRestartRepositoryFixture } from "../../agents/main-session-recovery/main-session-recovery-factory-read.test-support.js";
import * as gitExec from "../../infra/git-exec.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type {
  WorkerLifecycle,
  WorkerLifecycleOptions,
} from "./worker-lifecycle.test-support.types.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

export async function createWorkerLifecycleRepository({
  state,
  issuer,
  options,
}: {
  state: OpenClawTestState;
  issuer: WorkerLifecycle["issuer"];
  options: WorkerLifecycleOptions;
}) {
  const authority = expectDefined(issuer.original, "authenticated original issuer").authority;
  const defaultBranch = options.defaultBranch ?? "main";
  const origin = state.path("git-origin");
  await fs.mkdir(origin);
  await fs.writeFile(path.join(origin, "accepted.txt"), "initial accepted bytes");
  if (options.setupScript) {
    await fs.mkdir(path.join(origin, ".openclaw"));
    await fs.writeFile(path.join(origin, ".openclaw/worktree-setup.sh"), options.setupScript, {
      mode: 0o755,
    });
  }
  await requireWorkspaceResultGit(origin, ["init", "--quiet", "--initial-branch=" + defaultBranch]);
  await requireWorkspaceResultGit(origin, ["add", "."]);
  await requireWorkspaceResultGit(origin, [
    "-c",
    "user.name=Lifecycle Fixture",
    "-c",
    "user.email=lifecycle@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "original",
  ]);
  const sourceSnapshots = new Map<string, { commit: string; tree: string }>();
  const recordSource = async (branch: string) =>
    sourceSnapshots.set(branch, {
      commit: await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD"]),
      tree: await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD^{tree}"]),
    });
  await recordSource(defaultBranch);
  const selectedBranch = options.branch ?? options.additionalBranch;
  if (selectedBranch) {
    await requireWorkspaceResultGit(origin, ["checkout", "--quiet", "-b", selectedBranch]);
    if (options.additionalBranch)
      await fs.writeFile(path.join(origin, "accepted.txt"), "selected branch bytes");
    await fs.writeFile(path.join(origin, "published.txt"), "original published branch\n");
    await requireWorkspaceResultGit(origin, ["add", "."]);
    await requireWorkspaceResultGit(origin, [
      "-c",
      "user.name=Lifecycle Fixture",
      "-c",
      "user.email=lifecycle@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "published branch",
    ]);
  }
  if (selectedBranch) await recordSource(selectedBranch);
  if (options.additionalBranch)
    await requireWorkspaceResultGit(origin, ["checkout", "--quiet", defaultBranch]);
  let commit = await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD"]);
  let tree = await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD^{tree}"]);
  const sourceTrees = new Map<
    string,
    { path: string; mode: string; type: string; sha: string }[]
  >();
  {
    for (const ref of [...sourceSnapshots.values()]
      .map((source) => source.tree)
      .concat(options.setupScript ? ["HEAD:.openclaw"] : [])) {
      const sha = await requireWorkspaceResultGit(origin, ["rev-parse", ref]);
      const listing = await requireWorkspaceResultGit(origin, ["ls-tree", ref]);
      sourceTrees.set(
        sha,
        listing
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [metadata, path] = line.split("\t");
            const [mode, type, sha] = metadata!.split(" ");
            return { path: path!, mode: mode!, type: type!, sha: sha! };
          }),
      );
    }
  }
  const repositoryUrl = "https://microsoft.ghe.com/acme/lifecycle.git";
  const executeGit = gitExec.executeGitCommand;
  vi.spyOn(gitExec, "executeGitCommand").mockImplementation((cwd, args, options) =>
    executeGit(
      cwd,
      args.map((arg) => (arg === repositoryUrl ? pathToFileURL(origin).href : arg)),
      args.includes(repositoryUrl)
        ? { ...options, baseEnv: { ...options?.baseEnv, GIT_ALLOW_PROTOCOL: "file:https" } }
        : options,
    ),
  );
  const target = { agentId: "main", sessionKey: "agent:main:dashboard:worker-lifecycle" };
  let sessionId: string | undefined;
  const proofScopes = new AsyncLocalStorage<{
    agentId: string;
    sessionKey: string;
    sessionId?: string;
  }>();
  const nativeFetch = globalThis.fetch;
  let revokeNextLookup = false;
  const external = installFactoryRestartRepositoryFixture({
    allowSessionCreate: true,
    allowPublicationPreflight: true,
    repositorySnapshot: () => ({ commit, tree }),
    binding: () => ({
      ...(proofScopes.getStore() ?? { ...target, sessionId }),
      actorId: 700100,
      profileId: issuer.profile.id,
      repositoryUrl,
      context: issuer.context,
    }),
    afterLookup: async () => {
      if (revokeNextLookup) {
        revokeNextLookup = false;
        await setCanonicalUserProfileRole(issuer.profile.id, "revoked");
      } else authority.assertCurrent();
    },
    broker: () => "current",
  });
  external.responses.set("/repos/acme/lifecycle", {
    node_id: "R_restored_factory",
    clone_url: repositoryUrl,
    private: true,
    default_branch: defaultBranch,
  });
  // Workspace transfer is real loopback HTTP, not a GitHub fixture response.
  vi.stubGlobal("fetch", ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const source = sourceSnapshots.get(
      decodeURIComponent(url.pathname).split("/commits/heads/")[1] ?? "",
    );
    if (url.origin === "https://api.microsoft.ghe.com" && source) {
      expect(new Headers(init?.headers).get("authorization")).toContain(
        "synthetic-restored-factory-token",
      );
      return Promise.resolve(
        Response.json({ sha: source.commit, commit: { tree: { sha: source.tree } } }),
      );
    }
    const treeSha = url.pathname.split("/git/trees/")[1];
    const entries = treeSha && sourceTrees.get(treeSha);
    if (url.origin === "https://api.microsoft.ghe.com" && entries) {
      expect(new Headers(init?.headers).get("authorization")).toContain(
        "synthetic-restored-factory-token",
      );
      return Promise.resolve(Response.json({ sha: treeSha, truncated: false, tree: entries }));
    }
    return url.hostname === "127.0.0.1"
      ? nativeFetch(input, init)
      : external.fetchFixture(input, init);
  }) satisfies typeof fetch);
  return {
    origin,
    repositoryUrl,
    target,
    proofScopes,
    external,
    get commit() {
      return commit;
    },
    bindSessionId(id: string) {
      sessionId = id;
    },
    sourceCommit: (branch: string) =>
      expectDefined(sourceSnapshots.get(branch), "origin branch").commit,
    sourceTree: (branch: string): ReturnType<WorkerLifecycle["sourceTree"]> => {
      const { tree: sha } = expectDefined(sourceSnapshots.get(branch), "origin branch");
      return {
        sha,
        truncated: false,
        tree: expectDefined(sourceTrees.get(sha), "origin tree"),
      };
    },
    revokeAtNextCredentialLookup() {
      revokeNextLookup = true;
    },
    async advancePublishedBranch() {
      await fs.writeFile(path.join(origin, "published.txt"), "new published branch head\n");
      await requireWorkspaceResultGit(origin, ["add", "."]);
      await requireWorkspaceResultGit(origin, [
        "-c",
        "user.name=Lifecycle Fixture",
        "-c",
        "user.email=lifecycle@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "advance published branch",
      ]);
      commit = await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD"]);
      tree = await requireWorkspaceResultGit(origin, ["rev-parse", "HEAD^{tree}"]);
      await recordSource(options.branch ?? defaultBranch);
      return commit;
    },
  };
}
