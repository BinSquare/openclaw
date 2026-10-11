import type { MockInstance, vi } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { installFactoryRestartRepositoryFixture } from "../../agents/main-session-recovery/main-session-recovery-factory-read.test-support.js";
import type { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import type { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { WorkerProvider } from "../../plugins/types.js";
import type { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { createNodeRegistryRuntime } from "../node-registry-private.js";
import type * as reclaimOwner from "../server-worker-placement-reclaim.js";
import type { createGatewayWorkerPlacementRuntime } from "../server-worker-placement-startup.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";
import type { createWorkerSessionPlacementStore } from "./placement-store.js";
import type { createWorkerEnvironmentService } from "./service.js";
import type { createWorkerEnvironmentStore } from "./store.js";

export type WorkerLifecycleOptions = {
  executionMode?: WorkerPlacementExecutionMode;
  setupScript?: string;
  branch?: string;
  additionalBranch?: string;
  defaultBranch?: string;
  absentGatewayWorkspace?: boolean;
  admin?: boolean;
  afterShutdown?: (state: OpenClawTestState) => Promise<void>;
};

type WorkerRepositorySession = {
  identity: { agentId: string; sessionKey: string; sessionId: string };
  repositoryId: string;
  rpc: <R = Record<string, unknown>>(method: string, params: unknown) => Promise<R>;
};

export type WorkerLifecycle = {
  rpc: WorkerRepositorySession["rpc"];
  observerRpc: WorkerRepositorySession["rpc"];
  observerConnectionId: string;
  sourceCommit: (branch: string) => string;
  sourceTree: (branch: string) => {
    sha: string;
    truncated: false;
    tree: { path: string; mode: string; type: string; sha: string }[];
  };
  createRepositorySession: (choice: {
    key: string;
    ref?: string;
    worktree: boolean;
  }) => Promise<WorkerRepositorySession>;
  issuer: Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
  metadataRequests: ReturnType<typeof installFactoryRestartRepositoryFixture>["fetchFixture"];
  readonly credentialProofCount: number;
  revokeAtNextCredentialLookup: () => void;
  harnessAttempts: MockInstance<AgentHarness["runAttempt"]>;
  launchNodeWorker: MockInstance<() => Promise<never>>;
  workspaceSyncs: {
    prepared: boolean;
    selectedGitCredential: boolean;
    runSetupScript: boolean | undefined;
    baseCommit: string | undefined;
    hasCheckpoint: boolean;
  }[];
  environments: ReturnType<typeof createWorkerEnvironmentService>;
  environmentStore: Awaited<ReturnType<typeof createWorkerEnvironmentStore>>;
  placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  reclaimBarriers: ReturnType<typeof reclaimOwner.createGatewayWorkerPlacementReclaimBarriers>;
  transport: ReturnType<typeof createNodeRegistryRuntime>["nodeWorkerSupervisorTransport"];
  availability: ReturnType<
    typeof vi.fn<
      (id: string) => Promise<{
        available: boolean;
        node: Awaited<ReturnType<WorkerLifecycle["transport"]["getCurrentNode"]>>;
      }>
    >
  >;
  provider: WorkerProvider;
  prepareInstallation: MockInstance<
    Parameters<typeof createWorkerEnvironmentService>[0]["prepareInstallation"]
  >;
  build: {
    nodeBootstrapSha256: string;
    bundleHash: string;
    openclawVersion: string;
    protocolFeatures: string[];
  };
  setHostingAvailable: (nodeId: string, enabled: boolean, reconnect?: boolean) => Promise<void>;
  losePreparedRegistration: (environmentId: string) => void;
  preparePresence: (
    kind?: "image" | "repository",
    readyWorkers?: number,
    mode?: WorkerPlacementExecutionMode,
  ) => Promise<ReturnType<Awaited<ReturnType<typeof createWorkerEnvironmentStore>>["list"]>>;
  identity: { agentId: string; sessionKey: string; sessionId: string };
  repositoryId: string;
  originalCommit: string;
  advancePublishedBranch: () => Promise<string>;
  issuerProfileId: string;
  readEntry: () => ReturnType<typeof loadSessionEntry>;
  readRepository: () => ReturnType<ReturnType<typeof getSessionRepositoryWorkspaceStore>["get"]>;
  readPlacement: () => ReturnType<ReturnType<typeof createWorkerSessionPlacementStore>["get"]>;
  dispatch: (
    options?: {
      repositoryReadiness?: boolean;
      runSetupScript?: boolean;
    },
    selected?: WorkerRepositorySession,
  ) => ReturnType<
    ReturnType<typeof createGatewayWorkerPlacementRuntime>["dispatchService"]["dispatch"]
  >;
  runEffect: (
    runId: string,
    text?: string,
    previous?: string,
    selected?: WorkerRepositorySession,
  ) => Promise<unknown>;
  readonly reconcileCount: number;
  reclaim: () => ReturnType<
    ReturnType<typeof createGatewayWorkerPlacementRuntime>["dispatchService"]["reclaim"]
  >;
  recover: () => Promise<void>;
  pendingResults: () => ReturnType<
    ReturnType<typeof createWorkerSessionPlacementStore>["listPendingWorkspaceResultsAsync"]
  >;
  destroyedLeases: readonly string[];
  assertIssuerCurrent: () => void;
  revokeIssuer: () => Promise<unknown>;
  stop: () => Promise<void>;
};
