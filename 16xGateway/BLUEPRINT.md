# 16xGateway — Master Blueprint

**Contract version:** 1.0.0 · **Status:** LOCKED — downstream models implement against this document; changes require architect sign-off and a version bump.
**Scope of this document:** design + contracts + delegation. No implementation code exists yet; everything below is normative spec.

---

## 0. Locked Architectural Decisions

Every ambiguity in the brief is resolved here. Subordinate models must treat these as immutable.

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Sandbox runtime: `isolated-vm`**, not Worker Threads | See §0.1. The sandbox interface (`SandboxProvider`) is abstracted so a process-based runtime can replace it later without touching any other module. |
| **D2** | **Wire protocol: HTTP/1.1 over Unix domain socket** (Fastify `listen({ path })`); optional TCP `127.0.0.1` + mTLS for split-host | Debuggable (`curl --unix-socket`), zero custom framing, identical code path for UDS and mTLS modes. Never binds a public interface. |
| **D3** | **Token format: `[TOKEN_MASK_SHA256_{hex}]`** where hex = first `tokenHexLength` (default 12) chars of **HMAC-SHA256(secretKey, value)** | Deterministic per deployment → referential integrity preserved (same email → same token, so plugins can still group/join). HMAC (not bare SHA-256) prevents dictionary reversal. Brief's 6-char example is illustrative; 12 is the default to shrink collision odds; on prefix collision within a request the hex is extended by 4 chars until unique. |
| **D4** | **AST parser: `acorn`** (single, zero-dependency, battle-tested) | A hand-rolled JS parser is a security liability, not a purity win. This is the one deliberate exception to zero-dep besides fastify/isolated-vm/undici. |
| **D5** | **Fail-closed default.** Fail-open is a client-side mode meaning "return the ORIGINAL payload to the host with `status:'unavailable'` + `passthrough`" | Fail-open never means "run the plugin without sanitization" — that path is unrepresentable. It means the host proceeds without the plugin's transformation. Nothing ever reaches a third party unsanitized. |
| **D6** | **`security.maskPii` is typed as literal `true`** | A bypass flag is made unrepresentable in the type system, per §4.2 "no bypass flag". |
| **D7** | **Outbound network = capability-based.** The isolate contains no network API at all; the gateway injects `ctx.fetch`, executed host-side against the domain allowlist | Deny-by-absence (allowlist) instead of deny-by-patching (blocklist). Off-list calls throw inside the plugin and are audit-logged. |
| **D8** | **`security.unmaskResponse` default `true`** — the gateway restores real values before the envelope returns to the host | Resolves the brief's internal tension: §2 says "re-inject real values on the return trip", while §8's sample response shows a masked email. Ruling: production default restores values (zero business-logic change for the host); the §8 sample reflects `unmaskResponse:false`, which the demo uses deliberately *to show tokenization working*. |
| **D9** | **Toolchain:** TypeScript strict + ESM, npm workspaces monorepo, `node:test` runner, Node ≥ 20 LTS pinned exactly in CI. Runtime deps locked to exactly: `fastify`, `acorn`, `isolated-vm`, `undici` (client SDK only) | Native test runner keeps the dep tree auditable — this is a security product; every dependency is attack surface. |
| **D10** | **Isolate pooling: long-lived isolate per plugin, fresh V8 *context* per invocation**; isolate recycled after `recycleAfterInvocations` (default 500) or after any error/timeout/OOM | Fresh context guarantees zero cross-request state leakage; reusing the isolate + compiled script keeps p50 latency low. Contexts within one isolate share no objects. |
| **D11** | **Plugin delivery format: single CommonJS file**; only permitted `require` is `'@16xbrains/plugin-sdk'` (shimmed inside the isolate); must call `definePlugin()` exactly once and assign it to `module.exports` | Gives agencies a normal authoring experience (the SDK import works in their editor and local harness) while the isolate never performs real module resolution. Enforced by AST rule `POL-SHAPE`. |
| **D12** | **Core engine package is `@16xbrains/gateway-core`** with subpath exports (`./policy`, `./sandbox`) so the plugin-sdk CLI can run the *real* gate and *real* sandbox locally | The agency's local `16xgateway check` is not a simulation — identical code path to production admission. |

### 0.1 D1 in full: `isolated-vm` vs hardened Worker Threads

| Criterion | `isolated-vm` | Worker Threads |
|---|---|---|
| API surface inside sandbox | **ECMAScript intrinsics only.** No `require`, no `process`, no `fs`, no net, no timers unless explicitly injected | **Entire Node API.** `require('fs')`, `require('net')`, `process.env` all work unless removed |
| Hardening model | **Allowlist** — capability exists only if the host injects it | **Blocklist** — delete/patch globals and hope nothing re-acquires them (module internals, `process.binding`, loader hooks make this a losing game) |
| `process.env` | Does not exist | Copied in by default; `env: {}` helps but `process` object remains |
| Memory ceiling | Hard per-isolate `memoryLimit`; V8 kills the isolate | `resourceLimits` exists but granularity is coarser and the worker shares the process fate on some OOM paths |
| Timeout | Native sync `timeout` on `run()`; async covered by external wall-clock + `isolate.dispose()` | Only external termination (`worker.terminate()`), racy vs sync-blocking code |
| Cost | Native module: node-gyp build, pinned Node versions, upstream is in maintenance mode | Zero install friction |

**Ruling:** the brief's hard requirement — *no* env, fs, module graph, or network — is an allowlist requirement. Worker Threads can only approximate it with a blocklist, which is exactly the "clever over explicit" failure mode we reject. `isolated-vm` wins. Mitigations for its costs: pin Node LTS exactly, verify the native binary checksum at install, wrap everything behind `SandboxProvider` so a `child_process` + seccomp runtime can be substituted in v2 without touching the pipeline. The maintenance-mode risk is acknowledged in `docs/security-model.md` (§1.4).

---

## 1. System Design Spec

### 1.1 End-to-end data flow

```
 HOST APP                         GATEWAY ENGINE (one PM2 worker)                    ISOLATE
 ────────                         ───────────────────────────────                    ───────
 gateway.execute(id, payload)
   │  ExecuteRequestEnvelope
   ▼
 [SDK] ──HTTP/1.1 over UDS──▶ (1) validate envelope + size caps
                              (2) registry.resolve(id, version?)   ──unknown/revoked──▶ rejected
                              (3) sanitizer.sanitize(payload)
                                    ├─ sanitizedPayload  (tokens)
                                    └─ reverseMap        (request-scoped, in-memory)
                              (4) sandboxService.run(...) ─────────────────────────▶ handler(
                                    memory ceiling · wall-clock timeout                sanitizedPayload,
                                    fresh context · capability bridge                  ctx { fetch, log, meta })
                              (5) outcome mapping                  ◀───────────────── JSON result
                                    timeout → TimeoutResult · OOM/throw → PluginErrorResult
                              (6) result validation (JSON-only, ≤ maxResultBytes)
                              (7) rescanOutput: re-scan result for raw PII (defense in depth)
                              (8) unmaskResponse: reverseMap.restore(result)
                              (9) finally: reverseMap.destroy()    ← runs on EVERY path
   ◀──────────────────────── GatewayResult envelope
 [SDK] maps socket/connect failures → UnavailableResult (never a thrown string)
```

Step order is normative. Sanitization (3) precedes sandbox invocation (4) unconditionally — there is no code path from (2) to (4). Reverse-map destruction (9) is a `finally` obligation covering success, timeout, error, and rejection paths.

### 1.2 Component responsibilities

| Path | Responsibility | Built by |
|---|---|---|
| `src/config/` | Load + strictly validate `gateway.config.json`, apply defaults, fail fast | Task 4 |
| `src/sanitizer/` | Compiled PII patterns, HMAC tokenizer, request-scoped reverse map | Task 1 |
| `src/sandbox/` | `isolated-vm` provider, memory/timeout guards, capability bridge, pooling | Task 2 |
| `src/policy/` | acorn AST scan, violation reason codes, strict/standard levels | Task 3 |
| `src/registry/` | Admission (gate → hash → persist), version resolution, revocation, hash re-verify | Task 3 |
| `src/core/` + `src/server.ts` | Pipeline orchestration (§1.1), capabilities, audit log, Fastify entrypoint | Task 4 |
| `packages/gateway-client` | Host SDK: lazy connect, backoff, circuit breaker, typed results, middleware/events adapters | Task 5 |
| `packages/plugin-sdk` | `definePlugin`, types, `16xgateway check` local harness CLI | Task 5 |
| `examples/`, `docs/` | Demo CRM + good/hostile plugins, four audience-scoped guides | Task 6 |

### 1.3 Failure semantics matrix (normative)

