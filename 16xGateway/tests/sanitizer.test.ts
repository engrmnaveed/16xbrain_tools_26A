import { test } from "node:test";
import assert from "node:assert/strict";
import { createSanitizer } from "../src/sanitizer/index.js";
import type { JsonObject } from "../src/types/index.js";

const SECRET = "unit-test-secret-key-that-is-well-over-32-chars";
const TOKEN_12 = /^\[TOKEN_MASK_SHA256_[0-9a-f]{12}\]$/;

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj as object)) {
      deepFreeze((obj as Record<string, unknown>)[k]);
    }
    Object.freeze(obj);
  }
  return obj;
}

test("email masked with 12-char hex token, other fields untouched", () => {
  const s = createSanitizer(SECRET, 12);
  const payload: JsonObject = { user_email: "boss@client.com", action: "process" };
  const pass = s.sanitize(payload, "req-1");
  assert.match(pass.sanitizedPayload["user_email"] as string, TOKEN_12);
  assert.equal(pass.sanitizedPayload["action"], "process");
  assert.equal(pass.matches.length, 1);
  assert.equal(pass.matches[0]!.category, "email");
});

test("round-trip restore deep-equals original", () => {
  const s = createSanitizer(SECRET, 12);
  const payload: JsonObject = {
    customer: { email: "a.b@example.co", phone: "+14155550123" },
    items: [{ note: "call 555-123-4567" }, { note: "nothing here" }],
  };
  const pass = s.sanitize(payload, "req-2");
  const restored = pass.reverseMap.restore(pass.sanitizedPayload);
  assert.deepEqual(restored, payload);
});

test("determinism: same value twice → identical token", () => {
  const s = createSanitizer(SECRET, 12);
  const payload: JsonObject = { a: "boss@client.com", b: "boss@client.com" };
  const pass = s.sanitize(payload, "req-3");
  assert.equal(pass.sanitizedPayload["a"], pass.sanitizedPayload["b"]);
  const restored = pass.reverseMap.restore(pass.sanitizedPayload) as JsonObject;
  assert.equal(restored["a"], "boss@client.com");
  assert.equal(restored["b"], "boss@client.com");
});

test("Luhn: valid card masked, invalid card not masked", () => {
  const s = createSanitizer(SECRET, 12);
  const good = s.sanitize({ c: "4111 1111 1111 1111" }, "r");
  assert.notEqual(good.sanitizedPayload["c"], "4111 1111 1111 1111");
  assert.equal(good.matches[0]!.category, "credit_card");

  const bad = s.sanitize({ c: "1234 5678 9012 3456" }, "r");
  assert.equal(bad.sanitizedPayload["c"], "1234 5678 9012 3456");
  assert.equal(bad.matches.length, 0);
});

test("sensitive key masks whole value", () => {
  const s = createSanitizer(SECRET, 12);
  const pass = s.sanitize({ password: "hunter2" }, "r");
  assert.match(pass.sanitizedPayload["password"] as string, TOKEN_12);
  assert.equal(pass.matches[0]!.category, "sensitive_key");
  const restored = pass.reverseMap.restore(pass.sanitizedPayload) as JsonObject;
  assert.equal(restored["password"], "hunter2");
});

test("destroy(): restore throws afterwards; destroy twice is safe", () => {
  const s = createSanitizer(SECRET, 12);
  const pass = s.sanitize({ user_email: "x@y.com" }, "r");
  pass.reverseMap.destroy();
  assert.throws(() => pass.reverseMap.restore(pass.sanitizedPayload), /destroyed/);
  assert.doesNotThrow(() => pass.reverseMap.destroy());
  assert.equal(pass.reverseMap.destroyed, true);
});

test("input payload not mutated (deep-frozen)", () => {
  const s = createSanitizer(SECRET, 12);
  const payload = deepFreeze({ user_email: "boss@client.com", n: 42 } as JsonObject);
  assert.doesNotThrow(() => s.sanitize(payload, "r"));
  assert.equal(payload["user_email"], "boss@client.com");
});

test("matches never carry the raw value", () => {
  const s = createSanitizer(SECRET, 12);
  const pass = s.sanitize({ user_email: "boss@client.com" }, "r");
  const serialized = JSON.stringify(pass.matches);
  assert.equal(serialized.includes("boss@client.com"), false);
});

test("performance: 1 MiB adversarial near-matches sanitizes < 250ms", () => {
  const s = createSanitizer(SECRET, 12);
  const chunk = "aaaa@" + "1".repeat(20) + " ";
  const big = chunk.repeat(Math.ceil((1024 * 1024) / chunk.length));
  const payload: JsonObject = { blob: big };
  const t0 = performance.now();
  s.sanitize(payload, "r");
  const dt = performance.now() - t0;
  assert.ok(dt < 250, `sanitize took ${dt.toFixed(1)}ms`);
});

test("scan() returns spans without allocating tokens", () => {
  const s = createSanitizer(SECRET, 12);
  const spans = s.scan("reach me at boss@client.com or 555-123-4567");
  assert.ok(spans.length >= 2);
  for (const sp of spans) {
    assert.ok(sp.start >= 0 && sp.end > sp.start);
  }
});
