import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config/index.js";

const MIN = {
  gateway: {
    socket: "/var/run/16xgateway.sock",
    environment: "production",
    secretKey: "a".repeat(32),
  },
  security: { maskPii: true },
};

test("minimal valid config loads with all defaults", () => {
  const c = parseConfig(structuredClone(MIN));
  assert.equal(c.gateway.port, 0);
  assert.equal(c.security.maskPii, true);
  assert.deepEqual(c.security.allowedOutboundDomains, []);
  assert.equal(c.security.maxMemoryMb, 128);
  assert.equal(c.security.timeoutMs, 3000);
  assert.equal(c.security.onGatewayUnavailable, "fail-closed");
  assert.equal(c.security.unmaskResponse, true);
  assert.equal(c.security.rescanOutput, true);
  assert.equal(c.security.maxPayloadBytes, 1_048_576);
  assert.equal(c.security.tokenHexLength, 12);
  assert.equal(c.security.policyLevel, "strict");
  assert.equal(c.security.adminToken, null);
  assert.equal(c.sandbox.isolatePoolPerPlugin, 2);
  assert.equal(c.sandbox.recycleAfterInvocations, 500);
  assert.equal(c.logging.level, "info");
  assert.equal(c.logging.auditFile, null);
});

test("unknown key rejected", () => {
  const bad = structuredClone(MIN) as Record<string, unknown>;
  (bad.security as Record<string, unknown>)["bogus"] = 1;
  assert.throws(() => parseConfig(bad), /unknown key "bogus"/);
});

test("maskPii:false rejected", () => {
  const bad = structuredClone(MIN);
  (bad.security as Record<string, unknown>).maskPii = false;
  assert.throws(() => parseConfig(bad), /maskPii/);
});

test("secretKey of 10 chars rejected", () => {
  const bad = structuredClone(MIN);
  bad.gateway.secretKey = "short";
  assert.throws(() => parseConfig(bad), /at least 32/);
});

test("error message aggregates multiple problems", () => {
  const bad = {
    gateway: { socket: "/s", environment: "production", secretKey: "short" },
    security: { maskPii: false, timeoutMs: "nope" },
  };
  try {
    parseConfig(bad);
    assert.fail("should have thrown");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /secretKey/);
    assert.match(msg, /maskPii/);
    assert.match(msg, /timeoutMs/);
  }
});
