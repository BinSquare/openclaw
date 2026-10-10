import type { resolveSandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexPairedNodeRemoteExecPlacementSandbox,
  isCodexRemoteExecPlacementSandbox,
} from "./config-parsing.js";

type CodexExecutionTarget = Awaited<ReturnType<typeof resolveSandboxContext>> | undefined;

export type CodexExecutionPlan = Readonly<{
  /** Default client ownership; explicit client factories remain caller-selected. */
  appServer: "shared" | "isolated" | "worker";
  remoteExec: boolean;
  requiresSandboxExecServer: (tools: {
    nativeToolSurfaceEnabled: boolean;
    sandboxExecServerEnabled: boolean;
  }) => boolean;
}>;

/** Selection facts only: transports still own exact placement and live-authority checks. */
export function resolveCodexExecutionPlan(params: {
  pluginConfig?: { appServer?: { workerHostedCloud?: boolean } };
  /** Discovery selects a prospective paired node; attempts supply the resolved sandbox. */
  target: CodexExecutionTarget | "paired-node";
}): CodexExecutionPlan {
  const sandbox = params.target === "paired-node" ? undefined : params.target;
  const sandboxEnabled = Boolean(sandbox?.enabled);
  const pairedNode =
    params.target === "paired-node" || isCodexPairedNodeRemoteExecPlacementSandbox(sandbox);
  const remoteExec = pairedNode || isCodexRemoteExecPlacementSandbox(sandbox);
  const appServer = pairedNode
    ? params.pluginConfig?.appServer?.workerHostedCloud === true
      ? "worker"
      : "isolated"
    : "shared";
  return {
    appServer,
    remoteExec,
    // Worker-hosted inference uses the worker's native filesystem. Remote tool
    // execution with a non-worker app-server instead needs an exec-server.
    requiresSandboxExecServer: ({ nativeToolSurfaceEnabled, sandboxExecServerEnabled }) =>
      appServer !== "worker" &&
      (remoteExec || (sandboxEnabled && nativeToolSurfaceEnabled && sandboxExecServerEnabled)),
  };
}