| Condition | Detected by | Result `status` | Detail | Host app experience |
|---|---|---|---|---|
| Gateway process down / socket absent | SDK connect failure | `unavailable` | `mode:'fail-closed'` → no payload echo; `mode:'fail-open'` → `passthrough` = original payload | Branch on `status`; never a throw |
| Circuit breaker open | SDK, locally | `unavailable` | fast-fail, no socket attempt | Same as above, sub-ms |
| Malformed envelope / payload > `maxPayloadBytes` | server validation | `rejected` | `GW-BADREQ` / `GW-PAYLOAD-TOO-LARGE` | Programmer error; fix call site |
| Plugin unknown | registry | `rejected` | `REG-UNKNOWN` | |
| Plugin revoked | registry | `rejected` | `REG-REVOKED` | Takes effect without host or gateway restart |
| Stored source fails hash re-verify | registry | `rejected` | `REG-HASH-MISMATCH` | Tamper alarm; audit-logged |
| Execution exceeds `timeoutMs` | sandbox wall-clock + ivm timeout | `timeout` | isolate disposed, replaced from pool | Retryable by host policy |
| Memory ceiling breach | ivm memory kill | `plugin_error` | `SBX-OOM`; isolate disposed | Not retryable — report to agency |
| Plugin throws | sandbox | `plugin_error` | `SBX-THREW` + sanitized message | |
| Result non-JSON or > `maxResultBytes` | pipeline step 6 | `plugin_error` | `SBX-RESULT-INVALID` | |
| AST gate rejects at **admission** | policy scanner | admission API returns `admitted:false` + `POL-*` codes | Never reaches runtime — plugin is not in the registry, so `execute` sees `REG-UNKNOWN` | |

Admission-time rejection is the product demo: the hostile plugin produces a `PolicyResult` with reason codes and **zero execution**.

**Fail-open, precisely (D5):** configured on the *client* (`failureMode`), defaulted from server config intent `onGatewayUnavailable: 'fail-closed'`. Fail-open applies **only** to the `unavailable` status — a `rejected` or `plugin_error` is never converted to a passthrough, because those signal that the gateway is alive and made a security decision.

### 1.4 Threat model (source for `docs/security-model.md` — keep the honesty)

**Defends against:** careless or hostile plugin code attempting `process.env` / fs / network / module-graph access (absent from the isolate); raw PII exposure to third-party code (tokenized before entry, per-request reverse map); prototype-pollution and eval-family injection (AST gate + isolate boundary); runaway loops and allocation bombs (wall-clock timeout + hard memory ceiling, kill-and-report); tampered plugin files at rest (hash re-verification on every cold load); exfiltration via network (no egress primitive exists; capability fetch is allowlisted, size-capped, redirect-checked).

**Does NOT defend against — state these verbatim in the docs:**

1. **V8 isolate escape (0-day).** An escape lands in the gateway process, which holds in-flight reverse maps and the HMAC secret. Mitigations: per-request maps with immediate destruction, minimal in-flight window, defense-in-depth via the AST gate. Roadmap: split-process sandbox behind `SandboxProvider`.
2. **PII regex false negatives.** Detection is heuristic. Unusual formats, PII embedded in free prose, non-Latin phone conventions, numeric-typed values (only strings are scanned) can slip through. 16xGateway is not a DLP system and must not be sold as one.
3. **Determined obfuscation vs the AST gate.** The gate is supply-chain hygiene and fast feedback; the *isolate* is the actual boundary. A plugin that passes the gate still cannot reach env/fs/net.
4. **Exfiltration to allowlisted domains.** Domains in `allowedOutboundDomains` are trusted by configuration. A hostile plugin may send (tokenized) data there. Keep the allowlist empty unless required.
5. **Timing/side channels, malicious host app, or a compromised gateway box.** Out of scope; the gateway trusts its own host machine.
6. **`isolated-vm` maintenance-mode risk.** Upstream is minimally maintained; we pin Node exactly and treat sandbox-runtime replacement as a supported migration (D1).

### 1.5 Deployment viability (§10 check)

The PM2 + Caddy path works, with three flags:

