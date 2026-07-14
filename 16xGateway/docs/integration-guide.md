# 16xGateway — Integration Guide

**Audience:** the engineer wiring 16xGateway into an existing application.

16xGateway is a self-hosted security sidecar. Your app hands it a JSON payload
and a plugin id; it masks PII in that payload, runs the (third-party) plugin in
a hard sandbox, restores the real values, and hands you the result. You branch
on a single `status` field — operational failures never throw.

## Install

```bash
npm install @16xbrains/gateway-client
```

The client speaks HTTP/1.1 over a Unix domain socket (the gateway never binds a
public interface by default). You need the socket path the gateway is listening
on.

## Three-line quickstart

```ts
import { Gateway } from "@16xbrains/gateway-client";

const gateway = new Gateway({ socket: "/var/run/16xgateway.sock" });

const result = await gateway.execute("outsourced-analytics", customerRecord);
if (result.status === "success") save(result.data); // real values already restored
```

## Integration patterns

### Pattern 1 — Direct call

```
[route handler] ──▶ gateway.execute() ──▶ [gateway] ──▶ continue with result
```

```ts
const result = await gateway.execute("outsourced-analytics", customerRecord);

if (result.status === "success") {
  save(result.data);
} else if (result.status === "unavailable" && result.passthrough) {
  save(result.passthrough);            // fail-open: proceed without enrichment
} else {
  metrics.count(`gateway.${result.status}`);
}
```

**Trade-offs:** explicit, auditable, per-call-site control of failure handling;
it is a three-line change. **Don't use when** dozens of routes need identical
treatment — that becomes per-callsite noise; use Pattern 2 instead.

### Pattern 2 — Middleware / hook

```
[HTTP req] ──▶ [gatewayMiddleware] ──▶ req.body := plugin(req.body) ──▶ [existing handler, unchanged]
```

```ts
import { gatewayMiddleware } from "@16xbrains/gateway-client/middleware";

// Express
app.use("/api/customers", gatewayMiddleware({ gateway, pluginId: "outsourced-analytics" }));

// Fastify
import { fastifyGatewayHook } from "@16xbrains/gateway-client/middleware";
app.addHook("preHandler", fastifyGatewayHook({ gateway, pluginId: "outsourced-analytics" }));
```

**Semantics:** transforms `req.body` through the plugin before the handler runs.
On `success` it replaces the body; on `unavailable`+fail-open it passes the
original through unchanged; on anything else it responds `502` with `{ status }`
(override entirely via `onResult`).

**Trade-offs:** zero handler edits; uniform policy across a route class.
**Don't use when** only some payloads on a route should flow through, when the
route's latency budget can't absorb `timeoutMs`, or when the handler must
distinguish enriched from raw bodies.

### Pattern 3 — Event-driven

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

**Trade-offs:** decouples latency from the request path; natural for batch;
backpressure via the queue (concurrency is capped, overflow is queued FIFO).
**Don't use when** the caller needs the result synchronously in a
request/response cycle, or when the codebase has no correlation-id discipline
yet.

## Failure semantics — branch on `status`

| `status` | What happened | What to do |
|---|---|---|
| `success` | Plugin ran; `data` holds the result (real values restored unless the deployment set `unmaskResponse:false`). | Use `result.data`. |
| `unavailable` | The gateway could not be reached (down, socket absent, circuit breaker open). **Synthesized client-side.** | Fail-closed: treat as an error. Fail-open: use `result.passthrough` (the original payload) and proceed. |
| `rejected` | The gateway is alive and refused the request (bad envelope, oversized payload, unknown/revoked plugin, hash mismatch). | Programmer/registry error — inspect `reasonCodes`, fix the call site or the registry. Never converted to passthrough. |
| `timeout` | Execution exceeded `timeoutMs`; the isolate was disposed. | Retryable by your policy. |
| `plugin_error` | The plugin threw, hit the memory ceiling, or returned a non-JSON / oversized result. | Report to the plugin's author (agency); `errorCode` says which. Not converted to passthrough. |

**Fail-open, precisely.** `failureMode` (`'fail-closed'` by default) governs
**only** the `unavailable` case. A `rejected` or `plugin_error` is *never*
turned into a passthrough, because those mean the gateway is alive and made a
security decision.

## Client configuration

`new Gateway(options)` — you must provide **exactly one** of `{ socket }` or
`{ host, port }`.

| Option | Default | Meaning |
|---|---|---|
| `socket` | — | UDS path (preferred). |
| `host` / `port` | — | Loopback or mTLS deployments; requires `port`. |
| `mtls` | — | `{ ca, cert, key }` PEM contents for split-host TCP. |
| `failureMode` | `"fail-closed"` | Governs the `unavailable` case only. |
| `requestTimeoutMs` | `5000` | End-to-end per call (≥ server `timeoutMs` + overhead). |
| `connect` | `{ retries: 5, baseDelayMs: 100, maxDelayMs: 5000 }` | Exponential backoff with full jitter on connect errors. |
| `breaker` | `{ threshold: 5, cooldownMs: 10000 }` | 5 consecutive connect failures open the breaker for 10 s; one half-open probe closes it. |

Connection is lazy (first `execute()`), kept alive over a pool, and drained by
`close()`. The client reads **no** environment variables and sends exactly the
request envelope — nothing else.

## Migration path for an existing app

1. **Start with Pattern 1 on one endpoint.** Pick the single route that sends
   customer data to a third party. Add the three-line direct call and branch on
   `status`. Ship it; watch the metrics.
2. **Graduate to Pattern 2** once you trust the behavior and want the same
   treatment across a whole route class. Replace the per-handler calls with one
   `gatewayMiddleware` / `fastifyGatewayHook` registration; the handlers stop
   needing any gateway awareness.
3. **Reach for Pattern 3** only for async/batch flows where the result does not
   need to return within the original request/response cycle.
