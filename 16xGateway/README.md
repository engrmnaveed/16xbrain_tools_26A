# 16xGateway

**A self-hosted security sidecar that masks PII before untrusted plugin code
sees it — and rejects hostile plugins before a single line runs.**

Your app hands 16xGateway a JSON payload and a plugin id. The gateway tokenizes
PII in the payload, runs the (third-party) plugin inside a hard V8 isolate with
no ambient capabilities, restores the real values, and hands you a typed result.
You branch on one `status` field; operational failures never throw.

```ts
import { Gateway } from "@16xbrains/gateway-client";

const gateway = new Gateway({ socket: "/var/run/16xgateway.sock" });
const result = await gateway.execute("outsourced-analytics", customerRecord);
if (result.status === "success") save(result.data); // real values already restored
```

## Why it exists

Outsourcing a data-processing task to a third-party plugin usually means handing
that code your customers' raw PII and trusting it not to read `process.env`,
touch the filesystem, or phone home. 16xGateway removes that trust requirement:

- **PII never reaches the plugin.** Values are tokenized (deterministic
  HMAC-SHA256) on the way in and restored on the way out. The plugin only sees
  `[TOKEN_MASK_SHA256_…]` tokens.
- **The plugin has no capabilities it wasn't handed.** The isolate contains
  ECMAScript intrinsics only — no `require`, no `process`, no `fs`, no network,
  no timers. Egress is a host-side, allowlisted `ctx.fetch`.
- **Hostile plugins are rejected at admission.** An acorn AST gate refuses code
  that references `eval`, `process`, off-list `require`, dynamic `import`,
  prototype pollution, and more — with precise reason codes and **zero
  execution**.

## Architecture at a glance

```
 HOST APP                     GATEWAY ENGINE                          ISOLATE
 gateway.execute(id, payload)
   │
   ▼  validate → resolve plugin → SANITIZE (tokenize PII) ──▶ run handler(sanitized, ctx)
                                                              memory ceiling · wall-clock timeout
   ◀── restore real values ◀── rescan output ◀── map outcome ◀──── JSON result
        (reverse map destroyed in `finally`, every path)
```

## Repository layout

| Path | What it is |
|---|---|
| `src/types/` | The immutable contract (v1.0.0). |
| `src/sanitizer/` | PII patterns, HMAC tokenizer, per-request reverse map. |
| `src/sandbox/` | `isolated-vm` provider, guards, capability bridge, pooling. |
| `src/policy/` | acorn AST gate → reason codes. |
| `src/registry/` | Admit → hash → persist → resolve → revoke. |
| `src/core/`, `src/server.ts` | Pipeline, capabilities, audit, Fastify entrypoint. |
| `packages/gateway-client/` | Host SDK (`@16xbrains/gateway-client`). |
| `packages/plugin-sdk/` | Authoring SDK + `16xgateway` CLI (`@16xbrains/plugin-sdk`). |
| `examples/` | Runnable demo (host CRM, good/hostile plugins, one-command run). |
| `docs/` | Integration, plugin-authoring, operations, security-model guides. |
| `website/` | Standalone showcase page for 16xbrains.com. |

## Quickstart

```bash
npm install        # builds isolated-vm (needs a compiler toolchain — see docs/operations.md)
npm run build
npm test           # runs the suite (sandbox tests self-skip without the native binary)
node examples/run-demo.js
```

## Documentation

- [Integration guide](docs/integration-guide.md) — wiring it into your app.
- [Plugin authoring](docs/plugin-authoring.md) — for the agency writing plugins.
- [Operations](docs/operations.md) — deploy, PM2, rotation, runbooks.
- [Security model](docs/security-model.md) — what it defends against, and what it does not.

## Status

Contract **v1.0.0 — LOCKED.** The `status` discriminants and `ReasonCode`
strings are frozen; host apps switch on them.
