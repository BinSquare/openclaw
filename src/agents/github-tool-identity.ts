import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import type {
  GitHubIdentityFacts,
  ToolsGitHubStatusResult,
} from "../../packages/gateway-protocol/src/index.js";
import { isManagedGitHubProfileId } from "../config/github-identity-profile-id.js";
import { resolveStateDir } from "../config/paths.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";
import {
  CLEARED_GITHUB_CREDENTIALS,
  resolveGitHubApiBaseUrl,
  resolveGitHubHost,
  withGitHubToken,
} from "./github-host-runtime.js";
import {
  GITHUB_PUBLIC_HOST as GITHUB_HOST,
  GITHUB_PUBLIC_API_BASE_URL,
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "./github-host.js";
import { measureGitHubIdentityPreparation } from "./github-identity-preparation-timing.js";
import {
  isPrivateManagedGitHubProfile,
  readManagedGitHubToken,
} from "./github-managed-profile-read.js";
import {
  managedGitHubIdentityEnvironment,
  notifyManagedGitHubProfileChanged,
  writeManagedGitHubProfileFiles,
  type ManagedGitHubCredentialIssuer,
} from "./github-managed-profile.js";
import { verifyGitHubCredential } from "./github-oauth-client.js";
import { inspectGitHubOAuthRecord } from "./github-oauth-records.js";
import {
  clearNativeGitHubTokenCache,
  createGitHubReadIdentity,
  GitHubIdentityError,
  normalizeGitHubToken as normalizeManagedGitHubToken,
  readCachedNativeGitHubToken,
  readGitAuthor,
  readNativeGitHubToken,
  readSelectedNativeGitHubToken,
  reportGitHubIdentityRejection,
  startGitHubIdentityOperation,
  type GitHubIdentityPreparation,
  type GitHubReadIdentityPreparation,
  type GitHubReadIdentityStarter,
  type PreparedGitHubReadIdentity,
  type PreparedGitHubSourceReadIdentity,
} from "./github-read-identity.js";
import { managedGitHubHosts, type GitHubToolAccount } from "./github-tool-account.js";
import type { PreparedGitHubToolEnvironment } from "./github-tool-identity.types.js";

export { GitHubIdentityError } from "./github-read-identity.js";
export {
  managedGitHubIdentityEnvironment,
  onManagedGitHubProfileChanged,
  writeManagedGitHubProfileFiles,
} from "./github-managed-profile.js";

const MANAGED_GITHUB_ROOT_SEGMENTS = ["credentials", "github"] as const;

export class GitHubAccountMismatchError extends Error {}

export function createManagedGitHubProfileId(): string {
  return `ghp_${randomBytes(16).toString("hex")}`;
}

export function resolveManagedGitHubProfileDir(params: {
  agentId: string;
  scope: "system" | "agent" | "personal";
  profileId: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (!isManagedGitHubProfileId(params.profileId)) {
    throw new Error("Managed GitHub profile id is invalid.");
  }
  const root = resolveManagedGitHubProfileRoot(params);
  return path.join(root, params.profileId);
}

export function resolveManagedGitHubProfileRoot(params: {
  agentId: string;
  scope: "system" | "agent" | "personal";
  env?: NodeJS.ProcessEnv;
}): string {
  const root = path.join(resolveStateDir(params.env), ...MANAGED_GITHUB_ROOT_SEGMENTS);
  return params.scope === "agent"
    ? path.join(root, "agents", resolveManagedGitHubAgentKey(params.agentId))
    : path.join(root, params.scope);
}

export function resolveManagedGitHubAgentKey(agentId: string): string {
  return createHash("sha256").update(normalizeAgentId(agentId), "utf8").digest("hex");
}

export function resolveConfiguredGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
}): GitHubToolIdentityConfig | undefined {
  return params.scope === "agent"
    ? resolveAgentConfig(params.config, params.agentId)?.tools?.github
    : params.config.tools?.github;
}

function resolveSystemGitHubToolIdentity(
  params: Pick<GitHubIdentityPreparation, "config" | "env">,
) {
  const config = params.config.tools?.github;
  return config
    ? {
        source: "system-configured" as const,
        config,
        profileDir: resolveManagedGitHubProfileDir({
          agentId: "",
          scope: "system",
          profileId: config.profileId,
          env: params.env,
        }),
      }
    : { source: "system-detected" as const };
}