1. **Caddy as written breaks §4.4.** `reverse_proxy localhost:4040` publicly exposes `/v1/execute`. Correction (goes in `docs/operations.md`): single-box deployments need no Caddy at all (UDS only, don't bind the TCP port); if Caddy is used, expose only `GET /healthz` and require client certificates for anything else. Admin routes additionally answer only over UDS (or with `adminToken`).
2. **UDS + `pm2 -i max` cluster mode:** Node's cluster module shares a UDS listener via the master — fine — but stale-socket unlink must happen once, guarded (connect-test the socket before unlinking). Ship an `ecosystem.config.cjs` with `wait_ready: true`, `kill_timeout ≥ security.timeoutMs + 2000` so in-flight isolates drain on reload.
3. **Revocation across cluster workers:** the registry file is on disk; each worker watches `plugins/registry.json` mtime and reloads its cache, so a revoke propagates to all workers without restart.
4. **`isolated-vm` needs a compiler toolchain** (`build-essential`, Python) on the VPS, or a prebuilt binary with checksum verification. Document in ops guide.

`pm2 start dist/server.js -i max` is otherwise viable; the server calls `process.send('ready')` after the socket is listening.

---

## 2. Integration Contract

### 2.1 Host SDK — `@16xbrains/gateway-client` (frozen public API)

```ts
import { Gateway } from "@16xbrains/gateway-client";

const gateway = new Gateway({ socket: "/var/run/16xgateway.sock" });

const result = await gateway.execute("outsourced-analytics", customerRecord);

if (result.status === "success") {
  save(result.data);                      // real values already restored (D8)
} else if (result.status === "unavailable" && result.passthrough) {
  save(result.passthrough);               // fail-open: proceed without enrichment
} else {
  metrics.count(`gateway.${result.status}`);
}
```

**Class surface (complete — nothing else is public):**

```ts
class Gateway {
  constructor(options: GatewayClientOptions);
  execute<TIn extends JsonObject, TOut extends JsonObject>(
    pluginId: string, payload: TIn, options?: ExecuteOptions
  ): Promise<GatewayResult<TOut>>;
  health(): Promise<HealthStatus>;
  close(): Promise<void>;
}
// subpath exports:
//   "@16xbrains/gateway-client/middleware" → gatewayMiddleware(...)  (pattern 2)
//   "@16xbrains/gateway-client/events"     → attachGatewayConsumer(...) (pattern 3)
```

**Connection lifecycle.** Lazy connect on first `execute()`; undici `Pool` over `socketPath` with keep-alive (default 4 connections). Reconnect: exponential backoff, base 100 ms, factor 2, full jitter, cap 5 s. Circuit breaker: 5 consecutive connect failures open the breaker for 10 s; while open, `execute()` returns `unavailable` in sub-millisecond time; one half-open probe closes it. `close()` drains and destroys the pool.

**Failure semantics.** Operational failures **never throw** — every outcome is a `GatewayResult` discriminated on `status` (§3). Only programmer misuse (non-string `pluginId`, non-object payload) throws `TypeError` synchronously. `failureMode` (`'fail-closed'` default) governs only the `unavailable` case, per §1.3.

**Zero leakage.** `GatewayClientOptions` has no field that could carry secrets or env; the SDK reads no environment variables and sends exactly the `ExecuteRequestEnvelope`, nothing else.

### 2.2 Integration patterns

**Pattern 1 — Direct call.** Host explicitly calls `gateway.execute()` at a chosen extension point (snippet above).

```
[route handler] ──▶ gateway.execute() ──▶ [gateway] ──▶ continue with result
```

Trade-offs: explicit, auditable, per-call-site control of failure handling; the three-line change. **Don't use when** dozens of routes need identical treatment — that's per-callsite noise; use pattern 2.

**Pattern 2 — Middleware / hook.** One registration routes a whole class of requests through a plugin with zero per-callsite changes.

```
[HTTP req] ──▶ [gatewayMiddleware] ──▶ req.body := plugin(req.body) ──▶ [existing handler, unchanged]
```

```ts
import { gatewayMiddleware } from "@16xbrains/gateway-client/middleware";

// Express
app.use("/api/customers", gatewayMiddleware({ gateway, pluginId: "outsourced-analytics" }));

// Fastify
app.addHook("preHandler", fastifyGatewayHook({ gateway, pluginId: "outsourced-analytics" }));
```

Semantics: transforms `req.body` through the plugin before the handler runs; on `success` replaces the body; on `unavailable`+fail-open passes the original through; on anything else responds `502` with `{ status }` (overridable via `onResult`). Trade-offs: zero handler edits; uniform policy. **Don't use when** only some payloads on a route should flow through, when a route's latency budget can't absorb `timeoutMs`, or when the handler must distinguish enriched from raw bodies.

**Pattern 3 — Event-driven.** Host publishes to an emitter/queue; a consumer executes the plugin and replies on a channel. For async/batch.

```
[host] ──emit('gateway:execute', {requestId, payload})──▶ [consumer] ──▶ gateway.execute()
   ◀──emit('gateway:result', {requestId, result})────────────┘
```

```ts
import { attachGatewayConsumer } from "@16xbrains/gateway-client/events";

attachGatewayConsumer(emitter, { gateway, pluginId: "outsourced-analytics" });
emitter.emit("gateway:execute", { requestId, payload: batchRecord });
emitter.on("gateway:result", ({ requestId, result }) => { /* correlate */ });
```

Trade-offs: decouples latency from the request path; natural for batch; backpressure via the queue. **Don't use when** the caller needs the result synchronously in a request/response cycle, or when there's no correlation-ID discipline in the codebase yet.

### 2.3 Plugin SDK — `@16xbrains/plugin-sdk` (frozen public API)

What the agency codes against — they never see anything else.

```ts
import { definePlugin } from "@16xbrains/plugin-sdk";

module.exports = definePlugin({
  id: "outsourced-analytics",
  version: "1.2.0",
  handler: async (payload, ctx) => {
    ctx.log("info", "scoring record");                    // host-side logger
    // payload.user_email === "[TOKEN_MASK_SHA256_8cc63f…]" — tokens, never raw PII
    const res = await ctx.fetch({ url: "https://api.verified-partner.com/score",
                                  method: "POST", body: JSON.stringify(payload) }); // allowlisted only
    return { ...payload, score: JSON.parse(res.body).score };
  },
});
```

**Delivery format (D11):** one CommonJS file; only `require('@16xbrains/plugin-sdk')` permitted; exactly one `definePlugin` call assigned to `module.exports`; result must be a JSON object ≤ `maxResultBytes`.

**Unavailable inside the sandbox — agencies must read this list; it is enforced, not advisory:** `process` (including `env`), `require`/`import` of anything else, filesystem, all network primitives (`fetch`/`http`/sockets — only `ctx.fetch` exists, and only for allowlisted domains), `eval` / `new Function` (rejected at the gate before running), timers (`setTimeout`/`setInterval` do not exist), persistent state between invocations (fresh context every call), `Buffer`, `console` (use `ctx.log`). Available: full ECMAScript — `JSON`, `Math`, `Date`, `RegExp`, `Promise`, etc.

**Local test harness** (runs the *real* gate and *real* isolate — D12):

```
16xgateway check ./my-plugin.js --policy=strict            # AST gate: pass/fail + reason codes
16xgateway run   ./my-plugin.js --payload=./fixture.json   # gate → sandbox → prints result envelope
```

Exit code 0 = admissible; 1 = violations (each printed as `POL-xxx line:col message`). Agencies fail at dev time, not deploy time.

### 2.4 Plugin lifecycle

```
author → 16xgateway check (local, same code path) → deliver plugin.cjs
      → POST /v1/admin/plugins  ─ AST gate ─ fail → admitted:false + POL-* codes (never executed)
                                └ pass → sha256 → write plugins/<id>/<version>/plugin.cjs
                                       → registry entry {status:'active'} → hot-load lazily on first execute
      → invoke (hash re-verified on every cold load) → teardown per D10
      → POST /v1/admin/plugins/:id/:version/revoke → status:'revoked' → isolates disposed
        → subsequent executes: REG-REVOKED → no host or gateway restart required
```

**Versioning:** strict semver; `execute` may pin `pluginVersion`, otherwise resolves the highest `active` version. **Rollback = revoke the bad version** — resolution falls back to the previous active one. Registry watchers propagate revocation across PM2 workers (§1.5.3).

### 2.5 Wire protocol (frozen)

All bodies JSON. All handled outcomes return HTTP 200 with a `GatewayResult` envelope — the discriminator lives in the body, not in HTTP status codes (400 only for unparseable JSON, mapped to `rejected`/`GW-BADREQ`).

| Route | Purpose |
|---|---|
| `POST /v1/execute` | `ExecuteRequestEnvelope` → `GatewayResult`. |
| `GET  /healthz` | → `HealthStatus`. The only route that may be publicly proxied. |
| `POST /v1/admin/plugins` | `{ id, version, source }` (source base64) → `AdmissionResult`. UDS-only or `x-admin-token`. |
| `POST /v1/admin/plugins/:id/:version/revoke` | `{ reason }` → `{ revoked: boolean }`. Same auth. |
| `GET  /v1/admin/plugins` | → `PluginRegistryEntry[]`. Same auth. |

Reference exchange (matches the brief; server response is a superset — extra meta fields are additive):

```json
POST /v1/execute
{ "pluginId": "outsourced-analytics",
  "payload": { "user_email": "boss@client.com", "action": "process" } }

200 OK   (shown with unmaskResponse:false, as in the demo)
{ "status": "success", "sanitized": true, "unmasked": false,
  "requestId": "…", "pluginId": "outsourced-analytics", "pluginVersion": "1.2.0",
  "durationMs": 12, "timestamp": "…",
  "data": { "user_email": "[TOKEN_MASK_SHA256_8cc63f2a91b4]",
            "result": "Processed successfully inside isolated sandbox context." } }
```

With the production default (`unmaskResponse:true`), `data.user_email` is `"boss@client.com"` and `"unmasked": true` — the host's business logic never learns tokenization happened.

---

## 3. `src/types/index.ts` — Immutable Contract (complete, final)

This file is written by the architect (this session), committed first, and **no delegated task may modify it**. Every task imports from `../types/index.js`.

```ts
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
```

**Immutability rules:** no delegated task edits this file; additions land only via an architect-authored minor bump; `status` discriminants and `ReasonCode` strings are frozen forever (host apps switch on them).

---

## 4. Delegation Backlog — 6 Standalone Tasks

**Dependency order:** Tasks 1, 2, 3 run in parallel (they share only `types/index.ts`, which the architect commits first). Task 4 needs 1–3 merged. Task 5 needs 4. Task 6 needs 5. The architect reviews each output against the acceptance criteria before merging.

**Conventions baked into every prompt** (restated inside each block so no external context is needed): TypeScript strict + ESM, imports from `../types/index.js`, tests via `node:test`, exhaustive file boundaries, no new dependencies beyond the task's stated allowance.

---

### Task 1 — Sanitizer: PII patterns, HMAC tokenizer, reverse map

**Goal:** the `src/sanitizer/` module — compiled pattern set, deterministic tokenization, request-scoped restore. **Tier: Sonnet** — regex correctness and overlap resolution have real failure modes (catastrophic backtracking, Luhn edge cases) that Haiku gets subtly wrong.

```text
ROLE: Senior TypeScript implementer. Produce complete, compiling files — no placeholders, no TODOs.

CONTEXT (all you need): 16xGateway is a security sidecar that masks PII in JSON payloads
before third-party plugin code sees them, then restores real values afterward. You are
building the sanitizer module. Nothing else about the system is relevant to you.

FILES YOU MAY CREATE (exhaustive — do not touch anything else, do not create package.json
or tsconfig; assume '../types/index.js' exists and exports the contract below):
  src/sanitizer/patterns.ts
  src/sanitizer/tokenizer.ts
  src/sanitizer/reverse-map.ts
  src/sanitizer/index.ts
  tests/sanitizer.test.ts

RULES: TypeScript strict, ESM. Tests use node:test + node:assert. Runtime dependencies:
NONE (node:crypto only). Never log or store a raw matched value anywhere except inside
the ReverseMap's private storage. No `any`.

CONTRACT (read-only copy from src/types/index.ts — import these, never redefine):
  export type RequestId = string; export type TokenString = string;
  export type JsonPrimitive = string | number | boolean | null;
  export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
  export interface JsonObject { [key: string]: JsonValue; }
  export type PiiCategory = "email" | "phone" | "ssn" | "national_id" | "credit_card"
                          | "api_key" | "bearer_token" | "sensitive_key";
  export interface PiiPattern { category: PiiCategory; pattern: RegExp; priority: number;
                                validate?: (match: string) => boolean; }
  export interface SanitizationMatch { category: PiiCategory; token: TokenString; jsonPath: string; }
  export interface ReverseMap { readonly size: number; readonly destroyed: boolean;
    restore<T extends JsonValue>(value: T): T; destroy(): void; }
  export interface SanitizationPass { requestId: RequestId; sanitizedPayload: JsonObject;
    matches: SanitizationMatch[]; reverseMap: ReverseMap; }
  export interface Sanitizer { sanitize(payload: JsonObject, requestId: RequestId): SanitizationPass;
    scan(text: string): Array<{ category: PiiCategory; start: number; end: number }>; }

BEHAVIOR SPEC:
1. patterns.ts exports DEFAULT_PATTERNS: PiiPattern[] covering, with priorities
   (lower = wins overlap ties):
   - api_key (10): AKIA[0-9A-Z]{16} · sk-[A-Za-z0-9_-]{20,} · ghp_[A-Za-z0-9]{36}
     · xox[bposar]-[A-Za-z0-9-]{10,}
   - bearer_token (11): /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/ and bare JWTs
     /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/
   - credit_card (20): 13–19 digits allowing single space/hyphen separators,
     validate = Luhn check on digits only
   - ssn (30): /\b\d{3}-\d{2}-\d{4}\b/ (hyphenated only — contiguous 9 digits is too
     false-positive-prone and is deliberately excluded)
   - email (40): /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
   - phone (50): E.164 /\+\d{7,15}\b/ and US formats like (555) 123-4567 / 555-123-4567
   ALL patterns: 'g' flag; LINEAR-TIME DISCIPLINE — no nested quantifiers, no
   backreferences, no lookbehind.
2. patterns.ts also exports SENSITIVE_KEYS: string[] = ["password","passwd","secret",
   "token","api_key","apikey","ssn","credit_card","authorization","private_key"].
   During the deep walk, if a JSON key — lowercased with '_' and '-' stripped — equals
   one of these (same normalization applied), its ENTIRE string value is masked with
   category "sensitive_key", regardless of pattern matches.
3. tokenizer.ts: createTokenizer(secretKey: string, hexLength: number) returning
   token(value: string): TokenString where token = `[TOKEN_MASK_SHA256_` +
   hmacSha256Hex(secretKey, value).slice(0, hexLength) + `]` (node:crypto createHmac).
   Deterministic: same value → same token. Collision handling: if two DIFFERENT values
   in one request map to the same hex prefix, extend that token's hex by 4 chars
   (repeat until unique within the request).
4. index.ts: createSanitizer(secretKey: string, hexLength: number,
   patterns?: PiiPattern[]): Sanitizer.
   sanitize(): deep-walk the payload (objects, arrays, nested). Only STRING values are
   scanned/replaced; keys are never rewritten; numbers/booleans/null untouched.
   Per string: collect matches from all patterns, run validate() where present, resolve
   overlaps by (earliest start, then longest, then lowest priority), replace right-to-left.
   jsonPath format: "$.a.b" / "$.items[2].note". The INPUT payload object must not be
   mutated. matches[] never contains the raw value.
5. reverse-map.ts: per-pass ReverseMap holding token→original privately (closure or #private,
   not a public field). restore() deep-replaces every known token occurrence in strings.
   destroy(): clears storage, idempotent; restore() after destroy throws Error("ReverseMap destroyed").
6. scan(text) runs detection only (all patterns + validate), returns spans, allocates no tokens.

ACCEPTANCE CRITERIA (implement exactly these tests plus your own):
- {"user_email":"boss@client.com","action":"process"} → user_email replaced, matches
  /^\[TOKEN_MASK_SHA256_[0-9a-f]{12}\]$/, action untouched (hexLength 12).
- Round-trip: reverseMap.restore(sanitizedPayload) deep-equals the original payload.
- Determinism: same value twice in one payload → identical token; both restored.
- Luhn: "4111 1111 1111 1111" masked; "1234 5678 9012 3456" (fails Luhn) NOT masked.
- Key rule: {"password":"hunter2"} → value masked as sensitive_key.
- destroy(): restore() throws afterwards; destroy() twice does not throw.
- Input not mutated (deep-freeze the input in the test).
- Performance: a 1 MiB string of adversarial near-matches ("aaaa@" repeated, digit runs)
  sanitizes in < 250 ms.

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

### Task 2 — Sandbox: isolated-vm provider, guards, capability bridge

**Goal:** the `src/sandbox/` module — hard-isolated execution with memory ceiling, two-layer timeout, and host-side capability bridging. **Tier: Sonnet** — `isolated-vm` reference/copy semantics and async-timeout races are the most error-prone code in the system.

```text
ROLE: Senior TypeScript implementer. Produce complete, compiling files — no placeholders, no TODOs.

CONTEXT (all you need): 16xGateway runs untrusted third-party plugin code inside V8
isolates via the `isolated-vm` npm package. A plugin is a single CommonJS file whose only
permitted require is '@16xbrains/plugin-sdk'; it calls definePlugin({id, version, handler})
exactly once and assigns it to module.exports. The handler receives an already-sanitized
JSON payload plus a ctx object with host-bridged fetch/log. Your module executes plugins
safely. Static vetting happened before your code runs — assume hostile input anyway.

FILES YOU MAY CREATE (exhaustive — nothing else; assume '../types/index.js' exists):
  src/sandbox/isolate.ts      (single-isolate SandboxInstance implementation)
  src/sandbox/bridge.ts       (capability + require-shim injection)
  src/sandbox/index.ts        (SandboxProvider + pooled SandboxService factories)
  tests/sandbox.test.ts

RULES: TypeScript strict, ESM. Tests use node:test. Runtime dependency: isolated-vm ONLY.
Data crossing the isolate boundary must be COPIED (ExternalCopy / { copy: true }), never
shared by reference. Never expose host objects, `process`, or module internals to the isolate.

CONTRACT (read-only copy from src/types/index.ts — import, never redefine):
  export type PluginId = string; export type SemVer = string; export type RequestId = string;
  export interface JsonObject { [key: string]: JsonValue; }   // JsonValue as usual
  export type LogLevel = "debug" | "info" | "warn" | "error";
  export type SandboxErrorCode = "SBX-THREW" | "SBX-OOM" | "SBX-RESULT-INVALID" | "SBX-INTERNAL";
  export interface CapabilityFetchRequest { url: string; method: "GET" | "POST";
    headers?: Record<string, string>; body?: string; }
  export interface CapabilityFetchResponse { status: number; headers: Record<string, string>; body: string; }
  export interface HostCapabilities {
    fetch(req: CapabilityFetchRequest): Promise<CapabilityFetchResponse>;
    log(level: LogLevel, message: string): void; }
  export interface SandboxOptions { memoryLimitMb: number; timeoutMs: number;
    capabilities: HostCapabilities; }
  export type SandboxRunOutcome =
    | { ok: true;  data: JsonObject; durationMs: number }
    | { ok: false; kind: "timeout"; durationMs: number }
    | { ok: false; kind: "error"; errorCode: SandboxErrorCode; message: string; durationMs: number };
  export interface SandboxInstance { readonly id: string; readonly pluginId: PluginId;
    readonly pluginVersion: SemVer; readonly invocations: number; readonly disposed: boolean;
    run(payload: JsonObject, requestId: RequestId): Promise<SandboxRunOutcome>;
    dispose(): Promise<void>; }
  export interface SandboxProvider { create(pluginSource: string, pluginId: PluginId,
    pluginVersion: SemVer, options: SandboxOptions): Promise<SandboxInstance>; }
  export interface SandboxService { run(pluginSource: string, pluginId: PluginId,
    pluginVersion: SemVer, payload: JsonObject, requestId: RequestId,
    capabilities: HostCapabilities): Promise<SandboxRunOutcome>; disposeAll(): Promise<void>; }

BEHAVIOR SPEC:
1. create(): new ivm.Isolate({ memoryLimit: memoryLimitMb }); compile the WRAPPED plugin
   script ONCE per isolate and keep the compiled script for reuse across contexts.
2. Wrapper prelude (bridge.ts builds it): define inside the isolate
     const module = { exports: {} }; const exports = module.exports;
     function require(name) { if (name === "@16xbrains/plugin-sdk")
       return { definePlugin: (d) => d }; throw new Error("require blocked: " + name); }
   then append the plugin source verbatim. After evaluation, module.exports must be an
   object with a callable .handler, string .id, string .version — else SBX-RESULT-INVALID
   ("plugin shape").
3. EVERY run(): create a FRESH ivm.Context in the long-lived isolate, re-run the compiled
   script in it (cheap), inject:
   - payload: deep copy in (never a Reference)
   - ctx.meta { requestId, pluginId, pluginVersion, invokedAt } copied in
   - ctx.log / ctx.fetch: host functions bridged via ivm.Reference; arguments and return
     values copied across; fetch resolves inside the isolate as a plain copied object.
   Invoke handler(payload, ctx). Support sync return and Promise return.
4. Two-layer timeout: pass timeout to ivm run/apply (bounds sync slices) AND race an
   external wall-clock timer of timeoutMs; on expiry call isolate.dispose() to kill
   pending async work → { ok:false, kind:"timeout" }.
5. Error mapping: memory-limit kill (ivm dispose/heap errors — detect via error message
   containing "memory" or isolate disposal during execution) → SBX-OOM. Plugin threw →
   SBX-THREW with err.message only (no stack). Result not a plain JSON-serializable
   object (functions, undefined at top level, circular) → SBX-RESULT-INVALID.
   Unexpected internal failure → SBX-INTERNAL.
6. After ANY not-ok outcome the isolate must be disposed and never reused.
7. dispose(): idempotent; concurrent run() on a disposed instance returns SBX-INTERNAL.
8. index.ts exports createSandboxProvider(): SandboxProvider and
   createSandboxService(opts: { memoryLimitMb: number; timeoutMs: number;
   isolatePoolPerPlugin: number; recycleAfterInvocations: number }): SandboxService.
   The service keeps up to isolatePoolPerPlugin warm instances per (pluginId, version,
   source-hash), replaces disposed ones lazily, recycles an instance after
   recycleAfterInvocations runs, and serializes access so one instance never runs
   two invocations concurrently.

ACCEPTANCE CRITERIA (tests use inline plugin-source strings):
- Well-behaved plugin (echoes payload + adds field) → ok:true, data correct, host
  payload object not mutated by reference (mutate inside plugin; assert host copy intact).
- `while(true){}` in handler → kind:"timeout" in ≤ timeoutMs + 500 ms wall time.
- Async never-resolving handler (`return new Promise(()=>{})`) → kind:"timeout" likewise.
- Allocation bomb (grow arrays forever) with memoryLimitMb: 16 → SBX-OOM.
- Handler throws new Error("boom") → SBX-THREW, message "boom", no stack text.
- Plugin storing state on a global between runs → second run does NOT see it (fresh context).
- require("fs") in plugin body → SBX-THREW with "require blocked: fs".
- ctx.log calls arrive at the host capability with copied string args.
- disposeAll() leaves no live isolates (instance.disposed all true).

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

### Task 3 — Policy gate + Registry: AST scanner, admission, revocation

**Goal:** `src/policy/` (acorn AST rules → reason codes) and `src/registry/` (admit → hash → persist → resolve → revoke). **Tier: Sonnet** — AST visitor correctness decides the flagship demo; false negatives here are product failures.

```text
ROLE: Senior TypeScript implementer. Produce complete, compiling files — no placeholders, no TODOs.

CONTEXT (all you need): 16xGateway statically vets third-party plugin files before they
are admitted to a registry and later executed in a sandbox. A valid plugin is a single
CommonJS file whose only permitted require is '@16xbrains/plugin-sdk', calling
definePlugin({...}) exactly once and assigning it to module.exports. You build the AST
gate and the registry. Rejection output (reason codes, line/col) is the product's flagship
demo — precision matters.

FILES YOU MAY CREATE (exhaustive — nothing else; assume '../types/index.js' exists):
  src/policy/rules.ts        (individual AST rule functions)
  src/policy/index.ts        (createPolicyScanner(): PolicyScanner)
  src/registry/store.ts      (atomic JSON persistence)
  src/registry/index.ts      (createPluginRegistry(...): PluginRegistry)
  tests/policy.test.ts
  tests/registry.test.ts

RULES: TypeScript strict, ESM. Tests use node:test. Runtime dependency: acorn ONLY
(parse with { ecmaVersion: 2022, sourceType: "script", locations: true }). Walk the
ESTree yourself with a small recursive visitor — do not add acorn-walk. Registry writes
must be atomic (write tmp file + fs.rename). Node built-ins allowed.

CONTRACT (read-only copy from src/types/index.ts — import, never redefine):
  export type PluginId = string;   // /^[a-z0-9][a-z0-9_-]{1,63}$/
  export type SemVer = string;     // strict numeric x.y.z
  export type Sha256Hex = string; export type IsoTimestamp = string;
  export type PolicyLevel = "strict" | "standard";
  export type PolicyReasonCode = "POL-EVAL" | "POL-FUNC-CTOR" | "POL-CTOR-ESCAPE"
    | "POL-REQUIRE" | "POL-IMPORT" | "POL-DYN-IMPORT" | "POL-PROTO" | "POL-WITH"
    | "POL-GLOBAL-PROC" | "POL-GLOBAL-THIS" | "POL-SHAPE" | "POL-SIZE" | "POL-PARSE";
  export type RegistryReasonCode = "REG-UNKNOWN" | "REG-REVOKED" | "REG-HASH-MISMATCH"
    | "REG-DUPLICATE" | "REG-BAD-ID" | "REG-BAD-VERSION";
  export type ReasonCode = PolicyReasonCode | RegistryReasonCode | "GW-BADREQ" | "GW-PAYLOAD-TOO-LARGE";
  export interface PolicyViolation { code: PolicyReasonCode; message: string;
    line: number | null; column: number | null; }
  export interface PolicyResult { ok: boolean; policyLevel: PolicyLevel; scannedBytes: number;
    parseTimeMs: number; violations: PolicyViolation[]; }
  export interface PolicyScanner { scan(source: string, level: PolicyLevel): PolicyResult; }
  export type PluginStatus = "active" | "revoked";
  export interface PluginRegistryEntry { id: PluginId; version: SemVer; sha256: Sha256Hex;
    sizeBytes: number; status: PluginStatus; admittedAt: IsoTimestamp; admittedBy: string;
    policyReport: PolicyResult; sourcePath: string; revokedAt?: IsoTimestamp; revokedReason?: string; }
  export type AdmissionResult = { admitted: true; entry: PluginRegistryEntry }
    | { admitted: false; reasonCodes: ReasonCode[]; policyReport?: PolicyResult };
  export interface PluginRegistry {
    admit(source: string, id: PluginId, version: SemVer, admittedBy: string): Promise<AdmissionResult>;
    resolve(id: PluginId, version?: SemVer): Promise<PluginRegistryEntry | null>;
    revoke(id: PluginId, version: SemVer, reason: string): Promise<boolean>;
    list(): Promise<PluginRegistryEntry[]>;
    loadVerifiedSource(entry: PluginRegistryEntry): Promise<string>;
    reload(): Promise<void>; }

BEHAVIOR SPEC — POLICY (rule → code; collect ALL violations, never stop at the first):
1. POL-SIZE: source > 524_288 bytes (check before parsing).  POL-PARSE: acorn throws.
2. POL-EVAL: identifier `eval` in ANY position (call, alias assignment, member property).
3. POL-FUNC-CTOR: `Function` / `AsyncFunction` / `GeneratorFunction` as callee or in
   NewExpression.
4. POL-CTOR-ESCAPE (strict only): any `.constructor` member access — dot, or computed
   with the string literal "constructor", or computed with a NON-literal key on any
   object (dynamic key access can spell "constructor" at runtime).
5. POL-REQUIRE: `require(...)` where the argument is not the string literal
   '@16xbrains/plugin-sdk', or is non-literal. (An allowlisted require is NOT a violation.)
6. POL-IMPORT: any ImportDeclaration / Export*Declaration. POL-DYN-IMPORT: ImportExpression.
7. POL-PROTO: `__proto__` as any property/member (dot, computed literal, object key);
   `Object.setPrototypeOf` / `Reflect.setPrototypeOf`; any assignment whose left side is
   a member chain ending in `.prototype` or containing `.prototype.`.
8. POL-WITH: WithStatement.
9. POL-GLOBAL-PROC: identifier `process`. POL-GLOBAL-THIS (strict only): `globalThis`.
10. POL-SHAPE: source must contain exactly one CallExpression whose callee name is
    `definePlugin` AND at least one assignment to `module.exports`. Violation otherwise.
11. Levels: "standard" applies all rules EXCEPT POL-CTOR-ESCAPE and POL-GLOBAL-THIS;
    "strict" applies everything. Every violation carries line/column from node.loc.

BEHAVIOR SPEC — REGISTRY:
12. createPluginRegistry(opts: { rootDir: string; scanner: PolicyScanner;
    policyLevel: PolicyLevel }): PluginRegistry. Store file: <rootDir>/registry.json
    (shape: { entries: PluginRegistryEntry[] }); sources at <rootDir>/<id>/<version>/plugin.cjs.
13. admit(): validate id regex → REG-BAD-ID; strict numeric semver → REG-BAD-VERSION;
    existing id+version → REG-DUPLICATE; then scanner.scan() — if !ok, return
    { admitted:false, reasonCodes:[...unique violation codes], policyReport }. On pass:
    sha256 the exact source bytes, write source file, append entry, atomic-save store.
14. resolve(): exact version match, or highest ACTIVE version by numeric semver compare
    (implement inline — no dep). Unknown or revoked → null.
15. revoke(): set status/revokedAt/revokedReason, atomic-save, return true; false if no entry.
16. loadVerifiedSource(): read sourcePath, re-hash; mismatch → throw Error with
    (err as any).code = "REG-HASH-MISMATCH".
17. reload(): re-read store from disk, replacing the in-memory cache.

ACCEPTANCE CRITERIA:
- Hostile fixture (build it inline in the test) containing: `process.env.SECRET`,
  `require("fs")`, `eval("x")`, and `import("https://evil.example")` → ok:false and
  reasonCodes include AT LEAST POL-GLOBAL-PROC, POL-REQUIRE, POL-EVAL, POL-DYN-IMPORT.
- Clean plugin (definePlugin + module.exports + require of the sdk only) → ok:true at strict.
- Per-rule unit test for EVERY POL-* code (one minimal snippet each), asserting code AND
  that line is non-null.
- `payload["constr"+"uctor"]` → POL-CTOR-ESCAPE at strict; NO violation at standard.
- Registry: admit clean → admitted:true, file exists, sha256 matches; admit same id+version
  again → REG-DUPLICATE; admit hostile → admitted:false with policyReport (and no file
  written); revoke → resolve() returns null; tamper with stored file → loadVerifiedSource
  throws code REG-HASH-MISMATCH; two-version resolve picks highest active after
  revoking the newest.

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

### Task 4 — Core pipeline, config loader, server entrypoint

**Goal:** `src/config/`, `src/core/`, `src/server.ts` — the orchestration spine wiring Tasks 1–3 by interface. **Tier: Sonnet** — this file owns the security-critical step ordering and the `finally` obligations; it is also the merge point the architect reviews hardest.

```text
ROLE: Senior TypeScript implementer. Produce complete, compiling files — no placeholders, no TODOs.

CONTEXT (all you need): 16xGateway is a Fastify service on a Unix domain socket that
(1) validates a request, (2) resolves a plugin from a registry, (3) masks PII in the
payload, (4) executes the plugin in a sandbox, (5) validates/rescans the result,
(6) restores real values, (7) responds. You build the pipeline, config loader,
capabilities, audit log, and server. The sanitizer/registry/sandbox modules exist and
are injected — you depend ONLY on their interfaces below; your tests use hand-written
stubs, not the real modules.

FILES YOU MAY CREATE (exhaustive — nothing else; assume '../types/index.js' or
'./types/index.js' exists):
  src/config/index.ts        (loadConfig(path?): GatewayConfig — strict validation)
  src/core/capabilities.ts   (makeCapabilities(config, requestId, log): HostCapabilities)
  src/core/audit.ts          (append-only JSONL audit writer)
  src/core/pipeline.ts       (executePipeline(deps, envelope))
  src/server.ts              (Fastify entrypoint)
  tests/config.test.ts
  tests/pipeline.test.ts

RULES: TypeScript strict, ESM. Tests use node:test. Runtime dependency: fastify ONLY
(use Node's global fetch inside capabilities — no undici import). Hand-roll config
validation (fixed schema — no ajv/zod). Audit lines must NEVER contain raw payload
values — plugin ids, request ids, reason codes, token strings, and byte counts only.

CONTRACT (read-only subset of src/types/index.ts — import, never redefine).
GatewayConfig exactly as follows, plus the interfaces you consume:
  <<< paste, verbatim, from §3 of the blueprint: GatewayConfig, FailureMode, PolicyLevel,
  LogLevel, ExecuteRequestEnvelope, ResultMeta, SuccessResult, RejectedResult,
  TimeoutResult, PluginErrorResult, GatewayResult, ReasonCode + its three unions,
  SandboxErrorCode, Sanitizer, SanitizationPass, ReverseMap, PluginRegistry,
  PluginRegistryEntry, AdmissionResult, SandboxService, SandboxRunOutcome,
  HostCapabilities, CapabilityFetchRequest, CapabilityFetchResponse, HealthStatus,
  JsonObject, JsonValue >>>
  (The architect pastes the real text when dispatching; treat it as read-only.)

BEHAVIOR SPEC — CONFIG:
1. loadConfig(path = process.env.GATEWAY_CONFIG ?? "./gateway.config.json").
   Strict: unknown keys anywhere → error; wrong types → error; aggregate ALL problems
   into one Error message. Required: gateway.socket, gateway.secretKey (min 32 chars),
   gateway.environment. security.maskPii must be exactly true. Defaults:
   port 0 (TCP disabled) · maskPii true · allowedOutboundDomains [] · maxMemoryMb 128 ·
   timeoutMs 3000 · onGatewayUnavailable "fail-closed" · unmaskResponse true ·
   rescanOutput true · maxPayloadBytes 1048576 · maxResultBytes 1048576 ·
   tokenHexLength 12 · policyLevel "strict" · adminToken null ·
   sandbox {isolatePoolPerPlugin 2, recycleAfterInvocations 500} ·
   logging {level "info", auditFile null}.

BEHAVIOR SPEC — CAPABILITIES:
2. fetch: https only; hostname must match allowedOutboundDomains (exact, or "*.d.com"
   matches subdomains but not "d.com" itself); methods GET/POST; redirect: "manual",
   follow at most 3 redirects and re-check EACH target against the allowlist; response
   body capped at 1 MiB (abort beyond); per-call timeout 2000 ms. Violations reject with
   Error("EGRESS_DENIED: <hostname>") and emit an audit event {type:"egress_denied"}.
3. log: forwards to the gateway logger prefixed with plugin/request ids; rate-limit to
   100 lines per invocation (drop + one warn beyond).

BEHAVIOR SPEC — PIPELINE (order is normative and security-critical):
4. executePipeline(deps: { config: GatewayConfig; sanitizer: Sanitizer;
   registry: PluginRegistry; sandbox: SandboxService; audit: (ev: object) => void },
   envelope: unknown): Promise<GatewayResult>
   a. Validate envelope shape (pluginId regex /^[a-z0-9][a-z0-9_-]{1,63}$/, payload is a
      plain object) → rejected/GW-BADREQ. Serialized payload > maxPayloadBytes →
      rejected/GW-PAYLOAD-TOO-LARGE. Generate requestId (crypto.randomUUID) if absent.
   b. registry.resolve() → null ⇒ rejected/REG-UNKNOWN (if a revoked entry exists use
      REG-REVOKED — expose via resolve returning null and list(), or re-check; your choice,
      but the reason code must distinguish the two).
      registry.loadVerifiedSource() throw ⇒ rejected/REG-HASH-MISMATCH.
   c. sanitizer.sanitize(payload, requestId) — ALWAYS. There is no code path from (b)
      to (d) that skips this.
   d. sandbox.run(source, id, version, sanitizedPayload, requestId,
      makeCapabilities(...)).
   e. Map outcome: ok → continue; kind:"timeout" → TimeoutResult; kind:"error" →
      PluginErrorResult with its errorCode.
   f. On ok: result must survive JSON round-trip and be ≤ maxResultBytes, else
      plugin_error/SBX-RESULT-INVALID. If rescanOutput: sanitizer.scan() every string in
      the result; any hit → replace that span with "[REDACTED]" + audit
      {type:"output_pii_redacted", category}.
   g. If unmaskResponse: data = reverseMap.restore(data); unmasked = true.
   h. FINALLY (every path, including thrown internals): reverseMap.destroy() when a pass
      was created. Internal unexpected errors → plugin_error/SBX-INTERNAL (message
      "internal error", details to audit only).
   i. Every terminal outcome emits one audit event {type:"execute", requestId, pluginId,
      status, durationMs, tokenCount: matches.length}.

BEHAVIOR SPEC — SERVER:
5. buildServer(deps) returns a configured Fastify instance (exported for tests);
   src/server.ts main() loads config, builds real deps via injected factories, listens.
6. Listen on config.gateway.socket (unlink a pre-existing socket file ONLY after a probe
   connection to it fails — stale socket; if the probe connects, exit with a clear error:
   another instance is running). Also listen on 127.0.0.1:port iff port > 0.
7. Routes: POST /v1/execute → executePipeline (all handled outcomes are HTTP 200;
   unparseable JSON body → 400 with rejected/GW-BADREQ envelope).
   GET /healthz → HealthStatus. POST /v1/admin/plugins {id, version, source(base64)} →
   registry.admit; POST /v1/admin/plugins/:id/:version/revoke {reason};
   GET /v1/admin/plugins → list. Admin routes: allowed iff the request arrived via the
   UDS listener OR x-admin-token equals config.security.adminToken (when non-null);
   otherwise 403.
8. Graceful shutdown on SIGTERM/SIGINT: stop accepting, drain in-flight, await
   sandbox.disposeAll(), close audit stream. After the socket is listening call
   process.send?.("ready") (PM2 wait_ready).

ACCEPTANCE CRITERIA:
- Pipeline happy path with stubs: stub sanitizer records call order; stub registry
  returns a fixed entry; stub sandbox echoes payload → response is a SuccessResult
  whose data has real values restored (stub reverseMap), unmasked:true, sanitized:true;
  assert sanitize was called BEFORE sandbox.run.
- reverseMap.destroy() called exactly once on: success, timeout, sandbox error, AND when
  the sandbox stub throws synchronously.
- Reference exchange: {"pluginId":"outsourced-analytics","payload":{"user_email":
  "boss@client.com","action":"process"}} through stubs configured with
  unmaskResponse:false yields status:"success", sanitized:true, and data.user_email
  matching /^\[TOKEN_MASK_SHA256_[0-9a-f]+\]$/.
- Unknown plugin → rejected/REG-UNKNOWN; oversized payload → rejected/GW-PAYLOAD-TOO-LARGE.
- Config: minimal valid file loads with all defaults applied; unknown key rejected;
  maskPii:false rejected; secretKey of 10 chars rejected; error message aggregates
  multiple problems.
- Capabilities: "https://api.verified-partner.com/x" allowed by exact entry;
  "https://evil.example" → EGRESS_DENIED; "*.partner.com" matches "a.partner.com" but
  not "partner.com"; http:// URL denied. (Mock global fetch in tests.)

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

### Task 5 — Both SDKs: `gateway-client` and `plugin-sdk` + harness CLI

**Goal:** the two published packages — the host-facing client (lifecycle, breaker, typed results, middleware/events adapters) and the agency-facing SDK (`definePlugin`, `16xgateway check|run` CLI). **Tier: Sonnet** — these are the product's public interface; ergonomic or semantic drift here is an adoption killer.

```text
ROLE: Senior TypeScript implementer. Produce complete, compiling files — no placeholders, no TODOs.

CONTEXT (all you need): 16xGateway is a security sidecar reachable over a Unix domain
socket speaking HTTP/1.1 + JSON. POST /v1/execute takes { pluginId, payload, requestId?,
pluginVersion? } and returns a GatewayResult envelope (HTTP 200 for all handled
outcomes). GET /healthz returns HealthStatus. You build the two npm packages that host
apps and plugin agencies install. The engine package `@16xbrains/gateway-core` already
exists and exposes subpaths "@16xbrains/gateway-core/policy" (createPolicyScanner) and
"@16xbrains/gateway-core/sandbox" (createSandboxService) — the CLI uses them so local
checks share production code paths.

FILES YOU MAY CREATE (exhaustive — nothing else):
  packages/gateway-client/src/index.ts
  packages/gateway-client/src/middleware.ts
  packages/gateway-client/src/events.ts
  packages/gateway-client/package.json
  packages/gateway-client/tests/client.test.ts
  packages/plugin-sdk/src/index.ts
  packages/plugin-sdk/src/cli.ts
  packages/plugin-sdk/package.json
  packages/plugin-sdk/tests/sdk.test.ts

RULES: TypeScript strict, ESM. Tests use node:test. gateway-client runtime dependency:
undici ONLY (UDS via new undici.Pool("http://localhost", { socketPath })). plugin-sdk
runtime deps: NONE (workspace dep on @16xbrains/gateway-core for the CLI only).
Package.json files declare name, version 1.0.0, type module, exports map (client also
exports "./middleware" and "./events"; plugin-sdk declares bin "16xgateway" → dist/cli.js).
The client NEVER reads environment variables and NEVER throws for operational failures.

CONTRACT (read-only copy from src/types/index.ts — re-export relevant types from your
index files so consumers import ONLY from your packages):
  <<< paste, verbatim, from §3: JsonObject/JsonValue, FailureMode, GatewayResult and all
  five members, ReasonCode unions, SandboxErrorCode, GatewayClientOptions, ExecuteOptions,
  MtlsOptions, HealthStatus, PluginId, SemVer, RequestId, PluginDefinition, PluginHandler,
  PluginContext, PluginMeta, CapabilityFetchRequest/Response, HostCapabilities, LogLevel >>>

BEHAVIOR SPEC — gateway-client:
1. new Gateway(options): validate exactly one of socket | (host+port); store; NO I/O yet
   (lazy connect on first call). close(): drain + destroy the pool; idempotent.
2. execute(): TypeError synchronously if pluginId is not a string or payload is not a
   plain object. Otherwise POST /v1/execute with requestTimeoutMs (default 5000) —
   parse body as GatewayResult and return it verbatim (trust the discriminant).
3. Operational failure mapping (connect refused/ENOENT socket/timeout/malformed JSON):
   → UnavailableResult { status:"unavailable", mode: failureMode, message }, plus
   passthrough: the ORIGINAL payload iff failureMode === "fail-open". Never throw.
4. Retry/backoff: connect-level errors retried per options.connect (default 5 retries,
   base 100 ms, exponential ×2, full jitter, cap 5000 ms) within the request timeout.
   Circuit breaker per options.breaker (default threshold 5 consecutive failures,
   cooldown 10 000 ms): while open, return UnavailableResult immediately (no I/O);
   one half-open probe re-closes on success.
5. health(): GET /healthz → HealthStatus; failures → { ok:false, ... } never a throw.
6. middleware.ts: gatewayMiddleware({ gateway, pluginId, onResult? }) returning an
   Express-style (req, res, next) handler: executes req.body through the plugin;
   success → req.body = result.data, next(); unavailable with passthrough → next()
   with body unchanged; anything else → default 502 JSON { status, reasonCodes? } unless
   onResult(result, req, res, next) is provided (then it decides entirely).
   Also export fastifyGatewayHook(sameOpts) adapting identical semantics to a Fastify
   preHandler (request.body, reply.code().send()).
7. events.ts: attachGatewayConsumer(emitter, { gateway, pluginId,
   requestEvent = "gateway:execute", replyEvent = "gateway:result" }): listens for
   { requestId, payload }, calls execute, emits { requestId, result }. Returns
   { detach(): void }. Concurrency cap 10 in-flight; queue beyond (FIFO).

BEHAVIOR SPEC — plugin-sdk:
8. index.ts: definePlugin(def) validates id (/^[a-z0-9][a-z0-9_-]{1,63}$/), strict
   numeric semver, handler is a function — throws TypeError with a precise message on
   violation; returns Object.freeze(def). Re-export all plugin-facing types.
9. cli.ts (bin "16xgateway"):
   `16xgateway check <file> [--policy=strict|standard]` → read file, run
   createPolicyScanner().scan(source, level); print one line per violation
   "POL-XXXX <line>:<col> <message>"; exit 0 iff ok, else 1.
   `16xgateway run <file> --payload=<fixture.json> [--policy=...] [--timeout=3000]
   [--memory=128]` → run check first (exit 1 on fail), then execute via
   createSandboxService with a stub capabilities object (fetch → rejects
   "EGRESS_DENIED (local harness)", log → stderr); print the SandboxRunOutcome as
   pretty JSON; exit 0 iff ok:true.
10. CLI must print machine-parseable output (no colors, no spinners).

ACCEPTANCE CRITERIA:
- Client tests run a real node:http server listening on a UDS path in a temp dir,
  returning canned envelopes: success envelope passes through verbatim (deep-equal);
  server absent → unavailable + fail-closed has NO passthrough; fail-open carries the
  exact original payload; breaker: after 5 failures the 6th call returns in < 5 ms with
  no connection attempt (count attempts server-side after restart… assert via a probe
  counter object injected into connect options or by timing); half-open probe restores
  service after cooldown (use fake timers via mock.timers from node:test).
- execute(123 as any, {}) throws TypeError synchronously.
- definePlugin: valid def frozen and returned; bad id, bad semver ("1.0", "v1.0.0"),
  missing handler each throw TypeError naming the field.
- middleware: success path replaces body; rejected path yields 502 by default;
  onResult override is honored.
- events: emitting N=25 requests with cap 10 never exceeds 10 concurrent (instrument the
  stub gateway), all 25 replies arrive with matching requestIds.
- CLI: `check` on an inline-written hostile fixture exits 1 and prints ≥ 3 distinct
  POL- codes; on a clean fixture exits 0 silently.

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

### Task 6 — Examples tree + four docs

**Goal:** the runnable `examples/` demo (host CRM, good plugin, hostile plugin, one-command run) and the four audience-scoped docs. **Tier: Haiku** — content transformation against a finished system and this blueprint; low design risk, high volume. The threat-model text (§1.4) and integration text (§2) are provided as source material, which removes the main Haiku risk (inventing security claims).

```text
ROLE: Technical writer + example-app author. Everything you need is included below.
Produce complete files — no placeholders.

CONTEXT: 16xGateway is a self-hosted security sidecar. The implementation exists and is
importable; the packages @16xbrains/gateway-client and @16xbrains/plugin-sdk exist as
workspaces. The gateway exposes POST /v1/execute, GET /healthz, and admin routes
POST /v1/admin/plugins {id, version, source(base64)} / POST /v1/admin/plugins/:id/:version/revoke.
The client API, plugin API, sandbox restrictions, failure semantics, config reference,
deployment steps, and threat model are given verbatim in the SOURCE MATERIAL section at
the end of this prompt — do not invent beyond it, especially in security claims.
[Architect note: when dispatching, paste blueprint §§1.3–1.5, 2.1–2.5, and the frozen
config JSON from §5.1 as SOURCE MATERIAL.]

FILES YOU MAY CREATE (exhaustive — nothing else):
  examples/host-app/server.js          (small Fastify "CRM", plain JS, ESM)
  examples/host-app/package.json
  examples/plugin-good/plugin.cjs
  examples/plugin-hostile/plugin.cjs
  examples/run-demo.js                 (single-command orchestrator, plain JS)
  examples/README.md
  docs/integration-guide.md
  docs/plugin-authoring.md
  docs/operations.md
  docs/security-model.md

BEHAVIOR SPEC — EXAMPLES:
1. host-app: Fastify on 127.0.0.1:3001 with an in-memory customers array (3 records
   containing realistic-but-fake emails, phones, and one card number "4111 1111 1111 1111").
   Endpoint A (direct call): POST /customers/:idx/enrich calls gateway.execute
   ("outsourced-analytics", record) explicitly. Endpoint B (middleware): POST /analyze
   registered behind gatewayMiddleware with the same gateway instance — same gateway,
   two integration patterns, labeled as such in comments.
2. plugin-good/plugin.cjs: requires ONLY '@16xbrains/plugin-sdk'; definePlugin with
   id "outsourced-analytics", version "1.0.0"; handler adds { segment, score } derived
   from harmless fields and echoes the payload — comments point out that user_email is
   a [TOKEN_MASK_SHA256_…] token at this point.
3. plugin-hostile/plugin.cjs: attempts, in order, with a comment above each:
   process.env.DATABASE_URL · require("fs").readFileSync("/etc/passwd") · eval("2+2")
   · import("node:net"). Must still be syntactically valid JS.
4. run-demo.js (ONE command: `node examples/run-demo.js`):
   a. start the gateway on a temp UDS socket with a demo config (unmaskResponse:false
      so tokenization is VISIBLE; secretKey generated randomly at startup);
   b. admit plugin-good via the admin route → print the admitted entry line;
   c. attempt to admit plugin-hostile → print the AdmissionResult reason codes
      prominently, e.g. "REJECTED: POL-GLOBAL-PROC POL-REQUIRE POL-EVAL POL-DYN-IMPORT —
      0 lines executed". THE REJECTION IS THE DEMO — give it visual space (ASCII rule
      lines, not emoji);
   d. start host-app, POST to both endpoints, print for endpoint A a BEFORE/AFTER pair:
      the raw record vs what the PLUGIN saw (tokenized) vs what the host got back;
   e. exit 0, everything torn down. No Docker, no global installs.
5. examples/README.md: what the demo proves, the one command, expected output annotated.

BEHAVIOR SPEC — DOCS (each file, from SOURCE MATERIAL, for its own audience ONLY):
6. integration-guide.md (enterprise engineer): install; 3-line quickstart; all three
   patterns each with diagram + snippet + trade-offs + when NOT to use; failure
   semantics table (all five statuses + what to do); full config reference table with
   defaults; migration path for an existing Express/Fastify app (start with pattern 1
   on one endpoint → graduate to pattern 2).
7. plugin-authoring.md (outsourced agency — they never see the host repo): the contract
   (definePlugin, single CJS file, sdk-only require); the UNAVAILABLE-in-sandbox list
   verbatim with a one-line "why" each; ctx.fetch allowlist behavior; ctx.log; the
   16xgateway check/run harness with sample failing output; debugging tips (no console,
   use ctx.log; no timers; fresh context each call); delivery checklist (check passes
   strict, fixture round-trips, semver bumped, single file).
8. operations.md (SRE): VPS install incl. build toolchain for isolated-vm; the corrected
   deployment — UDS-only by default, ecosystem.config.cjs with wait_ready and
   kill_timeout; the Caddy caveat VERBATIM from source material (only /healthz may be
   public; client certs otherwise); secretKey rotation (rotate → reload → old tokens
   unmappable, by design); log/audit locations; health probe; plugin admit/revoke
   runbook incl. cross-worker propagation; incident runbook (hostile plugin admitted?
   revoke → verify REG-REVOKED → pull audit lines).
9. security-model.md (CISO/auditor): threat model AS GIVEN — both lists, defends and
   does-NOT-defend, reproduced faithfully including the isolate-escape consequence and
   the isolated-vm maintenance-mode note; PII handling lifecycle (tokenize → per-request
   reverse map → destroy; HMAC rationale); data residency (single box, zero cloud/AI
   calls at runtime); explicit "not a DLP" statement. DO NOT soften, DO NOT add
   marketing language. Honest limitations are a feature of this document.

ACCEPTANCE CRITERIA:
- `node examples/run-demo.js` on a clean checkout (after root npm install && npm run
  build) exits 0 and prints: one admitted line, one rejection block with ≥ 3 POL- codes,
  one BEFORE/tokenized/AFTER triple where the tokenized email matches
  /\[TOKEN_MASK_SHA256_[0-9a-f]+\]/.
- Hostile plugin file never executes: the demo asserts the gateway's plugins/ dir does
  NOT contain plugin-hostile after the run.
- Each doc contains every element listed for it above; no doc mentions internals of the
  others' audiences (no sandbox-implementation details in the integration guide, no
  host-SDK examples in plugin-authoring).
