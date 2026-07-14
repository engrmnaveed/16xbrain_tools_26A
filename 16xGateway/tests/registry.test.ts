import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyScanner } from "../src/policy/index.js";
import { createPluginRegistry } from "../src/registry/index.js";

const scanner = createPolicyScanner();

async function freshDir(): Promise<string> {
  const dir = join(tmpdir(), `16xreg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function clean(id: string, version: string): string {
  return `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
    id:"${id}", version:"${version}", handler:function(p,ctx){ return { ok:true }; } });`;
}

const HOSTILE = `const a = process.env.X; const fs = require("fs"); eval("1");
  module.exports = definePlugin({ id:"h", version:"1.0.0", handler:function(){ return {}; } });`;

test("admit clean → admitted, file + hash present", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  const res = await reg.admit(clean("outsourced-analytics", "1.0.0"), "outsourced-analytics", "1.0.0", "tester");
  assert.equal(res.admitted, true);
  if (res.admitted) {
    const onDisk = await fs.readFile(res.entry.sourcePath, "utf8");
    assert.ok(onDisk.includes("definePlugin"));
    assert.equal(res.entry.sha256.length, 64);
  }
});

test("duplicate id+version → REG-DUPLICATE", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  await reg.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  const dup = await reg.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  assert.equal(dup.admitted, false);
  if (!dup.admitted) assert.ok(dup.reasonCodes.includes("REG-DUPLICATE"));
});

test("admit hostile → not admitted, policyReport present, no file written", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  const res = await reg.admit(HOSTILE, "h", "1.0.0", "t");
  assert.equal(res.admitted, false);
  if (!res.admitted) {
    assert.ok(res.policyReport);
    assert.ok(res.reasonCodes.length >= 3);
  }
  await assert.rejects(fs.access(join(dir, "h", "1.0.0", "plugin.cjs")));
});

test("bad id / bad version rejected", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  const badId = await reg.admit(clean("BadID", "1.0.0"), "BadID", "1.0.0", "t");
  assert.equal(badId.admitted, false);
  if (!badId.admitted) assert.ok(badId.reasonCodes.includes("REG-BAD-ID"));
  const badVer = await reg.admit(clean("p", "1.0"), "p", "1.0", "t");
  assert.equal(badVer.admitted, false);
  if (!badVer.admitted) assert.ok(badVer.reasonCodes.includes("REG-BAD-VERSION"));
});

test("revoke → resolve returns null", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  await reg.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  assert.ok(await reg.resolve("p"));
  assert.equal(await reg.revoke("p", "1.0.0", "bad"), true);
  assert.equal(await reg.resolve("p"), null);
  assert.equal(await reg.resolve("p", "1.0.0"), null);
});

test("tampered stored file → loadVerifiedSource throws REG-HASH-MISMATCH", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  const res = await reg.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  assert.ok(res.admitted);
  if (res.admitted) {
    await fs.writeFile(res.entry.sourcePath, "module.exports = 1; // tampered", "utf8");
    await assert.rejects(
      () => reg.loadVerifiedSource(res.entry),
      (e: Error & { code?: string }) => e.code === "REG-HASH-MISMATCH",
    );
  }
});

test("two-version resolve picks highest active after revoking newest", async () => {
  const dir = await freshDir();
  const reg = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  await reg.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  await reg.admit(clean("p", "1.2.0"), "p", "1.2.0", "t");
  let r = await reg.resolve("p");
  assert.equal(r?.version, "1.2.0");
  await reg.revoke("p", "1.2.0", "rollback");
  r = await reg.resolve("p");
  assert.equal(r?.version, "1.0.0");
});

test("reload re-reads store from disk", async () => {
  const dir = await freshDir();
  const regA = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  const regB = createPluginRegistry({ rootDir: dir, scanner, policyLevel: "strict" });
  // Force regB to load its (empty) cache BEFORE regA writes.
  assert.equal(await regB.resolve("p"), null);
  await regA.admit(clean("p", "1.0.0"), "p", "1.0.0", "t");
  // regB still holds its cached empty snapshot until reload.
  assert.equal(await regB.resolve("p"), null);
  await regB.reload();
  assert.ok(await regB.resolve("p"));
});
