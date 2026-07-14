/* ============================================================================
 * 16xGateway — src/policy/rules.ts
 * Individual AST rule functions over an acorn ESTree. A tiny recursive visitor
 * (index.ts) drives these; each rule inspects one node and pushes violations.
 *
 * Coverage philosophy: collect ALL violations, never stop at the first. The
 * gate is supply-chain hygiene + fast feedback; the isolate is the real
 * boundary. Precision of reason codes here IS the flagship demo.
 * ==========================================================================*/

import type { PolicyLevel, PolicyReasonCode, PolicyViolation } from "../types/index.js";

/* Minimal structural ESTree typing — acorn returns plain objects with .type. */
export interface Node {
  type: string;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

export interface RuleContext {
  level: PolicyLevel;
  violations: PolicyViolation[];
  /** Running tally used by POL-SHAPE at the end of the walk. */
  definePluginCalls: number;
  moduleExportsAssignments: number;
}

function loc(node: Node): { line: number | null; column: number | null } {
  if (node.loc && node.loc.start) {
    return { line: node.loc.start.line, column: node.loc.start.column };
  }
  return { line: null, column: null };
}

function push(
  ctx: RuleContext,
  code: PolicyReasonCode,
  message: string,
  node: Node,
): void {
  const { line, column } = loc(node);
  ctx.violations.push({ code, message, line, column });
}

function isIdentifier(node: unknown, name: string): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    (node as Node).type === "Identifier" &&
    (node as Node)["name"] === name
  );
}

function calleeName(node: Node): string | null {
  const callee = node["callee"] as Node | undefined;
  if (callee && callee.type === "Identifier") return callee["name"] as string;
  return null;
}

/* --------------------------- per-node rules ------------------------------- */

export function ruleIdentifier(node: Node, ctx: RuleContext): void {
  const name = node["name"] as string;
  if (name === "eval") {
    push(ctx, "POL-EVAL", "eval is not permitted in plugin code", node);
  } else if (
    name === "Function" ||
    name === "AsyncFunction" ||
    name === "GeneratorFunction"
  ) {
    push(
      ctx,
      "POL-FUNC-CTOR",
      `${name} constructor is not permitted (dynamic code)`,
      node,
    );
  } else if (name === "process") {
    push(ctx, "POL-GLOBAL-PROC", "the 'process' global is not available", node);
  } else if (name === "globalThis" && ctx.level === "strict") {
    push(ctx, "POL-GLOBAL-THIS", "'globalThis' is not permitted at strict level", node);
  }
}

export function ruleCallExpression(node: Node, ctx: RuleContext): void {
  const name = calleeName(node);
  if (name === "definePlugin") ctx.definePluginCalls += 1;

  if (name === "require") {
    const args = (node["arguments"] as Node[]) ?? [];
    const first = args[0];
    const isAllowlisted =
      first &&
      first.type === "Literal" &&
      first["value"] === "@16xbrains/plugin-sdk";
    if (!isAllowlisted) {
      push(
        ctx,
        "POL-REQUIRE",
        "require() is restricted to '@16xbrains/plugin-sdk' with a string literal",
        node,
      );
    }
  }

  // Object.setPrototypeOf / Reflect.setPrototypeOf → POL-PROTO
  const callee = node["callee"] as Node | undefined;
  if (callee && callee.type === "MemberExpression") {
    const obj = callee["object"] as Node | undefined;
    const prop = callee["property"] as Node | undefined;
    const propName =
      prop && prop.type === "Identifier"
        ? (prop["name"] as string)
        : prop && prop.type === "Literal"
          ? String(prop["value"])
          : null;
    if (
      propName === "setPrototypeOf" &&
      obj &&
      obj.type === "Identifier" &&
      (obj["name"] === "Object" || obj["name"] === "Reflect")
    ) {
      push(ctx, "POL-PROTO", `${obj["name"]}.setPrototypeOf is not permitted`, node);
    }
  }
}

export function ruleNewExpression(node: Node, ctx: RuleContext): void {
  const callee = node["callee"] as Node | undefined;
  if (
    callee &&
    callee.type === "Identifier" &&
    (callee["name"] === "Function" ||
      callee["name"] === "AsyncFunction" ||
      callee["name"] === "GeneratorFunction")
  ) {
    push(
      ctx,
      "POL-FUNC-CTOR",
      `new ${callee["name"]}(...) is not permitted (dynamic code)`,
      node,
    );
  }
}

