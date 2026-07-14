/* ============================================================================
 * 16xGateway — src/sanitizer/index.ts
 * createSanitizer(): deep-walk payloads, tokenize PII, build the reverse map.
 *
 * Only STRING values are scanned/replaced. Keys are never rewritten;
 * numbers/booleans/null are untouched. The input payload is never mutated.
 * ==========================================================================*/

import type {
  JsonObject,
  JsonValue,
  PiiCategory,
  PiiPattern,
  RequestId,
  SanitizationMatch,
  SanitizationPass,
  Sanitizer,
  TokenString,
} from "../types/index.js";
import {
  DEFAULT_PATTERNS,
  SENSITIVE_KEY_SET,
  normalizeKey,
} from "./patterns.js";
import {
  createCollisionContext,
  createTokenizer,
  type TokenCollisionContext,
  type Tokenizer,
} from "./tokenizer.js";
import { createReverseMap, type RequestReverseMap } from "./reverse-map.js";

interface RawMatch {
  category: PiiCategory;
  priority: number;
  start: number;
  end: number;
  value: string;
}

/** Collect all pattern hits in a string, running validators where present. */
function collectMatches(text: string, patterns: PiiPattern[]): RawMatch[] {
  const raw: RawMatch[] = [];
  for (const p of patterns) {
    const re = p.pattern;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[0];
      if (value.length === 0) {
        // Guard against zero-width matches causing an infinite loop.
        re.lastIndex++;
        continue;
      }
      if (p.validate && !p.validate(value)) continue;
      raw.push({
        category: p.category,
        priority: p.priority,
        start: m.index,
        end: m.index + value.length,
        value,
      });
    }
  }
  return raw;
}

/**
 * Resolve overlaps: sort by (earliest start, then longest, then lowest
 * priority), then greedily keep non-overlapping matches.
 */
function resolveOverlaps(raw: RawMatch[]): RawMatch[] {
  raw.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenA = a.end - a.start;
    const lenB = b.end - b.start;
    if (lenA !== lenB) return lenB - lenA; // longest first
    return a.priority - b.priority; // lowest priority number first
  });
  const kept: RawMatch[] = [];
  let cursor = 0;
  for (const m of raw) {
    if (m.start >= cursor) {
      kept.push(m);
      cursor = m.end;
    }
  }
  return kept;
}

export function createSanitizer(
  secretKey: string,
  hexLength: number,
  patterns: PiiPattern[] = DEFAULT_PATTERNS,
): Sanitizer {
  const tokenizer: Tokenizer = createTokenizer(secretKey, hexLength);

  function tokenizeString(
    text: string,
    jsonPath: string,
    reverse: RequestReverseMap,
    matches: SanitizationMatch[],
    collision: TokenCollisionContext,
  ): string {
    const kept = resolveOverlaps(collectMatches(text, patterns));
    if (kept.length === 0) return text;

    // Replace right-to-left so earlier indices stay valid.
    kept.sort((a, b) => b.start - a.start);
    let out = text;
    for (const m of kept) {
      const token: TokenString = tokenizer.token(m.value, collision);
      reverse.add(token, m.value);
      matches.push({ category: m.category, token, jsonPath });
      out = out.slice(0, m.start) + token + out.slice(m.end);
    }
    return out;
  }

  function maskWholeValue(
    text: string,
    jsonPath: string,
    reverse: RequestReverseMap,
    matches: SanitizationMatch[],
    collision: TokenCollisionContext,
  ): string {
    const token: TokenString = tokenizer.token(text, collision);
    reverse.add(token, text);
    matches.push({ category: "sensitive_key", token, jsonPath });
    return token;
  }

  function walk(
    value: JsonValue,
    jsonPath: string,
    keyIsSensitive: boolean,
    reverse: RequestReverseMap,
    matches: SanitizationMatch[],
    collision: TokenCollisionContext,
  ): JsonValue {
    if (typeof value === "string") {
      if (keyIsSensitive) {
        return maskWholeValue(value, jsonPath, reverse, matches, collision);
      }
      return tokenizeString(value, jsonPath, reverse, matches, collision);
    }
    if (value === null || typeof value !== "object") {
      // number | boolean | null — untouched (only strings are scanned).
      return value;
    }
    if (Array.isArray(value)) {
      const arr: JsonValue[] = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        // A sensitive key does not "flow" into array elements; each element is
        // evaluated on its own, but the sensitive-key intent applies to the
        // whole value — mask string elements too.
        arr[i] = walk(
          value[i] as JsonValue,
          `${jsonPath}[${i}]`,
          keyIsSensitive,
          reverse,
          matches,
          collision,
        );
      }
      return arr;
    }
    const obj: { [key: string]: JsonValue } = {};
    for (const k of Object.keys(value)) {
      const childSensitive = SENSITIVE_KEY_SET.has(normalizeKey(k));
      obj[k] = walk(
        value[k] as JsonValue,
        `${jsonPath}.${k}`,
        childSensitive,
        reverse,
        matches,
        collision,
      );
    }
    return obj;
  }

  return {
    sanitize(payload: JsonObject, requestId: RequestId): SanitizationPass {
      const reverse = createReverseMap();
      const matches: SanitizationMatch[] = [];
      const collision = createCollisionContext();
      const sanitizedPayload = walk(
        payload,
        "$",
        false,
        reverse,
        matches,
        collision,
      ) as JsonObject;
      return { requestId, sanitizedPayload, matches, reverseMap: reverse };
    },

    scan(text: string): Array<{ category: PiiCategory; start: number; end: number }> {
      const kept = resolveOverlaps(collectMatches(text, patterns));
      kept.sort((a, b) => a.start - b.start);
      return kept.map((m) => ({ category: m.category, start: m.start, end: m.end }));
    },
  };
}

export { DEFAULT_PATTERNS, SENSITIVE_KEYS } from "./patterns.js";
export { createTokenizer } from "./tokenizer.js";
export { createReverseMap } from "./reverse-map.js";
