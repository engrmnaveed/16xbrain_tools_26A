/* ============================================================================
 * 16xGateway — src/policy/index.ts
 * createPolicyScanner(): parse with acorn, walk the ESTree with a small
 * recursive visitor, apply every rule, aggregate violations → PolicyResult.
 * ==========================================================================*/

import { Parser } from "acorn";
import type {
  PolicyLevel,
  PolicyReasonCode,
  PolicyResult,
  PolicyScanner,
  PolicyViolation,
} from "../types/index.js";
import {
  type Node,
  type RuleContext,
  ruleAssignmentOrProto,
  ruleCallExpression,
  ruleIdentifier,
  ruleImportDecl,
  ruleImportExpression,
  ruleMemberExpression,
  ruleNewExpression,
  rulePropertyKeyProto,
  ruleWith,
} from "./rules.js";

const MAX_BYTES = 524_288; // 512 KiB

/** Child keys we skip so we never descend into acorn bookkeeping fields. */
const SKIP_KEYS = new Set(["loc", "start", "end", "range", "type", "sourceType"]);

function visit(node: Node, ctx: RuleContext): void {
  switch (node.type) {
    case "Identifier":
      ruleIdentifier(node, ctx);
      break;
    case "CallExpression":
      ruleCallExpression(node, ctx);
      break;
    case "NewExpression":
      ruleNewExpression(node, ctx);
      break;
    case "MemberExpression":
      ruleMemberExpression(node, ctx);
      break;
    case "AssignmentExpression":
      ruleAssignmentOrProto(node, ctx);
      break;
    case "Property":
      rulePropertyKeyProto(node, ctx);
      break;
    case "WithStatement":
      ruleWith(node, ctx);
      break;
    case "ImportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
    case "ExportAllDeclaration":
      ruleImportDecl(node, ctx);
      break;
    case "ImportExpression":
      ruleImportExpression(node, ctx);
      break;
    default:
      break;
  }

  // Recurse into every child node/array of nodes.
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c === "object" && typeof (c as Node).type === "string") {
          visit(c as Node, ctx);
        }
      }
    } else if (child && typeof child === "object" && typeof (child as Node).type === "string") {
      visit(child as Node, ctx);
    }
  }
}

export function createPolicyScanner(): PolicyScanner {
  return {
    scan(source: string, level: PolicyLevel): PolicyResult {
      const scannedBytes = Buffer.byteLength(source, "utf8");
      const t0 = performance.now();

      if (scannedBytes > MAX_BYTES) {
        return {
          ok: false,
          policyLevel: level,
          scannedBytes,
          parseTimeMs: Math.round((performance.now() - t0) * 1000) / 1000,
          violations: [
            {
              code: "POL-SIZE",
              message: `source ${scannedBytes} bytes exceeds ${MAX_BYTES} byte limit`,
              line: null,
              column: null,
            },
          ],
        };
      }

      let ast: Node;
      try {
        ast = Parser.parse(source, {
          ecmaVersion: 2022,
          sourceType: "script",
          locations: true,
        }) as unknown as Node;
      } catch (e) {
        const err = e as { message?: string; loc?: { line: number; column: number } };
        return {
          ok: false,
          policyLevel: level,
          scannedBytes,
          parseTimeMs: Math.round((performance.now() - t0) * 1000) / 1000,
          violations: [
            {
              code: "POL-PARSE",
              message: err.message ?? "syntax error",
              line: err.loc?.line ?? null,
              column: err.loc?.column ?? null,
            },
          ],
        };
      }

      const ctx: RuleContext = {
        level,
        violations: [],
        definePluginCalls: 0,
        moduleExportsAssignments: 0,
      };
      visit(ast, ctx);

      // POL-SHAPE: exactly one definePlugin() call AND ≥1 module.exports assignment.
      if (ctx.definePluginCalls !== 1 || ctx.moduleExportsAssignments < 1) {
        ctx.violations.push({
          code: "POL-SHAPE",
          message:
            "plugin must call definePlugin() exactly once and assign it to module.exports",
          line: null,
          column: null,
        });
      }

      const violations = dedupeStable(ctx.violations);
      return {
        ok: violations.length === 0,
        policyLevel: level,
        scannedBytes,
        parseTimeMs: Math.round((performance.now() - t0) * 1000) / 1000,
        violations,
      };
    },
  };
}

/** Collapse exact duplicate (code+line+column) violations, preserving order. */
function dedupeStable(violations: PolicyViolation[]): PolicyViolation[] {
  const seen = new Set<string>();
  const out: PolicyViolation[] = [];
  for (const v of violations) {
    const k = `${v.code}:${v.line}:${v.column}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Convenience: unique reason codes from a result (used by the registry). */
export function uniqueCodes(violations: PolicyViolation[]): PolicyReasonCode[] {
  const seen = new Set<PolicyReasonCode>();
  for (const v of violations) seen.add(v.code);
  return [...seen];
}
