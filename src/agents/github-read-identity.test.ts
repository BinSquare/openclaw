import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  createGitHubCommandResult as commandResult,
  githubTestLookupId as lookupId,
  createGitHubLookupFrame as frame,
} from "./github-identity-command.test-support.js";
import { clearGitHubCredentialVerificationCache } from "./github-oauth-client.js";

const mocks = vi.hoisted(() => ({ runCommandBuffered: vi.fn(), info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) =>
      name === "agents/github-identity" ? { info: mocks.info } : actual.createSubsystemLogger(name),
  };
});
beforeEach(() => mocks.info.mockReset());
vi.mock("../process/exec.js", () => ({ runCommandBuffered: mocks.runCommandBuffered }));

import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createGitHubReadIdentity,
  GitHubCredentialLookupError,
  GitHubIdentityError,
  readCachedNativeGitHubToken,
  readNativeGitHubToken,
  readGitAuthor,
} from "./github-read-identity.js";
import {
  prepareGitHubPublicationIdentity,
  prepareGitHubReadIdentity,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectLookup(diagnosticCode: string, client = {}, stage = "command") {
  expect(mocks.info).toHaveBeenCalledWith("github identity lookup", {
    stage,
    diagnosticCode,
    ...client,
  });
}

describe("native GitHub identity absence", () => {
  beforeEach(() => {
    mocks.runCommandBuffered.mockReset();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    clearRuntimeConfigSnapshot();
  });

  const launchFailure = (code = "ENOENT") => ({
    ...commandResult("", 1, "synthetic-launch-diagnostic"),
    code: null,
    termination: "error" as const,
    error: Object.assign(new Error("Synthetic launch failure"), { code }),
  });
  const absentEnvironment = () => {
    const root = tempDirs.make("github-native-absence-");
    return { PATH: root, GH_CONFIG_DIR: root, GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  };

  it("admits public source identity on a clean host without the optional GitHub CLI", async () => {
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(absentEnvironment(), true)).resolves.toBeUndefined();
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
  });

  it.each(["config.yml", "hosts.yml"])(
    "refuses a present native %s rather than treating it as anonymous",
    async (name) => {
      const env = absentEnvironment();
      await fs.writeFile(path.join(env.GH_CONFIG_DIR, name), "{}\n");
      mocks.runCommandBuffered.mockResolvedValue(launchFailure());
      await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    },
  );

  it("rejects a symbolic native configuration directory", async () => {
    const env = absentEnvironment();
    const link = path.join(env.GH_CONFIG_DIR, "native-link");
    await fs.symlink(env.GH_CONFIG_DIR, link, "junction");
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(
      readNativeGitHubToken({ ...env, GH_CONFIG_DIR: link }, true),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("does not interpret unreadable configuration metadata as absence", async () => {
    const env = absentEnvironment();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    vi.spyOn(fs, "lstat").mockRejectedValue(
      Object.assign(new Error("Synthetic permission failure"), { code: "EACCES" }),
    );
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("rejects a native launch permission failure without an anonymous fallback", async () => {
    mocks.runCommandBuffered.mockResolvedValue(launchFailure("EACCES"));
    await expect(readNativeGitHubToken(absentEnvironment(), true)).rejects.toMatchObject({
      reason: "unverified",
    });
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
  });

  it("detects a broken interpreter installed after a cached executable miss", async () => {
    const env = absentEnvironment();
    const cwd = process.cwd();
    expect(resolveExecutablePath("gh", { env, cwd })).toBeUndefined();
    await fs.writeFile(
      path.join(env.PATH, process.platform === "win32" ? "gh.cmd" : "gh"),
      "#!/missing/interpreter\n",
      { mode: 0o755 },
    );
    expect(resolveExecutablePath("gh", { env, cwd })).toBeUndefined();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("rejects an ENOENT caused by an unavailable working directory", async () => {
    const env = absentEnvironment();
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("Missing cwd"), { code: "ENOENT" });
    });
    await expect(readNativeGitHubToken(env, true)).rejects.toMatchObject({ reason: "unverified" });
  });

  it("uses native environment precedence without needing the optional CLI", async () => {
    await expect(
      readNativeGitHubToken(
        { GH_TOKEN: "synthetic-primary", GITHUB_TOKEN: "synthetic-secondary" },
        true,
      ),
    ).resolves.toBe("synthetic-primary");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: "", GITHUB_TOKEN: "synthetic-secondary" }, true),
    ).resolves.toBe("synthetic-secondary");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: " \n", GITHUB_TOKEN: "synthetic-secondary" }, true),
    ).rejects.toThrow("one non-empty line");
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it("asks the native credential owner for the configured enterprise host", async () => {
    setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
    mocks.runCommandBuffered.mockResolvedValue(commandResult("enterprise-token", 0));
    await expect(
      readNativeGitHubToken({
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
      }),
    ).resolves.toBe("enterprise-token");
    expect(mocks.runCommandBuffered).toHaveBeenCalledWith(
      ["gh", "auth", "token", "--hostname", "ghe.example.test"],
      expect.any(Object),
    );
  });

  it("does not pass public ambient credentials to a ghe.com tenant profile lookup", async () => {
    setRuntimeConfigSnapshot({ gateway: { github: { host: "tenant.ghe.com" } } });
    mocks.runCommandBuffered.mockImplementation(async (_argv, options) =>
      commandResult(options.env.GH_TOKEN || options.env.GITHUB_TOKEN || "stored-tenant-token"),
    );
    await expect(
      readNativeGitHubToken({
        GH_TOKEN: "synthetic-public-token",
        GITHUB_TOKEN: "synthetic-public-secondary",
      }),
    ).resolves.toBe("stored-tenant-token");
  });

  it("does not reuse a cached native token after the selected Enterprise host changes", async () => {
    const env = {
      GH_CONFIG_DIR: tempDirs.make("github-native-host-cache-"),
      GH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_ENTERPRISE_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
    };
    mocks.runCommandBuffered
      .mockResolvedValueOnce(commandResult("host-a-token"))
      .mockResolvedValueOnce(commandResult("host-b-token"));
    setRuntimeConfigSnapshot({ gateway: { github: { host: "a.ghe.example.test" } } });
    await expect(readCachedNativeGitHubToken(env)).resolves.toBe("host-a-token");
    setRuntimeConfigSnapshot({ gateway: { github: { host: "b.ghe.example.test" } } });
    await expect(readCachedNativeGitHubToken(env)).resolves.toBe("host-b-token");
    expect(mocks.runCommandBuffered.mock.calls.map(([argv]) => argv)).toEqual([
      ["gh", "auth", "token", "--hostname", "a.ghe.example.test"],
      ["gh", "auth", "token", "--hostname", "b.ghe.example.test"],
    ]);
  });

  it.each([undefined, "other.ghe.example.test"])(
    "rejects an ambient Enterprise token bound to %s",
    async (declaredHost) => {
      setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
      const env = { GH_ENTERPRISE_TOKEN: "synthetic-host-a-token", GH_HOST: declaredHost };
      await expect(readCachedNativeGitHubToken(env)).rejects.toMatchObject({
        reason: "unverified",
      });
      expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    },
  );

  it("prefers the Enterprise token over a public GitHub token for an Enterprise host", async () => {
    setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
    const env = {
      GH_TOKEN: "synthetic-public-token",
      GH_ENTERPRISE_TOKEN: "synthetic-enterprise-token",
      GH_HOST: "ghe.example.test",
    };
    await expect(readNativeGitHubToken(env)).resolves.toBe("synthetic-enterprise-token");
    await expect(readCachedNativeGitHubToken(env)).resolves.toBe("synthetic-enterprise-token");
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();

    mocks.runCommandBuffered.mockResolvedValue(commandResult("native-enterprise-token", 0));
    await expect(readNativeGitHubToken({ ...env, GH_ENTERPRISE_TOKEN: undefined })).resolves.toBe(
      "native-enterprise-token",
    );
    expect(mocks.runCommandBuffered).toHaveBeenCalledWith(
      ["gh", "auth", "token", "--hostname", "ghe.example.test"],
      expect.any(Object),
    );
  });

  it("uses an explicit protected executable for GitHub identity probes while preserving Git author lookup", async () => {
    setRuntimeConfigSnapshot({ gateway: { github: { host: "microsoft.ghe.com" } } });
    mocks.runCommandBuffered.mockResolvedValue(commandResult("enterprise-token", 0));
    await expect(
      readNativeGitHubToken({
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: "/opt/teamclaw/bin/gh",
      }),
    ).resolves.toBe("enterprise-token");
    expect(mocks.runCommandBuffered).toHaveBeenCalledWith(
      ["/opt/teamclaw/bin/gh", "auth", "token", "--hostname", "microsoft.ghe.com"],
      expect.any(Object),
    );
    mocks.runCommandBuffered.mockResolvedValue(
      commandResult("user.name\nFixture Author\0user.email\nfixture@example.test\0"),
    );
    await expect(
      readGitAuthor(
        { OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: "/opt/teamclaw/bin/gh" },
        "/fixture/workspace",
      ),
    ).resolves.toEqual({
      name: "Fixture Author",
      email: "fixture@example.test",
    });
    expect(mocks.runCommandBuffered.mock.calls[1]?.[0][0]).toBe("git");
  });

  it("rejects a relative native identity executable", async () => {
    await expect(
      readNativeGitHubToken({
        OPENCLAW_GITHUB_IDENTITY_EXECUTABLE: "relative/gh",
      }),
    ).rejects.toMatchObject({ reason: "unverified" });
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    expectLookup("invalid_executable");
  });

  it("preserves explicit undefined scrubs over inherited native environment tokens", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-preview-token");
    await expect(
      readNativeGitHubToken({ GH_TOKEN: undefined, GITHUB_TOKEN: "synthetic-source-token" }, true),
    ).resolves.toBe("synthetic-source-token");
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    await expect(readNativeGitHubToken(absentEnvironment(), true)).resolves.toBeUndefined();
  });

  it.each([
    {
      env: {
        GH_CONFIG_DIR: "C:\\explicit",
        XDG_CONFIG_HOME: "C:\\xdg",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\explicit",
    },
    {
      env: {
        GH_CONFIG_DIR: "",
        XDG_CONFIG_HOME: "C:\\xdg",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\xdg\\gh",
    },
    {
      env: {
        GH_CONFIG_DIR: "",
        XDG_CONFIG_HOME: "",
        APPDATA: "C:\\roaming",
        USERPROFILE: "C:\\user",
      },
      expected: "C:\\roaming\\GitHub CLI",
    },
    {
      env: { GH_CONFIG_DIR: "", XDG_CONFIG_HOME: "", APPDATA: "", USERPROFILE: "C:\\user" },
      expected: "C:\\user\\.config\\gh",
    },
  ])("checks the canonical Windows native config location $expected", async ({ env, expected }) => {
    mocks.runCommandBuffered.mockResolvedValue(launchFailure());
    const metadata = vi
      .spyOn(fs, "lstat")
      .mockRejectedValue(Object.assign(new Error("Absent fixture"), { code: "ENOENT" }));
    await withMockedPlatform("win32", async () => {
      await expect(
        readNativeGitHubToken(
          {
            ...env,
            HOME: "C:\\wrong-home",
            PATH: "",
            GH_TOKEN: undefined,
            GITHUB_TOKEN: undefined,
          },
          true,
        ),
      ).resolves.toBeUndefined();
    });
    expect(metadata.mock.calls.map(([file]) => file)).toEqual([
      expected,
      path.win32.join(expected, "config.yml"),
      path.win32.join(expected, "hosts.yml"),
    ]);
  });

  it.each([
    {
      label: "failed status",
      stdout: '{"hosts":{}}',
      code: 1,
      diagnostic: "nonzero_exit",
      reason: "unverified",
    },
    {
      label: "malformed status",
      stdout: "not JSON",
      code: 0,
      diagnostic: "invalid_json",
      reason: "unverified",
    },
    {
      label: "missing host map",
      stdout: "{}",
      code: 0,
      diagnostic: "invalid_hosts_schema",
      reason: "unverified",
    },
    {
      label: "unreadable account",
      diagnostic: "configured_account_present",
      reason: "unavailable",
      stdout: '{"hosts":{"github.com":[{"state":"error"}]}}',
      code: 0,
    },
  ])(
    "does not treat $label as anonymous native identity",
    async ({ stdout, code, diagnostic, reason }) => {
      const outputs: ReturnType<typeof commandResult>[] = [];
      mocks.runCommandBuffered.mockImplementation(async (argv: string[]) => {
        const result =
          argv[2] === "status"
            ? commandResult(stdout, code, "synthetic-native-diagnostic")
            : commandResult("", 1, "synthetic-token-diagnostic");
        outputs.push(result);
        return result;
      });
      const lookup = readNativeGitHubToken({}, true);
      await expect(lookup).rejects.toBeInstanceOf(GitHubIdentityError);
      await expect(lookup).rejects.toMatchObject({ reason });
      expect(mocks.runCommandBuffered.mock.calls.map(([argv]) => argv)).toEqual([
        ["gh", "auth", "token", "--hostname", "github.com"],
        ["gh", "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
      ]);
      expect(
        outputs.every(
          ({ stdout: out, stderr }) =>
            out.every((byte) => byte === 0) && stderr.every((byte) => byte === 0),
        ),
      ).toBe(true);
      expectLookup("nonzero_exit");
      expectLookup(diagnostic, {}, "auth_status");
      expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(/synthetic.*diagnostic|not JSON/);
      const statusOptions = mocks.runCommandBuffered.mock.calls[1]?.[1];
      expect(statusOptions.timeoutMs).toBeGreaterThan(0);
      expect(statusOptions.timeoutMs).toBeLessThanOrEqual(15_000);
      expect(statusOptions.maxOutputBytes).toBe(32 * 1024);
    },
  );
  it.each([
    ["payload", "accepted", 200, 0],
    ["transport", "broker_unavailable", undefined, 1],
    ["transport", "deadline_exceeded", undefined, 1],
    ["broker", "http_rejected", 403, 1],
    ["parse", "response_unreadable", 200, 1],
    ["payload", "invalid_credential_response", 200, 1],
  ] as const)(
    "preserves wrapper %s/%s diagnostics and scrubs child buffers",
    async (clientStage, clientCode, httpStatus, code) => {
      const result = commandResult(
        "synthetic-private-token",
        code,
        frame(clientStage, clientCode, httpStatus),
      );
      const diagnostic = {
        lookupId,
        clientStage,
        clientCode,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
      mocks.runCommandBuffered.mockResolvedValue(result);
      if (code === 0) {
        await expect(readNativeGitHubToken({})).resolves.toBe("synthetic-private-token");
      } else {
        const failed = readNativeGitHubToken({});
        await expect(failed).rejects.toBeInstanceOf(GitHubCredentialLookupError);
        await expect(failed).rejects.toMatchObject({ diagnostic });
      }
      expectLookup(code === 0 ? "token_accepted" : "nonzero_exit", diagnostic);
      expect(result.stdout.every((byte) => byte === 0)).toBe(true);
      expect(result.stderr.every((byte) => byte === 0)).toBe(true);
      expect(JSON.stringify(mocks.info.mock.calls)).not.toContain("synthetic-private-token");
    },
  );

  it.each([
    ["extra content", 1, "", frame("broker", "http_rejected", 403) + "private customer content"],
    ["forged stage", 1, "", frame("__proto__", "http_rejected", 403)],
    ["accepted failure", 1, "", frame("payload", "accepted", 200)],
    ["rejected success", 0, "synthetic-private-token", frame("broker", "http_rejected", 403)],
  ] as const)("does not link %s to a wrapper lookup", async (_name, code, stdout, stderr) => {
    mocks.runCommandBuffered.mockResolvedValue(commandResult(stdout, code, stderr));
    await expect(readNativeGitHubToken({})).resolves.toBe(code === 0 ? stdout : undefined);
    expectLookup(code === 0 ? "token_accepted" : "nonzero_exit");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(
      /bbbbbbbb|private customer|synthetic-private-token|__proto__/,
    );
  });

  it("propagates unexpected native failures without logging private messages", async () => {
    const failure = new Error("private process content");
    mocks.runCommandBuffered.mockRejectedValue(failure);
    await expect(readNativeGitHubToken({})).rejects.toBe(failure);
    expectLookup("unknown");
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain(failure.message);
  });
});

describe("prepared GitHub read authority", () => {
  it("isolates verified read views from overlapping actions and closes retained views", async () => {
    let token = "synthetic-operation-credential";
    const readToken = vi.fn(async () => token);
    const identity = createGitHubReadIdentity({
      token,
      selection: { source: "system-detected", accountId: 101 },
      assertSelected: () => {},
      readToken,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const withVerifiedRead = identity.withVerifiedRead;
    if (!withVerifiedRead) {
      throw new Error("Prepared identity lacks read admission");
    }
    let retained: typeof identity | undefined;
    const read = withVerifiedRead(async (view) => {
      retained = view;
      await view.revalidate();
      entered.resolve();
      await release.promise;
      await view.revalidate();
      return "read result";
    });
    await entered.promise;
    if (!retained) {
      throw new Error("Read admission did not supply its view");
    }
    expect(readToken).toHaveBeenCalledOnce();
    await identity.start(() => "unrelated action");
    await retained.start(() => "action cannot borrow read verification");
    expect(readToken).toHaveBeenCalledTimes(3);
    const validating = createDeferredCore<string>();
    const validationStarted = createDeferredCore();
    readToken.mockImplementationOnce(async () => {
      validationStarted.resolve();
      return await validating.promise;
    });
    const effect = vi.fn();
    const pendingAction = retained.start(effect);
    await validationStarted.promise;
    release.resolve();
    await expect(read).resolves.toBe("read result");
    expect(readToken).toHaveBeenCalledTimes(5);
    validating.resolve(token);
    await expect(pendingAction).rejects.toMatchObject({ reason: "changed" });
    expect(effect).not.toHaveBeenCalled();
    await expect(retained.revalidate()).rejects.toMatchObject({ reason: "changed" });
    token = "changed-synthetic-credential";
    const consume = vi.fn(async () => "must not be admitted");
    await expect(withVerifiedRead(consume)).rejects.toMatchObject({ reason: "changed" });
    expect(consume).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    clearGitHubCredentialVerificationCache();
    mocks.runCommandBuffered.mockReset();
    vi.stubEnv("GH_TOKEN", undefined);
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const native = new Headers(init?.headers).get("Authorization")?.includes("native");
      return new Response(
        JSON.stringify({
          id: native ? 101 : 202,
          login: native ? "native-user" : "managed-user",
          avatar_url: null,
        }),
      );
    });
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const readOptions = (env: NodeJS.ProcessEnv = {}, config: OpenClawConfig = {}) => ({
    config,
    agentId: "main",
    env,
    getCurrentConfig: () => config,
    assertActive: () => {},
    refresh: async () => {},
  });

  it("keeps default read preparation bound to the configured Enterprise issuer", async () => {
    const config = {
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    };
    const env = {
      GH_HOST: "ghe.example.test",
      GH_TOKEN: "synthetic-public-only",
      GH_ENTERPRISE_TOKEN: "native-enterprise-only",
    };
    setRuntimeConfigSnapshot(config);
    const identity = await prepareGitHubReadIdentity(readOptions(env, config));
    expect(identity.token).toBe(env.GH_ENTERPRISE_TOKEN);
    expect(fetch).toHaveBeenCalledWith(
      "https://ghe.example.test/api/v3/user",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${env.GH_ENTERPRISE_TOKEN}` }),
      }),
    );
    await expect(identity.revalidate()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it("reuses the native credential across consecutive read preparations until invalidation", async () => {
    mocks.runCommandBuffered.mockImplementation(async () => commandResult("native-cached-read"));
    const options = readOptions();
    const first = await prepareGitHubReadIdentity(options);
    const second = await prepareGitHubReadIdentity(options);
    expect(second.selection).toEqual(first.selection);
    await first.revalidate();
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    clearGitHubCredentialVerificationCache();
    await prepareGitHubReadIdentity(options);
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
  });

  it("observes host token rotation after 60 seconds while publication always reads it live", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let token = "native-before-ttl";
    mocks.runCommandBuffered.mockImplementation(async () => commandResult(token));
    const options = readOptions();
    const identity = await prepareGitHubReadIdentity(options);
    token = "native-after-ttl";
    now += 59_999;
    await expect(identity.revalidate()).resolves.toBeUndefined();
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    const publication = await prepareGitHubPublicationIdentity(options);
    expect(publication.env.GH_TOKEN).toBe(token);
    expect(publication.env.GH_ENTERPRISE_TOKEN).toBe(token);
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
    now += 1;
    await expect(identity.revalidate()).rejects.toMatchObject({ reason: "changed" });
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(3);
    expect((await prepareGitHubReadIdentity(options)).token).toBe(token);
  });

  it("shares concurrent native reads without letting an invalidated in-flight read refill the cache", async () => {
    const pending = createDeferredCore<ReturnType<typeof commandResult>>();
    const entered = createDeferredCore();
    mocks.runCommandBuffered
      .mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      })
      .mockImplementation(async () => commandResult("native-new-generation"));
    const options = readOptions();
    const readers = Array.from({ length: 15 }, () => prepareGitHubReadIdentity(options));
    await entered.promise;
    // Let all admitted callers reach the shared pending native read.
    await Promise.resolve();
    expect(mocks.runCommandBuffered).toHaveBeenCalledOnce();
    clearGitHubCredentialVerificationCache();
    expect((await prepareGitHubReadIdentity(options)).token).toBe("native-new-generation");
    pending.resolve(commandResult("native-old-generation"));
    await Promise.all(readers);
    expect((await prepareGitHubReadIdentity(options)).token).toBe("native-new-generation");
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
  });

  it("separates native command environments and immediately observes environment token changes", async () => {
    mocks.runCommandBuffered.mockImplementation(async (_argv, { env }) =>
      commandResult(`native-${env.GH_CONFIG_DIR}`),
    );
    const env: NodeJS.ProcessEnv = { GH_CONFIG_DIR: "first-profile", GH_TOKEN: undefined };
    const first = await prepareGitHubReadIdentity(readOptions(env));
    const other = await prepareGitHubReadIdentity(readOptions({ GH_CONFIG_DIR: "second-profile" }));
    expect(other.token).not.toBe(first.token);
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
    env.GH_TOKEN = "native-from-environment";
    await expect(first.revalidate()).rejects.toMatchObject({ reason: "changed" });
    expect((await prepareGitHubReadIdentity(readOptions(env))).token).toBe(env.GH_TOKEN);
    expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(2);
  });

  it.each(["refresh", "credential", "probe", "delivery"] as const)(
    "awaits caller authority before %s during identity preparation",
    async (stage) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let phase = "refresh";
      let allowed = true;
      const refresh = vi.fn(async () => {
        phase = "credential";
      });
      mocks.runCommandBuffered.mockImplementation(async () => {
        phase = "probe";
        return commandResult(`native-authority-${stage}`);
      });
      vi.mocked(fetch).mockImplementation(async () => {
        phase = "delivery";
        return new Response(JSON.stringify({ id: 101, login: "native-user", avatar_url: null }));
      });
      const options = {
        ...readOptions(),
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            entered.resolve();
            await release.promise;
          }
          if (!allowed) {
            throw new Error("grant revoked");
          }
          return await start();
        },
        refresh,
      };
      const preparing = prepareGitHubReadIdentity(options);
      const outcome = preparing.then(
        () => "delivered",
        () => "refused",
      );
      try {
        expect(await Promise.race([entered.promise.then(() => "checking"), outcome])).toBe(
          "checking",
        );
        expect(refresh).toHaveBeenCalledTimes(stage === "refresh" ? 0 : 1);
        expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(
          stage === "refresh" || stage === "credential" ? 0 : 1,
        );
        expect(fetch).toHaveBeenCalledTimes(stage === "delivery" ? 1 : 0);
        allowed = false;
        release.resolve();
        await expect(preparing).rejects.toThrow("grant revoked");
      } finally {
        release.resolve();
        await outcome;
      }
    },
  );

  it.each(["before", "after"] as const)(
    "rechecks live selection after delayed caller authority %s a retained credential read",
    async (stage) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let phase = "preparing";
      let active = true;
      const config = {};
      mocks.runCommandBuffered.mockImplementation(async () => {
        if (phase === "before") {
          phase = "after";
        }
        return commandResult(`native-retained-${stage}`);
      });
      const identity = await prepareGitHubReadIdentity({
        ...readOptions({}, config),
        assertActive: () => {
          if (!active) {
            throw new Error("caller closed");
          }
        },
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          if (phase === stage) {
            entered.resolve();
            await release.promise;
          }
          return await start();
        },
      });
      clearGitHubCredentialVerificationCache();
      mocks.runCommandBuffered.mockClear();
      phase = "before";
      const checking = identity.revalidate();
      const outcome = checking.then(
        () => "delivered",
        () => "refused",
      );
      try {
        expect(await Promise.race([entered.promise.then(() => "checking"), outcome])).toBe(
          "checking",
        );
        expect(mocks.runCommandBuffered).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
        active = false;
        release.resolve();
        await expect(checking).rejects.toThrow("caller closed");
      } finally {
        release.resolve();
        await outcome;
      }
    },
  );

  it("starts credential and network operations inside current caller admission", async () => {
    let admitted = false;
    const assertAdmitted = () => expect(admitted).toBe(true);
    mocks.runCommandBuffered.mockImplementation(async () => {
      assertAdmitted();
      return commandResult("native-admitted-start");
    });
    vi.mocked(fetch).mockImplementation(async () => {
      assertAdmitted();
      return new Response(JSON.stringify({ id: 101, login: "native-user", avatar_url: null }));
    });
    const identity = await prepareGitHubReadIdentity({
      ...readOptions(),
      startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
        await Promise.resolve();
        admitted = true;
        let result: T;
        try {
          result = start();
        } finally {
          admitted = false;
        }
        return await result;
      },
      refresh: async () => assertAdmitted(),
    });
    await identity.start(() => {
      assertAdmitted();
      return "read result";
    });
    expect(admitted).toBe(false);
  });

  it("releases admission during shared transport and authorizes each caller's final delivery", async () => {
    const transport = createDeferredCore<string>();
    const pending = new Map<string, Promise<string>>();
    const fetchShared = vi.fn(() => transport.promise);
    const caller = () => {
      const state = { active: true, admitted: false };
      const identity = createGitHubReadIdentity({
        token: "synthetic-shared-token",
        selection: { source: "system-detected", accountId: 101 },
        assertSelected: () => {},
        readToken: async () => "synthetic-shared-token",
        startActive: async <T>(start: () => T): Promise<Awaited<T>> => {
          await Promise.resolve();
          if (!state.active) {
            throw new Error("grant revoked");
          }
          state.admitted = true;
          let result: T;
          try {
            result = start();
          } finally {
            state.admitted = false;
          }
          return await result;
        },
      });
      const started = createDeferredCore();
      const result = identity.start(() => {
        expect(state.admitted).toBe(true);
        started.resolve();
        return getOrCreatePromise(pending, identity.cacheScope, fetchShared);
      });
      return { state, identity, started, result };
    };
    const leader = caller();
    const follower = caller();
    await Promise.all([leader.started.promise, follower.started.promise]);
    expect(leader.state.admitted || follower.state.admitted).toBe(false);
    expect(fetchShared).toHaveBeenCalledOnce();
    leader.state.active = false;
    transport.resolve("shared result");
    const [leaderResult, followerResult] = await Promise.all([leader.result, follower.result]);
    const publish = vi.fn((value: string) => value);
    await expect(leader.identity.start(() => publish(leaderResult))).rejects.toThrow(
      "grant revoked",
    );
    expect(publish).not.toHaveBeenCalled();
    await expect(follower.identity.start(() => publish(followerResult))).resolves.toBe(
      "shared result",
    );
    expect(publish).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "refreshes and fences native rotation, selection and publication snapshots (sink fails=%s)",
    async (sinkFails) => {
      let config: OpenClawConfig = {
        gateway: { controlUi: { github: { token: "resolved-preview-token" } } },
      };
      const sourceConfig = {
        gateway: {
          controlUi: {
            github: { token: { source: "env" as const, provider: "default", id: "GH_TOKEN" } },
          },
        },
      };
      const env = { GH_TOKEN: "preview-only", GITHUB_TOKEN: "native-before" };
      const refresh = vi.fn(async () => {
        env.GITHUB_TOKEN = "native-refreshed";
      });
      const identity = await prepareGitHubReadIdentity({
        ...readOptions(env, config),
        sourceConfig,
        getCurrentConfig: () => config,
        refresh,
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(identity.token).toBe("native-refreshed");
      expect(identity.selection).toEqual({ source: "system-detected", accountId: 101 });
      expect(identity).not.toHaveProperty("env");
      expect(identity.cacheScope).not.toContain("native-refreshed");
      mocks.info.mockClear();
      const dispatch = vi.fn(() => "read result");
      await expect(identity.start(dispatch)).resolves.toBe("read result");
      expect(dispatch).toHaveBeenCalledOnce();
      expect(mocks.info).not.toHaveBeenCalled();
      const publication = await prepareGitHubPublicationIdentity({
        config,
        sourceConfig,
        agentId: "main",
        env,
      });
      mocks.info.mockClear();
      dispatch.mockClear();
      env.GITHUB_TOKEN = "native-rotated";
      if (sinkFails)
        mocks.info.mockImplementationOnce(() => {
          throw new Error("private sink error");
        });
      await expect(identity.start(dispatch)).rejects.toMatchObject({ reason: "changed" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledExactlyOnceWith("github identity rejected", {
        diagnosticCode: "credential_changed",
        source: "system-detected",
        profileId: undefined,
        expectedAccountId: 101,
        credentialChanged: true,
        expectedCredentialPresent: true,
        currentCredentialPresent: true,
      });
      expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(
        /native-refreshed|native-rotated|preview-only|private sink/,
      );
      mocks.info.mockClear();
      config = { ...config, tools: { github: { profileId: `ghp_${"7".repeat(32)}` } } };
      await expect(identity.start(dispatch)).rejects.toMatchObject({ reason: "changed" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.info).toHaveBeenCalledExactlyOnceWith("github identity rejected", {
        diagnosticCode: "selection_changed",
        expectedSource: "system-detected",
        currentSource: "system-configured",
        expectedProfileId: undefined,
        currentProfileId: `ghp_${"7".repeat(32)}`,
        expectedKind: undefined,
        currentKind: undefined,
      });
      expect(JSON.stringify(mocks.info.mock.calls)).not.toMatch(
        /native-refreshed|native-rotated|preview-only|private sink/,
      );
      expect(publication.env.GH_TOKEN).toBe("native-refreshed");
      expect(publication.env.GH_ENTERPRISE_TOKEN).toBe("native-refreshed");
      expect(JSON.stringify(mocks.runCommandBuffered.mock.calls)).not.toContain("preview-only");
    },
  );

  it("does not verify credentials after read authority closes during refresh", async () => {
    let active = true;
    await expect(
      prepareGitHubReadIdentity({
        ...readOptions(),
        assertActive: () => {
          if (!active) {
            throw new Error("closed");
          }
        },
        refresh: async () => {
          active = false;
        },
      }),
    ).rejects.toThrow("closed");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
  });

  it.each(["system", "agent"] as const)(
    "binds %s read authority to its selected profile and verified account",
    async (scope) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-read-selection-") };
      const profileId = `ghp_${"3".repeat(32)}`;
      const replacementProfileId = `ghp_${"4".repeat(32)}`;
      const configured = (selectedProfileId: string): OpenClawConfig => {
        const github = { profileId: selectedProfileId };
        return scope === "system"
          ? { tools: { github } }
          : { agents: { entries: { main: { tools: { github } } } } };
      };
      let config = configured(profileId);
      const profileDir = resolveManagedGitHubProfileDir({ agentId: "main", scope, profileId, env });
      await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
      const hosts = path.join(profileDir, "hosts.yml");
      await fs.writeFile(hosts, `github.com:\n  oauth_token: read-${scope}-before\n`, {
        mode: 0o600,
      });
      const prepare = () =>
        prepareGitHubReadIdentity({
          ...readOptions(env, config),
          getCurrentConfig: () => config,
        });
      const identity = await prepare();
      expect(identity.selection).toEqual({
        source: scope === "system" ? "system-configured" : "agent-override",
        profileId,
        accountId: 202,
      });
      await fs.writeFile(hosts, `github.com:\n  oauth_token: read-${scope}-rotated\n`);
      await expect(identity.revalidate()).rejects.toThrow("identity changed");
      const rotated = await prepare();
      expect(rotated.selection).toEqual(identity.selection);
      expect(rotated.cacheScope).not.toBe(identity.cacheScope);
      config = configured(replacementProfileId);
      expect(() => rotated.assertSelected()).toThrow("identity changed");
      expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    },
  );

  it("admits explicit anonymous source reads only while native credentials remain absent", async () => {
    mocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult('{"hosts":{}}') : commandResult("", 1),
    );
    const options = readOptions();
    await expect(prepareGitHubReadIdentity(options)).rejects.toThrow("credential is unavailable");
    const identity = await prepareGitHubReadIdentity({ ...options, allowAnonymous: true });
    expect(identity.selection).toEqual({ source: "anonymous" });
    expect(identity.token).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    await expect(identity.revalidate()).resolves.toBeUndefined();
    mocks.runCommandBuffered.mockResolvedValue(commandResult("native-after-sign-in"));
    await expect(identity.revalidate()).rejects.toThrow("identity changed");
  });

  it("closes anonymous read authority when native account configuration becomes unreadable", async () => {
    let hosts = {};
    mocks.runCommandBuffered.mockImplementation(async (argv: string[]) =>
      argv[2] === "status" ? commandResult(JSON.stringify({ hosts })) : commandResult("", 1),
    );
    const identity = await prepareGitHubReadIdentity({
      ...readOptions(),
      allowAnonymous: true,
    });
    hosts = { "github.com": [{ state: "error" }] };
    await expect(identity.revalidate()).rejects.toThrow("credential is unavailable");
  });

  it("never substitutes anonymous access for a configured or rejected source credential", async () => {
    const options = {
      ...readOptions({ OPENCLAW_STATE_DIR: tempDirs.make("openclaw-github-source-") }),
      allowAnonymous: true as const,
    };
    const configured = { tools: { github: { profileId: `ghp_${"1".repeat(32)}` } } };
    await expect(
      prepareGitHubReadIdentity({
        ...options,
        config: configured,
        getCurrentConfig: () => configured,
      }),
    ).rejects.toThrow("credential is unavailable");
    expect(mocks.runCommandBuffered).not.toHaveBeenCalled();
    mocks.runCommandBuffered.mockResolvedValue(commandResult("native-rejected-source-token"));
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(prepareGitHubReadIdentity(options)).rejects.toThrow("credential is unavailable");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
