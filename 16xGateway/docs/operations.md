# 16xGateway — Operations Guide

**Audience:** the SRE deploying and running 16xGateway on a VPS.

## Install (VPS, single box)

The sandbox uses the native `isolated-vm` module, which needs a compiler
toolchain at install time:

```bash
# Debian/Ubuntu
sudo apt-get install -y build-essential python3

npm ci               # builds isolated-vm against your pinned Node
npm run build
```

Pin Node to the exact LTS your CI uses — `isolated-vm` is a native module and is
sensitive to the V8 ABI. Alternatively, ship a prebuilt binary and **verify its
checksum** before first run.

## Deployment — UDS by default

**A single-box deployment needs no reverse proxy.** The gateway listens on a
Unix domain socket and, by default (`port: 0`), does **not** bind any TCP port.
Admin routes answer over the UDS only (or with an `adminToken`). This is the
recommended posture.

### The Caddy caveat (verbatim)

A naive `reverse_proxy localhost:4040` **publicly exposes `/v1/execute`** and
breaks the security model. If you use Caddy at all: expose **only**
`GET /healthz`, and require **client certificates** for anything else. Admin
routes must additionally answer only over the UDS (or with `adminToken`). For a
single box, the simplest correct answer is: **no Caddy — UDS only, don't bind
the TCP port.**

### PM2 (`ecosystem.config.cjs`)

```js
module.exports = {
  apps: [{
    name: "16xgateway",
    script: "dist/src/server.js",
    instances: "max",          // UDS listener is shared via the cluster master
    exec_mode: "cluster",
    wait_ready: true,          // server calls process.send('ready') once listening
    kill_timeout: 5000,        // ≥ security.timeoutMs + 2000 so in-flight isolates drain
    env: { GATEWAY_CONFIG: "/etc/16xgateway/gateway.config.json" },
  }],
};
```

```bash
pm2 start ecosystem.config.cjs
```

Notes:

- **Stale socket:** on start the server connect-probes the socket; if the probe
  connects, another instance is live and it exits with a clear error; if the
  probe fails, it unlinks the stale socket and binds.
- **Cluster mode:** Node's cluster module shares the UDS listener via the
  master. `kill_timeout` must exceed `security.timeoutMs` so isolates drain on
  reload rather than being cut off.

## Configuration reference

The config file (`gateway.config.json`) is strictly validated at boot — unknown
keys and wrong types fail fast with an aggregated error. Key fields:

| Field | Default | Notes |
|---|---|---|
| `gateway.socket` | — | Absolute UDS path (required). |
| `gateway.port` | `0` | `0` disables TCP entirely (recommended). |
| `gateway.secretKey` | — | HMAC tokenization key, **min 32 chars** (required). |
| `security.allowedOutboundDomains` | `[]` | Keep empty unless a plugin genuinely needs egress. |
| `security.maxMemoryMb` | `128` | Hard isolate ceiling. |
| `security.timeoutMs` | `3000` | Wall-clock per invocation. |
| `security.unmaskResponse` | `true` | Restore real values before returning. |
| `security.adminToken` | `null` | `null` → admin over UDS only. |
| `logging.auditFile` | — | Append-only JSONL path; `null` logs to stdout. |

## secretKey rotation

The tokenizer is deterministic HMAC-SHA256 over `secretKey`. To rotate:

1. Update `gateway.secretKey` in the config.
2. Reload the gateway.

**By design, tokens minted under the old key become unmappable** — reverse maps
are request-scoped and never persisted, so there is nothing to migrate. Rotation
is safe precisely because no token→value mapping outlives its request.

## Logs and audit

- **Audit** is append-only JSONL at `logging.auditFile` (or stdout if `null`).
  Lines carry request/plugin ids, statuses, reason codes, token strings, and
  byte counts **only** — never raw payload values. Ship them to your log store.
- Event types you'll see: `execute` (one per terminal outcome),
  `egress_denied`, `output_pii_redacted`.

## Health probe

`GET /healthz` returns `{ ok, version, contractVersion, uptimeSec,
pluginsActive }`. It is the **only** route that may be publicly proxied. Wire it
to your load balancer / uptime check.

## Plugin admit / revoke runbook

Admit a vetted plugin (base64 the source):

```bash
curl --unix-socket /var/run/16xgateway.sock \
  -X POST http://localhost/v1/admin/plugins \
  -H 'content-type: application/json' \
  -d "{\"id\":\"outsourced-analytics\",\"version\":\"1.2.0\",\"source\":\"$(base64 -w0 plugin.cjs)\"}"
```

Revoke a version (rollback = revoke; resolution falls back to the previous
active version):

```bash
curl --unix-socket /var/run/16xgateway.sock \
  -X POST http://localhost/v1/admin/plugins/outsourced-analytics/1.2.0/revoke \
  -H 'content-type: application/json' -d '{"reason":"regression"}'
```

**Cross-worker propagation:** the registry lives on disk; each PM2 worker
watches `plugins/registry.json` and reloads its cache, so a revoke takes effect
across all workers **without a host or gateway restart**.

## Incident runbook — a hostile plugin slipped through

1. **Revoke it** immediately (command above). Revocation disposes its isolates
   and takes effect without a restart.
2. **Verify** subsequent executes return `rejected` / `REG-REVOKED`.
3. **Pull the audit lines** for that plugin id — statuses, reason codes,
   `egress_denied` events — to scope what it attempted. No raw payload values
   are in the audit log by design, so the blast radius is bounded to metadata.
4. If the stored source ever fails hash re-verification on load
   (`REG-HASH-MISMATCH`), treat it as a tamper alarm: the on-disk file no longer
   matches what was admitted.
