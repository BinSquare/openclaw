import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  GITHUB_PUBLIC_HOST,
  normalizeGitHubApiBaseUrl,
  normalizeGitHubHost,
} from "../plugin-sdk/github-host.js";

export { GITHUB_PUBLIC_HOST, GITHUB_PUBLIC_API_BASE_URL } from "../plugin-sdk/github-host.js";

export const CLEARED_GITHUB_CREDENTIALS = {
  GH_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
};

export function withGitHubToken(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  };
}

export function resolveConfiguredGitHubHost(config?: OpenClawConfig | null): string {
  return normalizeGitHubHost(config?.gateway?.github?.host);
}

export function resolveConfiguredGitHubApiBaseUrl(config?: OpenClawConfig | null): string {
  return normalizeGitHubApiBaseUrl(config?.gateway?.github?.apiBaseUrl);
}

export function githubRepositoryUrl(
  repository: string,
  host = resolveConfiguredGitHubHost(),
): string {
  return `https://${host}/${repository}.git`;
}

export function isGitHubCloudHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === GITHUB_PUBLIC_HOST || normalized.endsWith(".ghe.com");
}
