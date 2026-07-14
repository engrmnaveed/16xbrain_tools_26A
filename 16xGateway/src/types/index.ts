/* ============================================================================
 * 16xGateway — src/types/index.ts
 * IMMUTABLE CONTRACT v1.0.0 — changes require architect sign-off + version bump.
 * Compiler assumptions: "strict": true, ESM ("module": "node16").
 * ==========================================================================*/

export const CONTRACT_VERSION = "1.0.0" as const;

/* ------------------------------- scalars --------------------------------- */

export type PluginId = string;      // must match /^[a-z0-9][a-z0-9_-]{1,63}$/
export type SemVer = string;        // strict x.y.z (numeric only)
export type Sha256Hex = string;     // 64 lowercase hex chars
export type IsoTimestamp = string;  // ISO-8601 UTC
export type RequestId = string;     // UUID v4
export type TokenString = string;   // matches /^\[TOKEN_MASK_SHA256_[0-9a-f]{6,32}\]$/

/* --------------------------------- JSON ---------------------------------- */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject { [key: string]: JsonValue; }

/* ------------------------------ configuration ---------------------------- */

export type FailureMode = "fail-closed" | "fail-open";
export type PolicyLevel = "strict" | "standard";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface GatewayConfig {
  gateway: {
    port: number;                      // TCP loopback port; 0 disables TCP entirely
    socket: string;                    // absolute UDS path, e.g. /var/run/16xgateway.sock
    environment: "production" | "staging" | "development";
    secretKey: string;                 // HMAC key for tokenization; min 32 chars
  };
  security: {
    maskPii: true;                     // literal true — bypass is unrepresentable (D6)
    allowedOutboundDomains: string[];  // exact hostnames; "*.example.com" allows subdomains
    maxMemoryMb: number;               // default 128 — hard isolate ceiling
    timeoutMs: number;                 // default 3000 — wall-clock per invocation
    onGatewayUnavailable: FailureMode; // default "fail-closed" (advisory to clients)
    unmaskResponse: boolean;           // default true  (D8)
    rescanOutput: boolean;             // default true  — re-scan plugin output for raw PII
    maxPayloadBytes: number;           // default 1_048_576
    maxResultBytes: number;            // default 1_048_576
    tokenHexLength: number;            // 6..32, default 12 (D3)
    policyLevel: PolicyLevel;          // default "strict"
    adminToken: string | null;         // null → admin routes answer over UDS only
  };
  sandbox: {
    isolatePoolPerPlugin: number;      // default 2
    recycleAfterInvocations: number;   // default 500 (D10)
  };
  logging: {
    level: LogLevel;                   // default "info"
    auditFile: string | null;          // append-only JSONL; null disables
  };
}

/* ---------------------------- request / response ------------------------- */

export interface ExecuteRequestEnvelope {
  pluginId: PluginId;
  payload: JsonObject;
  requestId?: RequestId;               // generated server-side if absent
  pluginVersion?: SemVer;              // default: highest 'active' version
}

export interface ResultMeta {
  requestId: RequestId;
  pluginId: PluginId;
  pluginVersion: SemVer | null;        // null when resolution itself failed
  durationMs: number;
  sanitized: boolean;                  // always true (maskPii is literal true)
  timestamp: IsoTimestamp;
}

export interface SuccessResult<TOut extends JsonObject = JsonObject> extends ResultMeta {
  status: "success";
  data: TOut;
  unmasked: boolean;                   // true when unmaskResponse restored real values
}
export interface RejectedResult extends ResultMeta {
  status: "rejected";
  reasonCodes: ReasonCode[];           // never empty
  message: string;
}
export interface TimeoutResult extends ResultMeta {
  status: "timeout";
  timeoutMs: number;
}
export interface PluginErrorResult extends ResultMeta {
  status: "plugin_error";
  errorCode: SandboxErrorCode;
  message: string;                     // sanitized — never raw PII, never a stack with paths
}
/** Synthesized CLIENT-SIDE only; the gateway never emits it (it was unreachable). */
export interface UnavailableResult {
  status: "unavailable";
  mode: FailureMode;
  passthrough?: JsonObject;            // present iff mode === "fail-open": the ORIGINAL payload
  message: string;
}

export type GatewayResult<TOut extends JsonObject = JsonObject> =
  | SuccessResult<TOut> | RejectedResult | TimeoutResult
  | PluginErrorResult | UnavailableResult;

