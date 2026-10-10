/** Pure host syntax shared by Gateway identity and bundled GitHub readers, not credential authority. */
export const GITHUB_PUBLIC_HOST = "github.com";
export const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";

export function normalizeGitHubHost(value: string | undefined): string {
  const host = value?.trim().toLowerCase() || GITHUB_PUBLIC_HOST;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes("..")) {
    throw new Error("gateway.github.host must be a hostname");
  }
  return host;
}

export function normalizeGitHubApiBaseUrl(value: string | undefined): string {
  const parsed = new URL(value?.trim() || GITHUB_PUBLIC_API_BASE_URL);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error("gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL");
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}
