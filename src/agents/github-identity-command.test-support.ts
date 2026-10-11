export function createGitHubCommandResult(stdout = "", code = 0, stderr = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

export const githubTestLookupId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const createGitHubLookupFrame = (stage: string, code: string, httpStatus?: number) =>
  JSON.stringify({
    event: "github_credential_lookup_client",
    lookupId: githubTestLookupId,
    stage,
    code,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  }) + "\n";