function resolveGitHubToolIdentity(params: GitHubIdentityPreparation) {
  return (
    resolveScopedGitHubToolIdentity({ ...params, scope: "agent" }) ??
    resolveSystemGitHubToolIdentity(params)
  );
}

function resolveScopedGitHubToolIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  scope: "system" | "agent";
  env?: NodeJS.ProcessEnv;
}) {
  if (params.scope === "system") {
    return resolveSystemGitHubToolIdentity(params);
  }
  const config = resolveConfiguredGitHubToolIdentity(params);
  return config
    ? {
        source: "agent-override" as const,
        config,
        profileDir: resolveManagedGitHubProfileDir({
          agentId: params.agentId,
          env: params.env,
          scope: "agent",
          profileId: config.profileId,
        }),
      }
    : undefined;
}

type ResolvedGitHubToolIdentity = ReturnType<typeof resolveGitHubToolIdentity>;

/** Prepares the non-secret child overlay and store exclusions once per agent run. */
export function prepareGitHubToolEnvironment(
  params: GitHubIdentityPreparation,
): PreparedGitHubToolEnvironment {
  return prepareGitHubToolEnvironmentForIdentity(params, resolveGitHubToolIdentity(params));
}

function prepareGitHubToolEnvironmentForIdentity(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig">,
  identity: ResolvedGitHubToolIdentity,
): PreparedGitHubToolEnvironment {
  const managedLocalIdentity = identity.source !== "system-detected";
  const previewToken =
    params.sourceConfig?.gateway?.controlUi?.github?.token ??
    params.config.gateway?.controlUi?.github?.token;
  const credentialScrubEnv: Record<string, string> = {
    GITHUB_APP_PRIVATE_KEY: "",
    OPENCLAW_GITHUB_APP_PRIVATE_KEY: "",
    ...(managedLocalIdentity ? CLEARED_GITHUB_CREDENTIALS : {}),
  };
  const excludedStoreNames: string[] = [];
  if (isSecretRef(previewToken)) {
    if (previewToken.source === "env" && isValidEnvSecretRefId(previewToken.id)) {
      credentialScrubEnv[previewToken.id] = "";
    } else if (previewToken.source === "store") {
      credentialScrubEnv[previewToken.id] = "";
      excludedStoreNames.push(previewToken.id);
    }
  }
  return Object.freeze({
    credentialScrubEnv: Object.freeze(credentialScrubEnv),
    localIdentityEnv: Object.freeze(
      managedLocalIdentity
        ? managedGitHubIdentityEnvironment({
            profileDir: identity.profileDir,
            gitAuthor: identity.config.gitAuthor,
          })
        : {},
    ),
    excludedStoreNames: Object.freeze(excludedStoreNames),
    managedLocalIdentity,
  });
}

function githubIdentityProbeEnvironment(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env">,
  identity: ResolvedGitHubToolIdentity,
): NodeJS.ProcessEnv {
  const overlay = prepareGitHubToolEnvironmentForIdentity(params, identity);
  return {
    ...(params.env ?? process.env),
    ...Object.fromEntries(Object.keys(overlay.credentialScrubEnv).map((name) => [name, undefined])),
    ...overlay.localIdentityEnv,
  };
}

export async function resolveGitHubToolIdentityStatus(
  params: GitHubIdentityPreparation & { selectedScope: "system" | "agent" },
): Promise<ToolsGitHubStatusResult> {
  const effectiveIdentity = resolveGitHubToolIdentity(params);
  const selectedIdentity = resolveScopedGitHubToolIdentity({
    ...params,
    scope: params.selectedScope,
  });
  const probe = {
    config: params.config,
    sourceConfig: params.sourceConfig,
    cwd: resolveAgentWorkspaceDir(params.config, params.agentId),
    env: params.env,
  };
  const effective = await resolveGitHubIdentityFacts({ ...probe, identity: effectiveIdentity });
  const selectedMatchesEffective =
    selectedIdentity?.source === effectiveIdentity.source &&
    (selectedIdentity?.source === "system-detected" ||
      (effectiveIdentity.source !== "system-detected" &&
        selectedIdentity?.config.profileId === effectiveIdentity.config.profileId));
  const selected = !selectedIdentity
    ? null
    : selectedMatchesEffective
      ? effective
      : await resolveGitHubIdentityFacts({ ...probe, identity: selectedIdentity });
  return {
    agentId: params.agentId,
    selectedScope: params.selectedScope,
    selected: {
      scope: params.selectedScope,
      configured: selectedIdentity?.source !== "system-detected" && selectedIdentity !== undefined,
      identity: selected,
    },
    effective,
  };
}

