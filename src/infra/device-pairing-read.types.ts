import type {
  BoundDeviceBootstrapContext,
  DeviceBootstrapBoundContextInput,
} from "./device-bootstrap.worker-types.js";
import type { DevicePairingPendingRequest, PairedDevice } from "./device-pairing.types.js";

export type DevicePairingReadCommand = {
  /** Reuse binding facts only when the caller owns this complete revision. */
  publishedRevision?: string;
} & (
  | { type: "devicePairing.list"; nowMs: number }
  | { type: "devicePairing.lookup"; deviceId: string }
  | { type: "devicePairing.pending"; requestId: string; nowMs: number }
  | {
      type: "devicePairing.bootstrapContext";
      input: DeviceBootstrapBoundContextInput;
    }
);

export type DevicePairingBinding = { identity: string; generation?: string };
export type DevicePairingBindingFact = {
  deviceId: string;
  binding: DevicePairingBinding | null;
  /** Absent on an older publication; null is a positively absent operator approval. */
  operatorIdentity?: string | null;
};
export type DevicePairingNodeSnapshot = {
  readonly paired: readonly PairedDevice[];
  readonly bindings: ReadonlyMap<string, DevicePairingBinding>;
};
export type DevicePairingReadReply = {
  ok: true;
  sourceAdmitted: true;
  revision: string;
  bindings: DevicePairingBindingFact[] | undefined;
  /** A new revision carries the complete binding index, even for a keyed read. */
  bindingsComplete?: boolean;
} & (
  | {
      type: "devicePairing.list";
      list: { pending: DevicePairingPendingRequest[]; paired: PairedDevice[] };
    }
  | { type: "devicePairing.lookup"; device: PairedDevice | null }
  | { type: "devicePairing.pending"; pending: DevicePairingPendingRequest | null }
  | { type: "devicePairing.bootstrapContext"; context: BoundDeviceBootstrapContext | null }
);

export type CloudWorkerSetupCompletionPublication = {
  environmentId: string;
  nodeDeviceId: string;
  updatedAtMs: number;
};

export type DevicePairingCommitReceipt = {
  kind: "devicePairing";
  beforeRevision: string;
  revision: string;
  changed: DevicePairingBindingFact[];
  tokensReplaced?: { deviceId: string; roles: string[] };
  workerEnvironment?: CloudWorkerSetupCompletionPublication;
};
