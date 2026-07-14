import { test } from "node:test";
import assert from "node:assert/strict";
import { executePipeline, type PipelineDeps } from "../src/core/pipeline.js";
import { hostAllowed, makeCapabilities } from "../src/core/capabilities.js";
import { parseConfig } from "../src/config/index.js";
import type {
  GatewayConfig,
  HostCapabilities,
  JsonObject,
  PluginRegistry,
  PluginRegistryEntry,
  Sanitizer,
  SandboxRunOutcome,
  SandboxService,
} from "../src/types/index.js";

function cfg(over: Partial<GatewayConfig["security"]> = {}): GatewayConfig {
  const c = parseConfig({
    gateway: { socket: "/s", environment: "production", secretKey: "a".repeat(32) },
    security: { maskPii: true },
  });
  Object.assign(c.security, over);
  return c;
}

const ENTRY: PluginRegistryEntry = {
  id: "outsourced-analytics",
  version: "1.2.0",
  sha256: "0".repeat(64),
  sizeBytes: 10,
  status: "active",
  admittedAt: new Date().toISOString(),
  admittedBy: "test",
  policyReport: { ok: true, policyLevel: "strict", scannedBytes: 10, parseTimeMs: 0, violations: [] },
  sourcePath: "/tmp/x/plugin.cjs",
};

/** Stub reverse map: tokenizes emails deterministically, restores on demand. */
function stubSanitizer(order: string[]): Sanitizer {
  return {
    sanitize(payload: JsonObject) {
      order.push("sanitize");
      const map = new Map<string, string>();
      const walk = (v: unknown): unknown => {
        if (typeof v === "string" && v.includes("@")) {
          const tok = "[TOKEN_MASK_SHA256_8cc63f2a91b4]";
          map.set(tok, v);
          return tok;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const o: Record<string, unknown> = {};
          for (const k of Object.keys(v)) o[k] = walk((v as Record<string, unknown>)[k]);
          return o;
        }
        return v;
      };
      const sanitizedPayload = walk(payload) as JsonObject;
      let destroyed = false;
      return {
        requestId: "r",
        sanitizedPayload,
        matches: [...map.keys()].map((token) => ({ category: "email" as const, token, jsonPath: "$" })),
        reverseMap: {
          get size() { return map.size; },
          get destroyed() { return destroyed; },
          restore<T>(value: T): T {
            if (destroyed) throw new Error("ReverseMap destroyed");
            const s = JSON.stringify(value);
            let out = s;
            for (const [tok, orig] of map) out = out.split(JSON.stringify(tok).slice(1, -1)).join(orig);
            return JSON.parse(out) as T;
          },
          destroy() { order.push("destroy"); destroyed = true; },
        },
      };
    },
    scan() { return []; },
  };
}

function stubRegistry(entry: PluginRegistryEntry | null): PluginRegistry {
  return {
    async admit() { throw new Error("unused"); },
    async resolve() { return entry; },
    async revoke() { return false; },
    async list() { return entry ? [entry] : []; },
    async loadVerifiedSource() { return "SOURCE"; },
    async reload() {},
  };
}

function stubSandbox(outcome: SandboxRunOutcome | (() => Promise<SandboxRunOutcome>)): SandboxService {
  return {
    async run() { return typeof outcome === "function" ? outcome() : outcome; },
    async disposeAll() {},
  };
}

function deps(over: Partial<PipelineDeps> = {}, order: string[] = []): PipelineDeps {
  return {
    config: cfg(),
    sanitizer: stubSanitizer(order),
    registry: stubRegistry(ENTRY),
    sandbox: stubSandbox({ ok: true, data: { echoed: true }, durationMs: 3 }),
    audit: () => {},
    makeCapabilities: () => ({ async fetch() { throw new Error("no"); }, log() {} }),
    ...over,
  };
}

test("happy path: sanitize before sandbox.run, unmasked success", async () => {
  const order: string[] = [];
  const d = deps({}, order);
  d.sandbox = stubSandbox(async () => {
    order.push("sandbox.run");
    return { ok: true, data: { user_email: "[TOKEN_MASK_SHA256_8cc63f2a91b4]" }, durationMs: 2 };
  });
  const r = await executePipeline(d, { pluginId: "outsourced-analytics", payload: { user_email: "boss@client.com" } });
  assert.equal(r.status, "success");
  if (r.status === "success") {
    assert.equal(r.sanitized, true);
    assert.equal(r.unmasked, true);
    assert.equal((r.data as JsonObject)["user_email"], "boss@client.com");
  }
  assert.ok(order.indexOf("sanitize") < order.indexOf("sandbox.run"), order.join(","));
});

