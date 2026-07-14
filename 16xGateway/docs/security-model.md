# 16xGateway — Security Model

**Audience:** a CISO or auditor evaluating 16xGateway. This document is
deliberately honest about limits. Overstating guarantees would be the real
security failure.

## What 16xGateway is

A self-hosted sidecar that sits between your application and untrusted
third-party plugin code. It tokenizes PII in a JSON payload before that code
runs, executes the code in a hard V8 isolate with no ambient capabilities, and
restores real values on the return trip. It runs entirely on your own machine;
there are **no cloud or AI calls at runtime**.

## Defends against

- **Careless or hostile plugin code reaching for `process.env`, the filesystem,
  the network, or the module graph.** None of these exist inside the isolate —
  the sandbox is an allowlist, so a capability is present only if the gateway
  injects it. The AST gate additionally refuses admission to code that even
  references them.
- **Raw PII exposure to third-party code.** PII is tokenized before the plugin
  sees it, using a per-request reverse map that is destroyed when the request
  ends.
- **Prototype-pollution and eval-family injection.** Blocked by the AST gate and
  contained by the isolate boundary.
- **Runaway loops and allocation bombs.** A wall-clock timeout and a hard memory
  ceiling kill and report the offender.
- **Tampered plugin files at rest.** Every cold load re-verifies the stored
  source hash; a mismatch is refused and alarmed (`REG-HASH-MISMATCH`).
- **Exfiltration via the network.** No egress primitive exists inside the
  isolate. The capability `fetch` is host-side, allowlisted, size-capped, and
  redirect-checked on every hop.

## Does NOT defend against — stated plainly

1. **A V8 isolate escape (0-day).** An escape lands in the gateway process,
   which holds in-flight reverse maps and the HMAC secret. Mitigations: maps are
   per-request and destroyed immediately, the in-flight window is minimal, and
   the AST gate is defense in depth. Roadmap: a split-process sandbox behind the
   `SandboxProvider` interface.
2. **PII regex false negatives.** Detection is heuristic. Unusual formats, PII
   embedded in free prose, non-Latin phone conventions, and numeric-typed values
   (only strings are scanned) can slip through. **16xGateway is not a DLP system
   and must not be sold as one.**
3. **Determined obfuscation against the AST gate.** The gate is supply-chain
   hygiene and fast feedback; the *isolate* is the actual boundary. A plugin
   that passes the gate still cannot reach env, fs, or net.
4. **Exfiltration to allowlisted domains.** Domains in `allowedOutboundDomains`
   are trusted by configuration. A hostile plugin may send (tokenized) data
   there. **Keep the allowlist empty unless a plugin genuinely requires it.**
5. **Timing/side channels, a malicious host application, or a compromised
   gateway box.** Out of scope; the gateway trusts its own host machine.
6. **`isolated-vm` maintenance-mode risk.** Upstream is minimally maintained. We
   pin Node exactly and treat sandbox-runtime replacement as a supported
   migration through the `SandboxProvider` abstraction.

## PII handling lifecycle

1. **Tokenize.** On ingress, string values matching the PII pattern set (and any
   value under a sensitive key) are replaced with a token of the form
   `[TOKEN_MASK_SHA256_<hex>]`. The token is **HMAC-SHA256** of the value under
   the deployment `secretKey`, truncated. HMAC (rather than a bare hash) prevents
   dictionary reversal of tokens; determinism preserves referential integrity so
   plugins can still group and join on the token.
2. **Per-request reverse map.** The token→value mapping lives only in memory,
   scoped to the single request, in private storage that is never logged.
3. **Destroy.** When the request ends — on success, timeout, error, or rejection
   alike — the reverse map is destroyed. After destruction the originals are
   unreachable and any restore attempt throws. This bounds the window in which
   real PII exists in process memory to a single request.

The plugin only ever sees tokens. If `unmaskResponse` is enabled (the
production default), the gateway restores real values *after* the plugin returns
and *before* the envelope reaches the host, so the host's business logic never
learns tokenization happened. Output is additionally re-scanned for raw PII as
defense in depth; any hit is redacted and audit-logged.

## Data residency

Everything runs on your box. Payloads are processed in memory; the reverse map
is never persisted; the audit log records **metadata only** (ids, statuses,
reason codes, token strings, byte counts) and never raw payload values. There
are no outbound calls at runtime except the explicit, allowlisted `ctx.fetch`
that a plugin makes on purpose.

## Not a DLP system

To restate criterion (2) as a headline: PII detection here is heuristic
tokenization to keep casual and hostile plugin code away from obvious
identifiers. It is **not** data-loss prevention, does not guarantee complete PII
coverage, and must not be represented as either.
