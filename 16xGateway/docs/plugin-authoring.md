# 16xGateway — Plugin Authoring Guide

**Audience:** an agency building a plugin. You never see the host application's
repository. You author a single file against one SDK, test it locally with the
same gate and sandbox the production gateway uses, and deliver it.

## The contract

A plugin is **one CommonJS file** that:

- requires **only** `@16xbrains/plugin-sdk` (no other `require` is permitted);
- calls `definePlugin({ ... })` **exactly once**; and
- assigns the result to `module.exports`.

```js
const { definePlugin } = require("@16xbrains/plugin-sdk");

module.exports = definePlugin({
  id: "outsourced-analytics",          // /^[a-z0-9][a-z0-9_-]{1,63}$/
  version: "1.2.0",                    // strict numeric semver x.y.z
  handler: async (payload, ctx) => {
    ctx.log("info", "scoring record");
    // payload.user_email === "[TOKEN_MASK_SHA256_8cc63f…]" — a token, never raw PII
    const res = await ctx.fetch({
      url: "https://api.verified-partner.com/score",   // allowlisted domains only
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { ...payload, score: JSON.parse(res.body).score };
  },
});
```

Your handler receives an **already-sanitized** payload (PII is tokenized before
you ever see it) and a `ctx` with `fetch`, `log`, and `meta`. It must return a
JSON object.

## What is NOT available inside the sandbox

This list is **enforced by the isolate**, not advisory. Each item is absent by
construction, with the one-line reason why:

- **`process` (including `process.env`)** — the isolate has no host process; env
  secrets can't be reached or exfiltrated.
- **`require` / `import` of anything but the SDK** — no module graph exists
  inside the isolate; supply-chain reach is eliminated.
- **Filesystem** — no `fs`; a plugin cannot read or write host files.
- **All network primitives (`fetch`, `http`, sockets)** — the only egress is
  `ctx.fetch`, and only to allowlisted domains; there is no other way out.
- **`eval` / `new Function`** — rejected by the AST gate before the plugin ever
  runs; no dynamic code.
- **Timers (`setTimeout` / `setInterval`)** — they don't exist; a plugin can't
  schedule work past its invocation.
- **Persistent state between invocations** — every call gets a fresh context;
  nothing you stash survives to the next call.
- **`Buffer`** — a Node host type, not part of the ECMAScript sandbox.
- **`console`** — use `ctx.log` so lines are attributed and rate-limited.

**Available:** the full ECMAScript standard library — `JSON`, `Math`, `Date`,
`RegExp`, `Promise`, `Array`, `Object`, string/number APIs, and so on.

## `ctx.fetch` — the only way out

`ctx.fetch({ url, method, headers?, body? })` executes **host-side** against the
deployment's domain allowlist:

- `https://` only; `http://` is denied.
- The hostname must match `allowedOutboundDomains` exactly, or a `*.example.com`
  wildcard (which matches subdomains but not the apex).
- `GET` and `POST` only. Redirects are followed manually (max 3) and **every**
  hop is re-checked against the allowlist.
- The response body is capped at 1 MiB; the call times out at 2 s.

An off-list call **throws inside your handler** (`EGRESS_DENIED: <hostname>`)
and is audit-logged. If you need a domain, ask the operator to add it — you
cannot widen the allowlist from plugin code.

## `ctx.log`

`ctx.log(level, message)` forwards to the gateway's logger, prefixed with the
plugin and request ids. It is rate-limited to 100 lines per invocation (beyond
that, lines are dropped and a single warning is emitted). Use it instead of
`console` — which does not exist here.

## Local harness — fail at dev time, not deploy time

The CLI runs the **real** gate and the **real** isolate, so a local pass means a
production pass.

```bash
16xgateway check ./my-plugin.js --policy=strict
16xgateway run   ./my-plugin.js --payload=./fixture.json
```

`check` prints one line per violation and exits `0` only if the plugin is
admissible; `run` gates first, then executes against your fixture and prints the
result envelope.

Sample failing output (a plugin that reaches for the environment and the
filesystem):

```
POL-GLOBAL-PROC 2:14 the 'process' global is not available
POL-REQUIRE 3:19 require() is restricted to '@16xbrains/plugin-sdk' with a string literal
exit code: 1
```

Each line is `POL-CODE line:col message`. Fix them until `check` is silent and
exits `0`.

## Debugging tips

- **No `console`.** Use `ctx.log("debug", ...)`. It's the only output channel.
- **No timers.** Don't poll or sleep; do the work synchronously or with awaited
  promises that settle within `timeoutMs`.
- **Fresh context every call.** Don't rely on module-level caches surviving
  between invocations — they won't. Compute what you need inside the handler.
- **Return JSON only.** Functions, `undefined` at the top level, and circular
  references make the result invalid (`SBX-RESULT-INVALID`).

## Delivery checklist

- [ ] `16xgateway check` passes at **strict** (exit 0, no output).
- [ ] `16xgateway run` against a representative fixture round-trips and returns
      `ok: true` with the shape you expect.
- [ ] `version` bumped (strict numeric semver) — a new version is a new
      admission; rollbacks are done by revoking a version.
- [ ] Exactly **one** file, one `definePlugin`, SDK-only `require`.