- All prose factual per SOURCE MATERIAL; zero invented guarantees.

OUTPUT FORMAT: full contents of each file, one fenced code block per file, path as heading.
```

---

## 5. Cost / Compute Note

**Kept at the architect tier (this session):** every decision with systemic blast radius — the twelve locked decisions (§0), the pipeline step ordering and its `finally` obligations (§1.1), the failure-semantics matrix (§1.3), the honest threat model (§1.4), both public API surfaces (§2), the entire type contract (§3), and the six prompts themselves. Also reserved for the architect: reviewing each task's output against its acceptance criteria before merge, and the final integration pass (Tasks 4→5→6 merge points). These are the places where a cheap model's plausible-but-wrong guess costs a rewrite or, worse, ships a security hole.

**Pushed down (~everything by volume):** an estimated 3.5–4.5k LOC of implementation plus tests, ~2k lines of docs/examples — 100% of mechanical file generation. Five Sonnet tasks, one Haiku task. Sonnet everywhere the code can be *subtly* wrong (regex backtracking, ivm copy semantics, AST visitor coverage, step ordering, breaker timing); Haiku only where the source material is supplied verbatim in the prompt and the failure mode is awkward prose rather than a vulnerability. The suggested cut from the brief is adopted unchanged — it already matched the risk gradient.

**Why the prompts are long:** each restates its interface subset and acceptance tests inline, so the junior model needs zero repo context and produces mergeable output on the first attempt. Prompt tokens are cheap; re-runs and cross-task drift are not. The single shared artifact — `types/index.ts` — is architect-written and immutable, which is what makes tasks 1–3 safely parallel.

### 5.1 Frozen `gateway.config.json` (reference, with all defaults explicit)

```json
{
  "gateway": {
    "port": 0,
    "socket": "/var/run/16xgateway.sock",
    "environment": "production",
    "secretKey": "YOUR_ROTATING_TOKENIZATION_SECRET_MIN_32_CHARS"
  },
  "security": {
    "maskPii": true,
    "allowedOutboundDomains": ["api.verified-partner.com"],
    "maxMemoryMb": 128,
    "timeoutMs": 3000,
    "onGatewayUnavailable": "fail-closed",
    "unmaskResponse": true,
    "rescanOutput": true,
    "maxPayloadBytes": 1048576,
    "maxResultBytes": 1048576,
    "tokenHexLength": 12,
    "policyLevel": "strict",
    "adminToken": null
  },
  "sandbox": {
    "isolatePoolPerPlugin": 2,
    "recycleAfterInvocations": 500
  },
  "logging": {
    "level": "info",
    "auditFile": "/var/log/16xgateway/audit.jsonl"
  }
}
```

---

*End of blueprint. Next session: commit `src/types/index.ts` verbatim from §3, then dispatch Tasks 1–3 in parallel.*