export async function resolveSystemGitHubIdentityStatus(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env">,
): Promise<GitHubIdentityFacts> {
  // Profile settings have no agent owner. Probe the shared identity outside agent workspaces.
  return resolveGitHubIdentityFacts({
    ...params,
    identity: resolveSystemGitHubToolIdentity(params),
    cwd: resolveStateDir(params.env),
  });
}

/** Resolve a human account only when native GitHub auth matches the trusted caller id. */
export async function resolveVerifiedSystemNativeGitHubAccount(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  accountId: number;
  host: string;
}): Promise<{ accountId: number; login: string; avatarUrl: string | null } | null> {
  const host = resolveConfiguredGitHubHost(params.config);
  const apiBaseUrl = resolveConfiguredGitHubApiBaseUrl(params.config);
  if (host !== params.host) {
    return null;
  }
  const identity = resolveSystemGitHubToolIdentity(params);
  if (identity.source !== "system-detected") {
    return null;
  }
  const token = await readNativeGitHubToken(
    githubIdentityProbeEnvironment(params, identity),
    false,
    host,
  );
  const probe = token ? await verifyGitHubCredential(token, { apiBaseUrl }) : undefined;
  return probe?.status === "available" && probe.account.accountId === params.accountId
    ? probe.account
    : null;
}

async function resolveGitHubIdentityFacts(
  params: Pick<GitHubIdentityPreparation, "config" | "sourceConfig" | "env"> & {
    cwd: string;
    identity: ResolvedGitHubToolIdentity;
  },
): Promise<GitHubIdentityFacts> {
  const identity = params.identity;
  const managed = identity.source !== "system-detected";
  const probeEnv = githubIdentityProbeEnvironment(params, identity);
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  const publicOAuth = managed && identity.config.kind === "oauth";
  const token = managed
    ? await readManagedGitHubToken(identity.profileDir, publicOAuth ? GITHUB_HOST : host)
    : await readNativeGitHubToken(probeEnv, false, host);
  const [probe, author] = await Promise.all([
    token
      ? verifyGitHubCredential(token, {
          apiBaseUrl: publicOAuth ? GITHUB_PUBLIC_API_BASE_URL : apiBaseUrl,
        })
      : undefined,
    readGitAuthor(probeEnv, params.cwd),
  ]);
  const account = probe?.status === "available" ? probe.account : null;
  const credentialState =
    probe?.status === "unavailable" || !probe
      ? managed
        ? "configured_unavailable"
        : "unavailable"
      : probe.status;
  const oauth =
    managed && identity.config.kind === "oauth"
      ? inspectGitHubOAuthRecord(identity.config.profileId)
      : { state: "missing" as const };
  const oauthRecord = oauth.state === "valid" ? oauth.record : undefined;
  const refreshState =
    !managed || identity.config.kind !== "oauth"
      ? "not_applicable"
      : oauth.state !== "valid"
        ? "unavailable"
        : oauth.record.pendingRefresh
          ? "refreshing"
          : (oauth.record.refreshFailure ??
            (oauth.record.refreshExpiresAtMs <= Date.now() ? "expired" : "available"));
  return {
    source: identity.source,
    credentialKind: !managed
      ? "native"
      : identity.config.kind === "oauth"
        ? "managed-oauth"
        : "managed-pat",
    credentialState,
    account: account ? { login: account.login } : null,
    gitAuthor: author,
    evidence: account
      ? "github-api"
      : probe?.status === "rate_limited"
        ? "rate-limited"
        : probe
          ? "unverified"
          : "none",
    accessExpiresAtMs: oauthRecord?.accessExpiresAtMs ?? null,
    refreshState,
    oauthScopes: [...(oauthRecord?.scopes ?? [])],
    repositoryGrants: "unknown",
  };
}