/* ------------------------------ reason codes ------------------------------ */

export type PolicyReasonCode =
  | "POL-EVAL"          // eval referenced in any position
  | "POL-FUNC-CTOR"     // Function / AsyncFunction / GeneratorFunction constructor
  | "POL-CTOR-ESCAPE"   // .constructor(...) call or computed ['constructor'] access (strict)
  | "POL-REQUIRE"       // require() outside allowlist, or non-literal argument
  | "POL-IMPORT"        // any ESM import/export declaration (plugins are CJS)
  | "POL-DYN-IMPORT"    // import(...)
  | "POL-PROTO"         // __proto__ / setPrototypeOf / .prototype assignment
  | "POL-WITH"          // with statement
  | "POL-GLOBAL-PROC"   // identifier 'process'
  | "POL-GLOBAL-THIS"   // identifier 'globalThis' (strict)
  | "POL-SHAPE"         // not exactly one definePlugin() assigned to module.exports
  | "POL-SIZE"          // source exceeds 512 KiB
  | "POL-PARSE";        // syntax error

export type RegistryReasonCode =
  | "REG-UNKNOWN" | "REG-REVOKED" | "REG-HASH-MISMATCH"
  | "REG-DUPLICATE" | "REG-BAD-ID" | "REG-BAD-VERSION";

export type TransportReasonCode = "GW-BADREQ" | "GW-PAYLOAD-TOO-LARGE";

export type ReasonCode = PolicyReasonCode | RegistryReasonCode | TransportReasonCode;

export type SandboxErrorCode = "SBX-THREW" | "SBX-OOM" | "SBX-RESULT-INVALID" | "SBX-INTERNAL";

/* -------------------------------- sanitizer ------------------------------- */

export type PiiCategory =
  | "email" | "phone" | "ssn" | "national_id" | "credit_card"
  | "api_key" | "bearer_token" | "sensitive_key";

export interface PiiPattern {
  category: PiiCategory;
  pattern: RegExp;                     // 'g' flag; linear-time discipline: no nested
                                       // quantifiers, no backreferences, no lookbehind
  priority: number;                    // lower wins on overlap ties
  validate?: (match: string) => boolean; // e.g. Luhn for credit_card
}

/** NOTE: deliberately contains no field for the raw matched value. */
export interface SanitizationMatch {
  category: PiiCategory;
  token: TokenString;
  jsonPath: string;                    // e.g. "$.customer.email" or "$.items[2].note"
}

export interface ReverseMap {
  readonly size: number;
  readonly destroyed: boolean;
  /** Deep-replaces every known token with its original value. Throws if destroyed. */
  restore<T extends JsonValue>(value: T): T;
  /** Idempotent. After this, restore() throws and originals are unreachable. */
  destroy(): void;
}

export interface SanitizationPass {
  requestId: RequestId;
  sanitizedPayload: JsonObject;
  matches: SanitizationMatch[];
  reverseMap: ReverseMap;
}

export interface Sanitizer {
  sanitize(payload: JsonObject, requestId: RequestId): SanitizationPass;
  /** Detection-only scan (used for rescanOutput). Returns categories + spans, no values. */
  scan(text: string): Array<{ category: PiiCategory; start: number; end: number }>;
}

/* --------------------------------- policy --------------------------------- */

export interface PolicyViolation {
  code: PolicyReasonCode;
  message: string;
  line: number | null;
  column: number | null;
}

export interface PolicyResult {
  ok: boolean;                         // ok === (violations.length === 0)
  policyLevel: PolicyLevel;
  scannedBytes: number;
  parseTimeMs: number;
  violations: PolicyViolation[];
}

export interface PolicyScanner {
  scan(source: string, level: PolicyLevel): PolicyResult;
}

/* -------------------------------- sandbox --------------------------------- */

export interface CapabilityFetchRequest {
  url: string;                         // https only
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}
export interface CapabilityFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;                        // capped at 1 MiB
}

export interface HostCapabilities {
  /** Host-side execution. Rejects (thrown inside plugin) when domain not allowlisted. */
  fetch(req: CapabilityFetchRequest): Promise<CapabilityFetchResponse>;
  log(level: LogLevel, message: string): void;
}

export interface SandboxOptions {
  memoryLimitMb: number;
  timeoutMs: number;
  capabilities: HostCapabilities;
}

export type SandboxRunOutcome =
  | { ok: true;  data: JsonObject; durationMs: number }
  | { ok: false; kind: "timeout"; durationMs: number }
  | { ok: false; kind: "error"; errorCode: SandboxErrorCode; message: string; durationMs: number };

