/* ============================================================================
 * 16xGateway — src/sanitizer/tokenizer.ts
 * Deterministic HMAC-SHA256 tokenizer (D3).
 *
 * token = "[TOKEN_MASK_SHA256_" + hmac(secret, value).slice(0, hexLen) + "]"
 *
 * Deterministic per deployment → referential integrity: the same value always
 * maps to the same token, so downstream plugins can still group/join. HMAC
 * (not bare SHA-256) prevents dictionary reversal of the tokens.
 * ==========================================================================*/

import { createHmac } from "node:crypto";
import type { TokenString } from "../types/index.js";

const PREFIX = "[TOKEN_MASK_SHA256_";
const SUFFIX = "]";
const MIN_HEX = 6;
const MAX_HEX = 32;

export interface Tokenizer {
  /**
   * Returns the token for a value. `collisionSet` (optional) holds hex prefixes
   * already assigned to DIFFERENT raw values within the current request; on a
   * prefix collision the hex is extended by 4 chars until unique.
   */
  token(value: string, ctx?: TokenCollisionContext): TokenString;
}

/** Request-scoped collision bookkeeping: hexPrefix → raw value that owns it. */
export interface TokenCollisionContext {
  readonly assigned: Map<string, string>;
}

export function createCollisionContext(): TokenCollisionContext {
  return { assigned: new Map<string, string>() };
}

export function createTokenizer(secretKey: string, hexLength: number): Tokenizer {
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    throw new Error("tokenizer: secretKey must be a non-empty string");
  }
  const baseLen = Math.max(MIN_HEX, Math.min(MAX_HEX, Math.floor(hexLength)));

  function fullHmac(value: string): string {
    return createHmac("sha256", secretKey).update(value, "utf8").digest("hex");
  }

  return {
    token(value: string, ctx?: TokenCollisionContext): TokenString {
      const full = fullHmac(value); // 64 hex chars
      let len = baseLen;
      let hex = full.slice(0, len);

      if (ctx) {
        // Extend hex by 4 chars whenever a DIFFERENT value already owns this
        // prefix, until unique or we exhaust the digest.
        while (len < MAX_HEX) {
          const owner = ctx.assigned.get(hex);
          if (owner === undefined || owner === value) break;
          len = Math.min(MAX_HEX, len + 4);
          hex = full.slice(0, len);
        }
        ctx.assigned.set(hex, value);
      }

      return `${PREFIX}${hex}${SUFFIX}`;
    },
  };
}