export type PreparedGitHubPublicationIdentity = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override" | "personal";
  profileId?: string;
  host?: string;
  account: GitHubToolAccount;
  env: NodeJS.ProcessEnv;
  accessExpiresAtMs?: number;
}>;

/** Only the personal publication broker receives this environment; never agent execution. */
export async function preparePersonalGitHubPublicationIdentity(params: {
  profileId: string;
  accountId: number;
  assertCurrent: () => void;
}): Promise<PreparedGitHubPublicationIdentity> {
  params.assertCurrent();
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  if (host !== GITHUB_HOST || apiBaseUrl !== GITHUB_PUBLIC_API_BASE_URL) {
    throw new Error("My GitHub OAuth supports public GitHub publication only.");
  }
  const assertSelected = () => {
    params.assertCurrent();
    if (resolveGitHubHost() !== host || resolveGitHubApiBaseUrl() !== apiBaseUrl) {
      throw new GitHubIdentityError("changed");
    }
  };
  const profileDir = resolveManagedGitHubProfileDir({
    agentId: "",
    scope: "personal",
    profileId: params.profileId,
  });
  const token = await readManagedGitHubToken(profileDir);
  if (!token) {
    throw new Error("My GitHub profile is unavailable; reconnect My GitHub.");
  }
  assertSelected();
  const env = {
    ...withGitHubToken(process.env, token),
    GH_CONFIG_DIR: profileDir,
    GH_PROMPT_DISABLED: "1",
  };
  const probe = await verifyGitHubCredential(token, { apiBaseUrl: GITHUB_PUBLIC_API_BASE_URL });
  assertSelected();
  if (probe.status !== "available") {
    throw new Error("My GitHub credential could not be verified; reconnect My GitHub.");
  }
  if (probe.account.accountId !== params.accountId) {
    throw new GitHubAccountMismatchError("My GitHub account changed; reconnect My GitHub.");
  }
  return Object.freeze({
    source: "personal",
    profileId: params.profileId,
    host: GITHUB_HOST,
    account: probe.account,
    env: Object.freeze(env),
  });
}

/** Confirms the current config still selects the prepared publication profile. */
export function matchesPreparedGitHubPublicationIdentity(params: {
  config: OpenClawConfig;
  agentId: string;
  identity: PreparedGitHubPublicationIdentity;
}): boolean {
  const current = resolveGitHubToolIdentity(params);
  return (
    current.source === params.identity.source &&
    (params.identity.host ?? resolveGitHubHost()) === resolveGitHubHost() &&
    (current.source === "system-detected" || current.config.profileId === params.identity.profileId)
  );
}

