# 16xGateway — Runnable Demo

This directory contains a self-contained demonstration of what 16xGateway does:
it masks PII before untrusted third-party plugin code can see it, runs that code
in a hard V8 isolate, and rejects hostile plugins **at admission time** — before
a single line executes.

## The one command

```bash
# from the repo root, once:
npm install
npm run build

# then:
node examples/run-demo.js
```

No Docker, no global installs. The demo creates a temporary Unix-domain socket
and a temporary plugins directory, and tears everything down on exit.

> The sandbox uses the native `isolated-vm` module. If your machine lacks a
> compiler toolchain, `npm install` will not build it and the demo's execution
> step cannot run. See `docs/operations.md` for the one-time toolchain install.

## What it proves (annotated expected output)

1. **A good plugin is admitted.**

   ```
   ────────────────────────────────────────────────────────────────────────
   ADMITTING  outsourced-analytics@1.0.0  (good plugin)
   ────────────────────────────────────────────────────────────────────────
   ADMITTED  outsourced-analytics@1.0.0  sha256=…  status=active
   ```

2. **A hostile plugin is rejected — and never runs.** This is the headline.
   The plugin in `plugin-hostile/plugin.cjs` reaches for `process.env`, `fs`,
   `eval`, and dynamic `import`. The AST gate flags each one and refuses
   admission, so the source is never even written to disk:

   ```
   ────────────────────────────────────────────────────────────────────────
   REJECTED AT ADMISSION — POL-GLOBAL-PROC POL-REQUIRE POL-EVAL POL-DYN-IMPORT — 0 lines executed
   ────────────────────────────────────────────────────────────────────────
   plugins/outsourced-analytics on disk: [ 1.0.0 ]  (no 9.9.9 — good)
   ```

3. **PII is tokenized before the plugin sees it.** With `unmaskResponse:false`
   the tokens stay visible so you can watch it work:

   ```
   BEFORE (raw record the host holds):
     {"user_email":"boss@client.com", … ,"card":"4111 1111 1111 1111", …}

   WHAT THE PLUGIN SAW / WHAT CAME BACK (tokenized):
     {"user_email":"[TOKEN_MASK_SHA256_8cc63f2a91b4]", … }
   ```

   In production `unmaskResponse` defaults to **true**, so the host's business
   logic transparently gets real values back and never learns tokenization
   happened.

## The two integration patterns

`host-app/server.js` is a tiny Fastify "CRM" wired to the **same** gateway two
ways at once:

- **Endpoint A — `POST /customers/:idx/enrich`** uses the explicit
  **direct-call** pattern (`gateway.execute(...)`).
- **Endpoint B — `POST /analyze`** uses the **middleware** pattern
  (`fastifyGatewayHook`) so the handler needs zero changes.

Run it standalone (after starting a gateway) with:

```bash
GATEWAY_SOCKET=/path/to/gateway.sock PORT=3001 node host-app/server.js
```

## Files

| File | Role |
|---|---|
| `run-demo.js` | One-command orchestrator (start gateway → admit → reject → tokenize) |
| `host-app/server.js` | Example host app showing both integration patterns |
| `plugin-good/plugin.cjs` | A well-behaved, admissible plugin |
| `plugin-hostile/plugin.cjs` | A hostile plugin used to demonstrate rejection |
