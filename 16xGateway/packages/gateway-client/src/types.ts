/* ============================================================================
 * @16xbrains/gateway-client — types.ts
 * A verbatim, read-only copy of the relevant slice of the 16xGateway contract
 * (src/types/index.ts §3). Re-exported from index.ts so consumers import ONLY
 * from this package.
 * ==========================================================================*/

export type PluginId = string;
export type SemVer = string;
export type RequestId = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject { [key: string]: JsonValue; }

export type FailureMode = "fail-closed" | "fail-open";

export type PolicyReasonCode =
  | "POL-EVAL" | "POL-FUNC-CTOR" | "POL-CTOR-ESCAPE" | "POL-REQUIRE" | "POL-IMPORT"
  | "POL-DYN-IMPORT" | "POL-PROTO" | "POL-WITH" | "POL-GLOBAL-PROC"
  | "POL-GLOBAL-THIS" | "POL-SHAPE" | "POL-SIZE" | "POL-PARSE";
export type RegistryReasonCode =
  | "REG-UNKNOWN" | "REG-REVOKED" | "REG-HASH-MISMATCH"
  | "REG-DUPLICATE" | "REG-BAD-ID" | "REG-BAD-VERSION";
export type TransportReasonCode = "GW-BADREQ" | "GW-PAYLOAD-TOO-LARGE";
export type ReasonCode = PolicyReasonCode | RegistryReasonCode | TransportReasonCode;
export type SandboxErrorCode = "SBX-THREW" | "SBX-OOM" | "SBX-RESULT-INVALID" | "SBX-INTERNAL";

export interface ResultMeta {
  requestId: RequestId;
  pluginId: PluginId;
  pluginVersion: SemVer | null;
  durationMs: number;
  sanitized: boolean;
  timestamp: string;
}
export interface SuccessResult<TOut extends JsonObject = JsonObject> extends ResultMeta {
  status: "success";
  data: TOut;
  unmasked: boolean;
}
export interface RejectedResult extends ResultMeta {
  status: "rejected";
  reasonCodes: ReasonCode[];
  message: string;
}
export interface TimeoutResult extends ResultMeta {
  status: "timeout";
  timeoutMs: number;
}
export interface PluginErrorResult extends ResultMeta {
  status: "plugin_error";
  errorCode: SandboxErrorCode;
  message: string;
}
export interface UnavailableResult {
  status: "unavailable";
  mode: FailureMode;
  passthrough?: JsonObject;
  message: string;
}
export type GatewayResult<TOut extends JsonObject = JsonObject> =
  | SuccessResult<TOut> | RejectedResult | TimeoutResult
  | PluginErrorResult | UnavailableResult;

export interface MtlsOptions { ca: string; cert: string; key: string; }

export interface GatewayClientOptions {
  socket?: string;
  host?: string;
  port?: number;
  mtls?: MtlsOptions;
  failureMode?: FailureMode;
  requestTimeoutMs?: number;
  connect?: { retries: number; baseDelayMs: number; maxDelayMs: number };
  breaker?: { threshold: number; cooldownMs: number };
}

export interface ExecuteOptions {
  pluginVersion?: SemVer;
  requestId?: RequestId;
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  contractVersion: string;
  uptimeSec: number;
  pluginsActive: number;
}
