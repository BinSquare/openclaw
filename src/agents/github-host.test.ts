import { describe, expect, it } from "vitest";
import {
  githubRepositoryUrl,
  resolveConfiguredGitHubApiBaseUrl,
  resolveConfiguredGitHubHost,
} from "./github-host.js";

describe("configured GitHub endpoints", () => {
  it("keeps the web host and API origin independent", () => {
    const config = { gateway: { github: { host: "  GHE.Example.Test  " } } };
    expect(resolveConfiguredGitHubHost(config)).toBe("ghe.example.test");
    expect(resolveConfiguredGitHubApiBaseUrl(config)).toBe("https://api.github.com");
    expect(githubRepositoryUrl("acme/project", resolveConfiguredGitHubHost(config))).toBe(
      "https://ghe.example.test/acme/project.git",
    );
    expect(resolveConfiguredGitHubHost()).toBe("github.com");
    expect(resolveConfiguredGitHubHost({ gateway: { github: { host: " " } } })).toBe("github.com");
  });

  it.each([
    [" https://API.GHE.Example.Test/ ", "https://api.ghe.example.test"],
    ["https://ghe.example.test/api/v3/", "https://ghe.example.test/api/v3"],
    ["https://ghe.example.test:8443/api/v3", "https://ghe.example.test:8443/api/v3"],
    [" ", "https://api.github.com"],
  ])("normalizes the independently configured API base %s", (apiBaseUrl, expected) => {
    expect(resolveConfiguredGitHubApiBaseUrl({ gateway: { github: { apiBaseUrl } } })).toBe(
      expected,
    );
  });

  it.each([
    "https://ghe.example.test",
    "ghe.example.test:8443",
    "a..example.test",
    "user@host",
    ".host",
    "host-",
  ])("rejects invalid repository host %s instead of selecting another host", (host) => {
    expect(() => resolveConfiguredGitHubHost({ gateway: { github: { host } } })).toThrow(
      "gateway.github.host must be a hostname",
    );
  });

  it.each([
    "http://ghe.example.test",
    "https://user:password@ghe.example.test",
    "https://ghe.example.test/api/v3/repos",
    "https://ghe.example.test/?token=value",
    "https://ghe.example.test/#fragment",
  ])("rejects unsafe API base %s without falling back to public GitHub", (apiBaseUrl) => {
    expect(() =>
      resolveConfiguredGitHubApiBaseUrl({ gateway: { github: { apiBaseUrl } } }),
    ).toThrow("gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL");
  });
});
