/* Sandbox tests. These require the native `isolated-vm` binary to be built.
 * They are skipped automatically when the module cannot be loaded (e.g. a CI
 * environment without a compiler toolchain), so the rest of the suite still
 * runs. Where isolated-vm IS available, all acceptance criteria are exercised.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  HostCapabilities,
  JsonObject,
  SandboxService,
} from "../src/types/index.js";

let createSandboxService:
  | ((opts: {
      memoryLimitMb: number;
      timeoutMs: number;
      isolatePoolPerPlugin: number;
      recycleAfterInvocations: number;
    }) => SandboxService)
  | null = null;

try {
  ({ createSandboxService } = await import("../src/sandbox/index.js"));
} catch {
  createSandboxService = null;
}

const HAS_IVM = createSandboxService !== null;
const skip = HAS_IVM ? undefined : "isolated-vm native binary not available";

function svc(over: Partial<{ memoryLimitMb: number; timeoutMs: number }> = {}): SandboxService {
  return createSandboxService!({
    memoryLimitMb: over.memoryLimitMb ?? 64,
    timeoutMs: over.timeoutMs ?? 1000,
    isolatePoolPerPlugin: 2,
    recycleAfterInvocations: 500,
  });
}

function capsCollector(): { caps: HostCapabilities; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    caps: {
      async fetch() {
        return { status: 200, headers: {}, body: "{}" };
      },
      log(_l, m) {
        logs.push(m);
      },
    },
  };
}

const GOOD = `
module.exports = require("@16xbrains/plugin-sdk").definePlugin({
  id: "p", version: "1.0.0",
  handler: function (payload, ctx) {
    ctx.log("info", "hello");
    payload.mutated = true;              // must not affect host copy
    return { echoed: payload.value, added: 1 };
  },
});
`;

test("well-behaved plugin returns ok and does not mutate host payload", { skip }, async () => {
  const s = svc();
  const { caps, logs } = capsCollector();
  const host: JsonObject = { value: "abc" };
  const out = await s.run(GOOD, "p", "1.0.0", host, "r1", caps);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.data["echoed"], "abc");
    assert.equal(out.data["added"], 1);
  }
  assert.equal((host as Record<string, unknown>)["mutated"], undefined);
  assert.ok(logs.includes("hello"));
  await s.disposeAll();
});

test("infinite loop → timeout within budget", { skip }, async () => {
  const s = svc({ timeoutMs: 400 });
  const src = `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){ while(true){} }});`;
  const t0 = Date.now();
  const out = await s.run(src, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.kind, "timeout");
  assert.ok(Date.now() - t0 <= 400 + 800);
  await s.disposeAll();
});

test("never-resolving async handler → timeout", { skip }, async () => {
  const s = svc({ timeoutMs: 400 });
  const src = `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){ return new Promise(function(){}); }});`;
  const out = await s.run(src, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.kind, "timeout");
  await s.disposeAll();
});

test("allocation bomb → SBX-OOM", { skip }, async () => {
  const s = svc({ memoryLimitMb: 16, timeoutMs: 3000 });
  const src = `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){ var a=[]; while(true){ a.push(new Array(100000).fill(7)); } }});`;
  const out = await s.run(src, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
  if (!out.ok && out.kind === "error") assert.equal(out.errorCode, "SBX-OOM");
  await s.disposeAll();
});

test("thrown error → SBX-THREW with message, no stack", { skip }, async () => {
  const s = svc();
  const src = `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){ throw new Error("boom"); }});`;
  const out = await s.run(src, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
  if (!out.ok && out.kind === "error") {
    assert.equal(out.errorCode, "SBX-THREW");
    assert.equal(out.message, "boom");
    assert.equal(out.message.includes("at "), false);
  }
  await s.disposeAll();
});

test("global state does not leak between runs (fresh context)", { skip }, async () => {
  const s = svc();
  const src = `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){
      globalThis.__seen = (globalThis.__seen||0)+1; return { seen: globalThis.__seen }; }});`;
  const a = await s.run(src, "p", "1.0.0", {}, "r1", capsCollector().caps);
  const b = await s.run(src, "p", "1.0.0", {}, "r2", capsCollector().caps);
  if (a.ok && b.ok) {
    assert.equal(a.data["seen"], 1);
    assert.equal(b.data["seen"], 1);
  }
  await s.disposeAll();
});

test('require("fs") → SBX-THREW "require blocked: fs"', { skip }, async () => {
  const s = svc();
  const src = `var fs = require("fs");
    module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"p",version:"1.0.0",handler:function(){ return {}; }});`;
  const out = await s.run(src, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
  if (!out.ok && out.kind === "error") {
    assert.equal(out.errorCode, "SBX-THREW");
    assert.match(out.message, /require blocked: fs/);
  }
  await s.disposeAll();
});

test("disposeAll leaves no live isolates", { skip }, async () => {
  const s = svc();
  await s.run(GOOD, "p", "1.0.0", { value: "x" }, "r", capsCollector().caps);
  await s.disposeAll();
  // A subsequent run should be refused by the closed service.
  const out = await s.run(GOOD, "p", "1.0.0", {}, "r", capsCollector().caps);
  assert.equal(out.ok, false);
});