async function prepareSharedGitHubIdentity(
  params: GitHubIdentityPreparation & {
    assertCurrent?: () => void;
    startCurrent?: GitHubReadIdentityStarter;
    allowAnonymous?: boolean;
  },
  readNativeToken = readNativeGitHubToken,
  host = resolveGitHubHost(),
  apiBaseUrl = resolveGitHubApiBaseUrl(),
) {
  const identity = resolveGitHubToolIdentity(params);
  const managed = identity.source !== "system-detected";
  const oauthAtStart =
    managed && identity.config.kind === "oauth"
      ? inspectGitHubOAuthRecord(identity.config.profileId)
      : undefined;
  const currentEnvironment = (): NodeJS.ProcessEnv => ({
    ...githubIdentityProbeEnvironment(params, identity),
    GH_PROMPT_DISABLED: "1",
  });
  const env = currentEnvironment();
  if (
    managed &&
    identity.config.kind === "oauth" &&
    (host !== GITHUB_HOST || apiBaseUrl !== GITHUB_PUBLIC_API_BASE_URL)
  ) {
    const error = new GitHubIdentityError("unavailable");
    error.message =
      "Use a credential issued by the repository's GitHub host; managed OAuth profiles are issued by github.com.";
    throw error;
  }
  const readToken = () =>
    managed
      ? readManagedGitHubToken(identity.profileDir, host)
      : readSelectedNativeGitHubToken(params, currentEnvironment(), readNativeToken, host);
  const token = await measureGitHubIdentityPreparation(
    params.observePreparation,
    "credential_read",
    () => startGitHubIdentityOperation(readToken, params),
  );
  if (!token) {
    return startGitHubIdentityOperation(() => {
      if (!managed && params.allowAnonymous) {
        return { prepared: undefined, token: undefined, readToken };
      }
      throw new GitHubIdentityError("unavailable");
    }, params);
  }
  const probe = await measureGitHubIdentityPreparation(
    params.observePreparation,
    "user_verification",
    () =>
      startGitHubIdentityOperation(
        () =>
          verifyGitHubCredential(token, {
            apiBaseUrl,
            ...(oauthAtStart?.state === "valid" &&
            !oauthAtStart.record.pendingRefresh &&
            !oauthAtStart.record.pendingInitial
              ? {
                  accessExpiresAtMs: oauthAtStart.record.accessExpiresAtMs,
                  expectedAccountId: oauthAtStart.record.accountId,
                }
              : {}),
          }),
        params,
      ),
  );
  return startGitHubIdentityOperation(() => {
    if (probe.status !== "available") {
      throw new GitHubIdentityError(probe.status);
    }
    const oauth =
      managed && identity.config.kind === "oauth"
        ? inspectGitHubOAuthRecord(identity.config.profileId)
        : undefined;
    const accessExpiresAtMs =
      oauth?.state === "valid" &&
      oauthAtStart?.state === "valid" &&
      !oauthAtStart.record.pendingRefresh &&
      !oauthAtStart.record.pendingInitial &&
      !oauth.record.pendingRefresh &&
      !oauth.record.pendingInitial &&
      oauth.record.refreshToken === oauthAtStart.record.refreshToken &&
      oauth.record.accountId === probe.account.accountId
        ? oauth.record.accessExpiresAtMs
        : undefined;
    const prepared: PreparedGitHubPublicationIdentity = Object.freeze({
      source: identity.source,
      ...(managed ? { profileId: identity.config.profileId } : {}),
      host,
      account: probe.account,
      // Broker children and worker launches receive this fixed snapshot. Profile
      // retirement cannot redirect an already-admitted operation.
      env: Object.freeze(withGitHubToken(env, token)),
      ...(accessExpiresAtMs !== undefined ? { accessExpiresAtMs } : {}),
    });
    return { prepared, token, readToken };
  }, params);
}

/** Publication owns a fixed credential snapshot for its already-admitted operation. */
export async function prepareGitHubPublicationIdentity(
  params: GitHubIdentityPreparation,
): Promise<PreparedGitHubPublicationIdentity> {
  const { prepared } = await prepareSharedGitHubIdentity(params);
  if (!prepared) {
    throw new GitHubIdentityError("unavailable");
  }
  return prepared;
}

/** Options expose account facts only; publication obtains its own live credential. */
export async function prepareGitHubPublicationOptionsIdentity(
  params: GitHubIdentityPreparation & { assertCurrent?: () => void },
): Promise<Pick<PreparedGitHubPublicationIdentity, "source" | "account">> {
  const { prepared } = await prepareSharedGitHubIdentity(params, readCachedNativeGitHubToken);
  if (!prepared) {
    throw new GitHubIdentityError("unavailable");
  }
  return { source: prepared.source, account: prepared.account };
}

export function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation & { allowAnonymous: true },
): Promise<PreparedGitHubSourceReadIdentity>;
export function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation,
): Promise<PreparedGitHubReadIdentity>;
/** Read authority tracks current selection and token rotation, without exporting a child environment. */
export async function prepareGitHubReadIdentity(
  params: GitHubReadIdentityPreparation & { allowAnonymous?: boolean },
): Promise<PreparedGitHubSourceReadIdentity> {
  const selected = resolveGitHubToolIdentity(params);
  const { profileId, kind } = selected.source === "system-detected" ? {} : selected.config;
  const assertSelected = composeSessionSourceAssertion([
    captureExternalSessionCommitGuard(params.assertActive),
    () => {
      const current = resolveGitHubToolIdentity({ ...params, config: params.getCurrentConfig() });
      if (
        current.source !== selected.source ||
        (current.source !== "system-detected" &&
          (current.config.profileId !== profileId || current.config.kind !== kind))
      ) {
        reportGitHubIdentityRejection({
          diagnosticCode: "selection_changed",
          expectedSource: selected.source,
          currentSource: current.source,
          expectedProfileId: profileId,
          currentProfileId:
            current.source === "system-detected" ? undefined : current.config.profileId,
          expectedKind: kind,
          currentKind: current.source === "system-detected" ? undefined : current.config.kind,
        });
        throw new GitHubIdentityError("changed");
      }
    },
  ]);
  const caller = { assertCurrent: assertSelected, startCurrent: params.startActive };
  await startGitHubIdentityOperation(params.refresh, caller);
  assertSelected();
  const { token, readToken, prepared } = await prepareSharedGitHubIdentity(
    { ...params, ...caller },
    readCachedNativeGitHubToken,
    params.issuer,
    params.issuer ? resolveConfiguredGitHubApiBaseUrl() : undefined,
  );
  assertSelected();
  return createGitHubReadIdentity({
    assertSelected,
    startActive: params.startActive,
    readToken,
    ...(!prepared || token === undefined
      ? { token: undefined, selection: { source: "anonymous" as const } }
      : {
          token,
          selection: {
            source: selected.source,
            ...(profileId ? { profileId } : {}),
            accountId: prepared.account.accountId,
          },
        }),
  });
}