export interface SandboxInstance {
  readonly id: string;
  readonly pluginId: PluginId;
  readonly pluginVersion: SemVer;
  readonly invocations: number;
  readonly disposed: boolean;
  run(payload: JsonObject, requestId: RequestId): Promise<SandboxRunOutcome>;
  dispose(): Promise<void>;            // idempotent
}

export interface SandboxProvider {
  create(pluginSource: string, pluginId: PluginId, pluginVersion: SemVer,
         options: SandboxOptions): Promise<SandboxInstance>;
}

/** Pool-managing facade consumed by the pipeline (Task 4 depends on this, not on ivm). */
export interface SandboxService {
  run(pluginSource: string, pluginId: PluginId, pluginVersion: SemVer,
      payload: JsonObject, requestId: RequestId,
      capabilities: HostCapabilities): Promise<SandboxRunOutcome>;
  disposeAll(): Promise<void>;
}

/* -------------------------------- registry -------------------------------- */

export type PluginStatus = "active" | "revoked";

export interface PluginRegistryEntry {
  id: PluginId;
  version: SemVer;
  sha256: Sha256Hex;                   // of the exact stored source bytes
  sizeBytes: number;
  status: PluginStatus;
  admittedAt: IsoTimestamp;
  admittedBy: string;
  policyReport: PolicyResult;
  sourcePath: string;                  // plugins/<id>/<version>/plugin.cjs
  revokedAt?: IsoTimestamp;
  revokedReason?: string;
}

export type AdmissionResult =
  | { admitted: true;  entry: PluginRegistryEntry }
  | { admitted: false; reasonCodes: ReasonCode[]; policyReport?: PolicyResult };

export interface PluginRegistry {
  admit(source: string, id: PluginId, version: SemVer, admittedBy: string): Promise<AdmissionResult>;
  /** Exact version, or highest 'active' semver when version omitted. Null = unknown or revoked. */
  resolve(id: PluginId, version?: SemVer): Promise<PluginRegistryEntry | null>;
  revoke(id: PluginId, version: SemVer, reason: string): Promise<boolean>;
  list(): Promise<PluginRegistryEntry[]>;
  /** Re-hashes stored source; throws Error with .code = "REG-HASH-MISMATCH" on tamper. */
  loadVerifiedSource(entry: PluginRegistryEntry): Promise<string>;
  /** Re-reads the on-disk store (cross-worker revocation propagation). */
  reload(): Promise<void>;
}

/* --------------------------- plugin authoring ----------------------------- */

export interface PluginMeta {
  requestId: RequestId;
  pluginId: PluginId;
  pluginVersion: SemVer;
  invokedAt: IsoTimestamp;
}

export interface PluginContext {
  fetch: HostCapabilities["fetch"];
  log: HostCapabilities["log"];
  meta: PluginMeta;
}

export type PluginHandler<TIn extends JsonObject = JsonObject,
                          TOut extends JsonObject = JsonObject> =
  (payload: TIn, ctx: PluginContext) => TOut | Promise<TOut>;

export interface PluginDefinition<TIn extends JsonObject = JsonObject,
                                  TOut extends JsonObject = JsonObject> {
  id: PluginId;
  version: SemVer;
  description?: string;
  handler: PluginHandler<TIn, TOut>;
}

/* ------------------------------ client SDK -------------------------------- */

export interface MtlsOptions { ca: string; cert: string; key: string; }  // PEM contents

export interface GatewayClientOptions {
  socket?: string;                     // UDS path (preferred); exactly one of socket | host
  host?: string;                       // requires port; loopback or mTLS deployments
  port?: number;
  mtls?: MtlsOptions;
  failureMode?: FailureMode;           // default "fail-closed"
  requestTimeoutMs?: number;           // default 5000 (≥ server timeoutMs + overhead)
  connect?: { retries: number; baseDelayMs: number; maxDelayMs: number }; // 5 / 100 / 5000
  breaker?: { threshold: number; cooldownMs: number };                    // 5 / 10000
}

export interface ExecuteOptions {
  pluginVersion?: SemVer;
  requestId?: RequestId;
}

export interface HealthStatus {
  ok: boolean;
  version: string;                     // gateway build version
  contractVersion: string;             // CONTRACT_VERSION
  uptimeSec: number;
  pluginsActive: number;
}
