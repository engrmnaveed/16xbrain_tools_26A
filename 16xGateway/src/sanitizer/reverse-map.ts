/* ============================================================================
 * 16xGateway — src/sanitizer/reverse-map.ts
 * Request-scoped token → original-value store with deep restore.
 *
 * The raw originals live ONLY in the #private map here. destroy() clears them
 * and flips a flag so any later restore() throws — this is the mechanism that
 * bounds the in-flight window for real PII to a single request.
 * ==========================================================================*/

import type { JsonValue, ReverseMap, TokenString } from "../types/index.js";

const TOKEN_RE = /\[TOKEN_MASK_SHA256_[0-9a-f]{6,32}\]/g;

export class RequestReverseMap implements ReverseMap {
  #store: Map<string, string> | null = new Map<string, string>();

  /** Registers a token → original mapping (idempotent for equal pairs). */
  add(token: TokenString, original: string): void {
    if (this.#store === null) throw new Error("ReverseMap destroyed");
    this.#store.set(token, original);
  }

  get size(): number {
    return this.#store === null ? 0 : this.#store.size;
  }

  get destroyed(): boolean {
    return this.#store === null;
  }

  restore<T extends JsonValue>(value: T): T {
    const store = this.#store;
    if (store === null) throw new Error("ReverseMap destroyed");
    return deepRestore(value, store) as T;
  }

  destroy(): void {
    if (this.#store !== null) {
      this.#store.clear();
      this.#store = null;
    }
  }
}

/** Replaces every known token occurrence inside a string. */
function restoreString(s: string, store: Map<string, string>): string {
  if (store.size === 0 || s.indexOf("[TOKEN_MASK_SHA256_") === -1) return s;
  TOKEN_RE.lastIndex = 0;
  return s.replace(TOKEN_RE, (tok) => {
    const original = store.get(tok);
    return original === undefined ? tok : original;
  });
}

/** Deep, non-mutating restore across objects, arrays and strings. */
function deepRestore(value: JsonValue, store: Map<string, string>): JsonValue {
  if (typeof value === "string") return restoreString(value, store);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => deepRestore(v, store));
  }
  const out: { [key: string]: JsonValue } = {};
  for (const k of Object.keys(value)) {
    out[k] = deepRestore(value[k] as JsonValue, store);
  }
  return out;
}

export function createReverseMap(): RequestReverseMap {
  return new RequestReverseMap();
}