export async function removeManagedGitHubProfile(profileDir: string): Promise<void> {
  await fs.rm(profileDir, { recursive: true, force: true });
  clearNativeGitHubTokenCache();
}

async function verifyManagedGitHubCredential(
  token: string,
  issuer?: ManagedGitHubCredentialIssuer,
) {
  const credential = normalizeManagedGitHubToken(token);
  const verified = await verifyGitHubCredential(credential, {
    apiBaseUrl: issuer?.apiBaseUrl ?? GITHUB_PUBLIC_API_BASE_URL,
  });
  if (verified.status !== "available") {
    throw new Error("GitHub could not verify the managed credential.");
  }
  // Match gh's classic-token minimum scopes; other token types omit X-OAuth-Scopes.
  const scopes = verified.scopes;
  if (
    scopes.length &&
    (!scopes.includes("repo") ||
      !["read:org", "write:org", "admin:org"].some((scope) => scopes.includes(scope)))
  ) {
    throw new Error("GitHub credential is missing required repo or read:org scopes.");
  }
  return { account: verified.account, credential };
}

/** Verifies a rotated token, then atomically replaces credentials in one stable profile. */
export async function refreshManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  expectedAccountId: number;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  if (!(await isPrivateManagedGitHubProfile(params.profileDir))) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const { account, credential } = await verifyManagedGitHubCredential(params.token);
  params.assertCurrent?.();
  if (account.accountId !== params.expectedAccountId) {
    throw new GitHubAccountMismatchError("GitHub OAuth refresh returned a different account.");
  }
  const targetHosts = path.join(params.profileDir, "hosts.yml");
  const targetStat = await fs.lstat(targetHosts);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const profile = await fsRoot(params.profileDir);
  await profile.write(
    "hosts.yml",
    managedGitHubHosts({ login: account.login, token: credential }),
    {
      mode: 0o600,
      mkdir: false,
      durable: false,
      mutationSymlinks: "reject",
      assertBeforeMutation: params.assertCurrent,
    },
  );
  clearNativeGitHubTokenCache();
  params.assertCurrent?.();
  notifyManagedGitHubProfileChanged(params.profileDir);
  return account;
}

/** Publishes a new inactive profile and switches config without retiring in-use generations. */
export async function installManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  issuer?: ManagedGitHubCredentialIssuer;
  commitConfig: (account: GitHubToolAccount) => Promise<void>;
  retainProfileOnCommitFailure?: boolean;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  const parent = path.dirname(params.profileDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const stagingRoot = await fs.mkdtemp(path.join(parent, ".github-profile.staging-"));
  const stagedProfile = path.join(stagingRoot, "profile");
  let published = false;
  let committed = false;
  try {
    const { account, credential } = await verifyManagedGitHubCredential(
      params.token,
      params.issuer,
    );
    await writeManagedGitHubProfileFiles(stagedProfile, {
      login: account.login,
      token: credential,
      host: params.issuer?.host,
    });
    params.assertCurrent?.();
    await fs.rename(stagedProfile, params.profileDir);
    published = true;
    params.assertCurrent?.();
    await params.commitConfig(account);
    clearNativeGitHubTokenCache();
    committed = true;
    return account;
  } finally {
    if (published && !committed && !params.retainProfileOnCommitFailure) {
      await fs.rm(params.profileDir, { recursive: true, force: true });
    }
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
