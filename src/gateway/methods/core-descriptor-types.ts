import type {
  GatewayMethodDescriptor,
  GatewayReadSharing,
  GatewayMethodScope,
  GatewayMethodSessionAccess,
} from "./descriptor.js";
export type CoreGatewayMethodSpec = Partial<GatewayReadSharing> & {
  name: string;
  family?: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  /** Audited to run under frozen read admission; read scope alone is insufficient. */
  suspendedReader?: true;
  lifetime?: GatewayMethodDescriptor["lifetime"];
  controlPlaneWrite?: true;
  compatibilityRestored?: true;
  description?: string;
  sessionAccess?: GatewayMethodSessionAccess;
};

type CoreGatewayMethodPolicy = Pick<
  CoreGatewayMethodSpec,
  | "shareKey"
  | "shareInvalidationEvents"
  | "shareMaxAgeMs"
  | "advertise"
  | "startup"
  | "suspendedReader"
  | "lifetime"
  | "controlPlaneWrite"
  | "compatibilityRestored"
  | "description"
  | "sessionAccess"
>;
export type CoreGatewayMethodSpecRow = readonly [
  name: string,
  family: string | null,
  scope: GatewayMethodScope,
  since: string,
  policy?: CoreGatewayMethodPolicy,
];
