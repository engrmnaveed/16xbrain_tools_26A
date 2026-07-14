import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { definePlugin } from "../src/index.js";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../src/cli.js"); // dist/src/cli.js at runtime

test("valid definition is frozen and returned", () => {
  const def = definePlugin({
    id: "outsourced-analytics",
    version: "1.2.0",
    handler: (p) => ({ ...p, ok: true }),
  });
  assert.equal(def.id, "outsourced-analytics");
  assert.equal(Object.isFrozen(def), true);
});

test("bad id throws TypeError naming the field", () => {
  assert.throws(
    () => definePlugin({ id: "Bad ID", version: "1.0.0", handler: () => ({}) }),
    /id/,
  );
});

test("bad semver throws (1.0 and v1.0.0)", () => {
  assert.throws(() => definePlugin({ id: "p", version: "1.0", handler: () => ({}) }), /version/);
  assert.throws(() => definePlugin({ id: "p", version: "v1.0.0", handler: () => ({}) }), /version/);
});

test("missing handler throws naming the field", () => {
  assert.throws(
    // @ts-expect-error intentional
    () => definePlugin({ id: "p", version: "1.0.0" }),
    /handler/,
  );
});

test("CLI check: hostile fixture exits 1 with >=3 POL codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-cli-"));
  const file = join(dir, "hostile.cjs");
  await writeFile(
    file,
    `const a = process.env.SECRET;
     const fs = require("fs");
     eval("1");
     import("x");
     module.exports = definePlugin({ id:"h", version:"1.0.0", handler:function(){ return {}; }});`,
    "utf8",
  );
  try {
    await execFileP(process.execPath, [CLI, "check", file, "--policy=strict"]);
    assert.fail("should have exited non-zero");
  } catch (e) {
    const err = e as { code: number; stdout: string };
    assert.equal(err.code, 1);
    const codes = new Set(err.stdout.split("\n").filter(Boolean).map((l) => l.split(" ")[0]));
    assert.ok(codes.size >= 3, `expected >=3 POL codes, got ${[...codes].join(",")}`);
  }
});

test("CLI check: clean fixture exits 0 silently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sdk-cli-"));
  const file = join(dir, "clean.cjs");
  await writeFile(
    file,
    `module.exports = require("@16xbrains/plugin-sdk").definePlugin({
       id:"clean-plugin", version:"1.0.0",
       handler: function (payload, ctx) { return { ok: true }; } });`,
    "utf8",
  );
  const { stdout } = await execFileP(process.execPath, [CLI, "check", file, "--policy=strict"]);
  assert.equal(stdout.trim(), "");
});
