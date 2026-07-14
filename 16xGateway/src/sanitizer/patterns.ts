/* ============================================================================
 * 16xGateway — src/sanitizer/patterns.ts
 * Compiled PII pattern set + sensitive-key list.
 *
 * LINEAR-TIME DISCIPLINE: every pattern below uses only bounded or simple
 * quantifiers with disjoint character classes at each position — no nested
 * quantifiers, no backreferences, no lookbehind. This guarantees the regex
 * engine cannot catastrophically backtrack on adversarial input.
 * ==========================================================================*/

import type { PiiPattern } from "../types/index.js";

/**
 * Luhn checksum over the digits of a candidate card number. Non-digit
 * separators (single spaces / hyphens) are stripped before the check.
 */
export function luhnValid(match: string): boolean {
  const digits = match.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48; // '0'
    if (n < 0 || n > 9) return false;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * DEFAULT_PATTERNS — ordered loosely by specificity; `priority` (lower wins
 * on overlap ties) is what actually decides ambiguous overlaps, not array
 * order. Each RegExp carries the global flag so callers can drive `lastIndex`.
 */
export const DEFAULT_PATTERNS: PiiPattern[] = [
  // --- credentials (highest specificity, lowest priority number) ----------
  {
    category: "api_key",
    // AWS access key ids, OpenAI-style sk- keys, GitHub PATs, Slack tokens.
    pattern:
      /AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|xox[bposar]-[A-Za-z0-9-]{10,}/g,
    priority: 10,
  },
  {
    category: "bearer_token",
    // "Bearer <token>" header form and bare JWTs (three base64url segments).
    pattern:
      /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    priority: 11,
  },

  // --- financial ----------------------------------------------------------
  {
    category: "credit_card",
    // 13–19 digits allowing single space/hyphen separators between groups.
    // Luhn validated to shed obvious false positives.
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    priority: 20,
    validate: luhnValid,
  },

  // --- government identifiers --------------------------------------------
  {
    category: "ssn",
    // Hyphenated US SSN only — contiguous 9 digits is too false-positive-prone.
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    priority: 30,
  },

  // --- contact ------------------------------------------------------------
  {
    category: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    priority: 40,
  },
  {
    category: "phone",
    // E.164 (+ then 7–15 digits) and common US formats.
    pattern:
      /\+\d{7,15}\b|\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b/g,
    priority: 50,
  },
];

/**
 * Keys whose ENTIRE string value is masked regardless of pattern matches.
 * Comparison is done after normalization: lowercased with '_' and '-'
 * stripped, on both the incoming key and these entries.
 */
export const SENSITIVE_KEYS: string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "ssn",
  "credit_card",
  "authorization",
  "private_key",
];

/** Normalization used for sensitive-key comparison (lowercase, strip _ and -). */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Pre-normalized sensitive-key set for O(1) lookup during the deep walk. */
export const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(
  SENSITIVE_KEYS.map(normalizeKey),
);