export function ruleMemberExpression(node: Node, ctx: RuleContext): void {
  const prop = node["property"] as Node | undefined;
  const computed = node["computed"] === true;

  // __proto__ access in any member form
  if (prop) {
    if (!computed && prop.type === "Identifier" && prop["name"] === "__proto__") {
      push(ctx, "POL-PROTO", "__proto__ access is not permitted", node);
    }
    if (computed && prop.type === "Literal" && prop["value"] === "__proto__") {
      push(ctx, "POL-PROTO", "__proto__ access is not permitted", node);
    }
  }

  // .constructor escape (strict only)
  if (ctx.level === "strict" && prop) {
    if (!computed && prop.type === "Identifier" && prop["name"] === "constructor") {
      push(ctx, "POL-CTOR-ESCAPE", ".constructor access is not permitted", node);
    } else if (computed && prop.type === "Literal" && prop["value"] === "constructor") {
      push(
        ctx,
        "POL-CTOR-ESCAPE",
        "computed ['constructor'] access is not permitted",
        node,
      );
    } else if (computed && prop.type !== "Literal") {
      // Dynamic key could spell "constructor" at runtime.
      push(
        ctx,
        "POL-CTOR-ESCAPE",
        "computed member access with a non-literal key is not permitted at strict level",
        node,
      );
    }
  }
}

export function ruleAssignmentOrProto(node: Node, ctx: RuleContext): void {
  // module.exports assignment tally + .prototype assignment detection.
  const left = node["left"] as Node | undefined;
  if (!left) return;

  if (isModuleExports(left)) {
    ctx.moduleExportsAssignments += 1;
  }

  if (memberChainEndsInPrototype(left)) {
    push(ctx, "POL-PROTO", "assignment to a .prototype chain is not permitted", node);
  }
}

export function rulePropertyKeyProto(node: Node, ctx: RuleContext): void {
  // Object literal { __proto__: ... } — Property with key __proto__.
  const key = node["key"] as Node | undefined;
  const computed = node["computed"] === true;
  if (!key) return;
  if (!computed && key.type === "Identifier" && key["name"] === "__proto__") {
    push(ctx, "POL-PROTO", "__proto__ property key is not permitted", node);
  }
  if (computed && key.type === "Literal" && key["value"] === "__proto__") {
    push(ctx, "POL-PROTO", "__proto__ property key is not permitted", node);
  }
}

export function ruleWith(node: Node, ctx: RuleContext): void {
  push(ctx, "POL-WITH", "with statements are not permitted", node);
}

export function ruleImportDecl(node: Node, ctx: RuleContext): void {
  push(ctx, "POL-IMPORT", "ESM import/export is not permitted (plugins are CommonJS)", node);
}

export function ruleImportExpression(node: Node, ctx: RuleContext): void {
  push(ctx, "POL-DYN-IMPORT", "dynamic import() is not permitted", node);
}

/* ------------------------------- helpers ---------------------------------- */

function isModuleExports(node: Node): boolean {
  // module.exports (member) or module["exports"]
  if (node.type !== "MemberExpression") return false;
  const obj = node["object"] as Node | undefined;
  const prop = node["property"] as Node | undefined;
  if (!obj || !prop) return false;
  if (!isIdentifier(obj, "module")) return false;
  if (node["computed"] === true) {
    return prop.type === "Literal" && prop["value"] === "exports";
  }
  return prop.type === "Identifier" && prop["name"] === "exports";
}

function memberChainEndsInPrototype(node: Node): boolean {
  let cur: Node | undefined = node;
  while (cur && cur.type === "MemberExpression") {
    const prop = cur["property"] as Node | undefined;
    if (
      prop &&
      cur["computed"] !== true &&
      prop.type === "Identifier" &&
      prop["name"] === "prototype"
    ) {
      return true;
    }
    if (
      prop &&
      cur["computed"] === true &&
      prop.type === "Literal" &&
      prop["value"] === "prototype"
    ) {
      return true;
    }
    cur = cur["object"] as Node | undefined;
  }
  return false;
}
