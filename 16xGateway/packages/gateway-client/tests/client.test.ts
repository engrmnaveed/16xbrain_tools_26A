import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { Gateway } from "../src/index.js";
import { gatewayMiddleware } from "../src/middleware.js";
import { attachGatewayConsumer } from "../src/events.js";
import { EventEmitter } from "node:events";
import type { GatewayResult, JsonObject } from "../src/types.js";

function sockPath(): string {
  return join(tmpdir(), `16xgw-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
}

function startServer(sock: string, handler: (body: unknown) => unknown): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const out = handler(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(sock, () => resolve(server)));
}

test("success envelope passes through verbatim", async () => {
  const sock = sockPath();
  const canned: GatewayResult = {
    status: "success",
    data: { user_email: "boss@client.com", result: "ok" },
    unmasked: true,
    requestId: "r",
    pluginId: "p",
    pluginVersion: "1.0.0",
    durationMs: 5,
    sanitized: true,
    timestamp: new Date().toISOString(),
  };
  const server = await startServer(sock, () => canned);
  const gw = new Gateway({ socket: sock });
  const out = await gw.execute("p", { user_email: "boss@client.com" });
  assert.deepEqual(out, canned);
  await gw.close();
  server.close();
  if (existsSync(sock)) unlinkSync(sock);
});

test("server absent → unavailable, fail-closed has no passthrough", async () => {
  const gw = new Gateway({ socket: sockPath(), connect: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 } });
  const out = await gw.execute("p", { a: 1 });
  assert.equal(out.status, "unavailable");
  if (out.status === "unavailable") {
    assert.equal(out.mode, "fail-closed");
    assert.equal(out.passthrough, undefined);
  }
  await gw.close();
});

test("fail-open carries the exact original payload", async () => {
  const gw = new Gateway({
    socket: sockPath(),
    failureMode: "fail-open",
    connect: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 },
  });
  const payload: JsonObject = { a: 1, nested: { b: "x" } };
  const out = await gw.execute("p", payload);
  assert.equal(out.status, "unavailable");
  if (out.status === "unavailable") {
    assert.equal(out.mode, "fail-open");
    assert.deepEqual(out.passthrough, payload);
  }
  await gw.close();
});

test("breaker: 6th call after 5 failures returns fast with no I/O", async () => {
  const gw = new Gateway({
    socket: sockPath(),
    connect: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    breaker: { threshold: 5, cooldownMs: 10_000 },
  });
  for (let i = 0; i < 5; i++) await gw.execute("p", {});
  const t0 = performance.now();
  const out = await gw.execute("p", {});
  const dt = performance.now() - t0;
  assert.equal(out.status, "unavailable");
  assert.ok(dt < 5, `expected sub-5ms, got ${dt.toFixed(2)}ms`);
  await gw.close();
});

test("half-open probe restores service after cooldown", async () => {
  const sock = sockPath();
  const gw = new Gateway({
    socket: sock,
    connect: { retries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    breaker: { threshold: 3, cooldownMs: 30 },
  });
  for (let i = 0; i < 3; i++) await gw.execute("p", {});
  // Breaker open now.
  const blocked = await gw.execute("p", {});
  assert.equal(blocked.status, "unavailable");
  // Bring the server up and wait past cooldown.
  const server = await startServer(sock, () => ({
    status: "success", data: {}, unmasked: true, requestId: "r", pluginId: "p",
    pluginVersion: "1.0.0", durationMs: 1, sanitized: true, timestamp: "t",
  }));
  await new Promise((r) => setTimeout(r, 45));
  const out = await gw.execute("p", {});
  assert.equal(out.status, "success");
  await gw.close();
  server.close();
  if (existsSync(sock)) unlinkSync(sock);
});

test("execute(123, {}) throws TypeError synchronously", () => {
  const gw = new Gateway({ socket: sockPath() });
  assert.throws(() => {
    // @ts-expect-error intentional misuse
    void gw.execute(123, {});
  }, TypeError);
});

test("middleware: success replaces body; rejected → 502; onResult honored", async () => {
  const sock = sockPath();
  let mode: "success" | "rejected" = "success";
  const server = await startServer(sock, () =>
    mode === "success"
      ? { status: "success", data: { enriched: true }, unmasked: true, requestId: "r", pluginId: "p", pluginVersion: "1.0.0", durationMs: 1, sanitized: true, timestamp: "t" }
      : { status: "rejected", reasonCodes: ["REG-UNKNOWN"], message: "no", requestId: "r", pluginId: "p", pluginVersion: null, durationMs: 1, sanitized: true, timestamp: "t" },
  );
  const gw = new Gateway({ socket: sock });
  const mw = gatewayMiddleware({ gateway: gw, pluginId: "p" });

  // success
  const req1 = { body: { a: 1 } };
  let nexted = false;
  await mw(req1, { status: () => ({ json: () => {} }) } as never, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.deepEqual(req1.body, { enriched: true });

  // rejected → 502
  mode = "rejected";
  const req2 = { body: { a: 1 } };
  let code = 0;
  let payload: unknown;
  const res = { status(c: number) { code = c; return this; }, json(p: unknown) { payload = p; } };
  await mw(req2, res as never, () => {});
  assert.equal(code, 502);
  assert.deepEqual(payload, { status: "rejected", reasonCodes: ["REG-UNKNOWN"] });

  // onResult override
  let overrode = false;
  const mw2 = gatewayMiddleware({ gateway: gw, pluginId: "p", onResult: () => { overrode = true; } });
  await mw2({ body: { a: 1 } }, res as never, () => {});
  assert.equal(overrode, true);

  await gw.close();
  server.close();
  if (existsSync(sock)) unlinkSync(sock);
});

test("events: 25 requests, cap 10, never exceeds 10 concurrent", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const fakeGateway = {
    async execute() {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
      return { status: "success", data: {}, unmasked: true, requestId: "r", pluginId: "p", pluginVersion: "1.0.0", durationMs: 1, sanitized: true, timestamp: "t" } as GatewayResult;
    },
  } as unknown as Gateway;

  const emitter = new EventEmitter();
  const received = new Set<number>();
  emitter.on("gateway:result", (p: { requestId: number }) => received.add(p.requestId));
  attachGatewayConsumer(emitter, { gateway: fakeGateway, pluginId: "p", concurrency: 10 });

  for (let i = 0; i < 25; i++) emitter.emit("gateway:execute", { requestId: i, payload: { i } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(maxConcurrent <= 10, `maxConcurrent=${maxConcurrent}`);
  assert.equal(received.size, 25);
});