test("reverseMap.destroy() called once on success, timeout, error, and sync throw", async () => {
  for (const outcome of [
    { ok: true, data: {}, durationMs: 1 } as SandboxRunOutcome,
    { ok: false, kind: "timeout", durationMs: 1 } as SandboxRunOutcome,
    { ok: false, kind: "error", errorCode: "SBX-THREW", message: "x", durationMs: 1 } as SandboxRunOutcome,
  ]) {
    const order: string[] = [];
    const d = deps({}, order);
    d.sandbox = stubSandbox(outcome);
    await executePipeline(d, { pluginId: "outsourced-analytics", payload: { a: "boss@client.com" } });
    assert.equal(order.filter((o) => o === "destroy").length, 1, JSON.stringify(outcome));
  }
  // Sandbox stub throws synchronously.
  const order: string[] = [];
  const d = deps({}, order);
  d.sandbox = { async run() { throw new Error("kaboom"); }, async disposeAll() {} };
  const r = await executePipeline(d, { pluginId: "outsourced-analytics", payload: { a: "boss@client.com" } });
  assert.equal(r.status, "plugin_error");
  assert.equal(order.filter((o) => o === "destroy").length, 1);
});

test("reference exchange with unmaskResponse:false shows token", async () => {
  const order: string[] = [];
  const d = deps({ config: cfg({ unmaskResponse: false }) }, order);
  d.sanitizer = stubSanitizer(order);
  d.sandbox = stubSandbox({ ok: true, data: { user_email: "[TOKEN_MASK_SHA256_8cc63f2a91b4]" }, durationMs: 12 });
  const r = await executePipeline(d, { pluginId: "outsourced-analytics", payload: { user_email: "boss@client.com", action: "process" } });
  assert.equal(r.status, "success");
  if (r.status === "success") {
    assert.equal(r.sanitized, true);
    assert.match((r.data as JsonObject)["user_email"] as string, /^\[TOKEN_MASK_SHA256_[0-9a-f]+\]$/);
    assert.equal(r.unmasked, false);
  }
});

test("unknown plugin → REG-UNKNOWN", async () => {
  const d = deps({ registry: stubRegistry(null) });
  const r = await executePipeline(d, { pluginId: "nope", payload: {} });
  assert.equal(r.status, "rejected");
  if (r.status === "rejected") assert.ok(r.reasonCodes.includes("REG-UNKNOWN"));
});

test("oversized payload → GW-PAYLOAD-TOO-LARGE", async () => {
  const d = deps({ config: cfg({ maxPayloadBytes: 50 }) });
  const big = "x".repeat(200);
  const r = await executePipeline(d, { pluginId: "outsourced-analytics", payload: { big } });
  assert.equal(r.status, "rejected");
  if (r.status === "rejected") assert.ok(r.reasonCodes.includes("GW-PAYLOAD-TOO-LARGE"));
});

test("malformed envelope → GW-BADREQ", async () => {
  const d = deps();
  const r = await executePipeline(d, "not-an-object");
  assert.equal(r.status, "rejected");
  if (r.status === "rejected") assert.ok(r.reasonCodes.includes("GW-BADREQ"));
});

/* ------------------------------ capabilities ------------------------------ */

test("hostAllowed: exact, wildcard subdomain, not apex, deny others", () => {
  assert.equal(hostAllowed("api.verified-partner.com", ["api.verified-partner.com"]), true);
  assert.equal(hostAllowed("a.partner.com", ["*.partner.com"]), true);
  assert.equal(hostAllowed("partner.com", ["*.partner.com"]), false);
  assert.equal(hostAllowed("evil.example", ["api.verified-partner.com"]), false);
});

test("capabilities.fetch: allowed passes, denied/http rejected", async (t) => {
  const config = cfg({ allowedOutboundDomains: ["api.verified-partner.com", "*.partner.com"] });
  const events: Record<string, unknown>[] = [];
  const caps: HostCapabilities = makeCapabilities(config, "r", "p", {
    log: () => {},
    audit: (e) => events.push(e),
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const ok = await caps.fetch({ url: "https://api.verified-partner.com/x", method: "GET" });
  assert.equal(ok.status, 200);

  await assert.rejects(() => caps.fetch({ url: "https://evil.example", method: "GET" }), /EGRESS_DENIED/);
  await assert.rejects(() => caps.fetch({ url: "http://api.verified-partner.com", method: "GET" }), /EGRESS_DENIED/);
  await assert.rejects(() => caps.fetch({ url: "https://partner.com", method: "GET" }), /EGRESS_DENIED/);
  assert.ok(await caps.fetch({ url: "https://a.partner.com/y", method: "GET" }).then(() => true));
  assert.ok(events.some((e) => e["type"] === "egress_denied"));
});
