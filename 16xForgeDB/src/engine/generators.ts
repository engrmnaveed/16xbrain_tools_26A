/**
 * Column generator compiler (Component C, generation side).
 *
 * Each ColumnSpec is compiled ONCE per table into a monomorphic closure
 * `(rowIndex) => SqlValue`. All option parsing, date math, weight prefix-sums
 * and pattern tokenization happen at compile time, so the per-row hot loop is
 * pure arithmetic + array indexing. This is the single biggest perf lever:
 * V8 inlines these closures and the seeder loop stays megamorphic-free.
 */

import type { ColumnSpec, SqlValue } from './types.js';
import { Rng, buildCumulative } from './prng.js';
import {
  CITIES, COMPANY_HEADS, COMPANY_TAILS, COUNTRIES, EMAIL_DOMAINS,
  FIRST_NAMES, LAST_NAMES, STREET_NAMES, STREET_SUFFIXES, TEMPLATE_SLOTS, WORDS,
} from './dictionaries.js';

export type ValueGen = (rowIndex: number) => SqlValue;

const DIGITS = '0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = UPPER + DIGITS;

const DAY_MS = 86_400_000;

function parseRange(spec: ColumnSpec): [number, number] {
  const from = Date.parse(spec.from ?? '2020-01-01T00:00:00Z');
  const to = Date.parse(spec.to ?? '2026-01-01T00:00:00Z');
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    throw new Error(`Column '${spec.name}': invalid date range ${spec.from}..${spec.to}`);
  }
  return [from, to];
}

/**
 * Compile one non-FK column into a hot-loop closure.
 * FK columns are compiled by the seeder (they need parent key pools).
 */
export function compileColumn(spec: ColumnSpec, rng: Rng): ValueGen {
  const base = compileBase(spec, rng);

  // NULL wrapper applied last so nullRatio composes with every kind.
  const nullRatio = spec.nullRatio ?? 0;
  if (nullRatio > 0) {
    return (i) => (rng.next() < nullRatio ? null : base(i));
  }
  return base;
}

function compileBase(spec: ColumnSpec, rng: Rng): ValueGen {
  switch (spec.kind) {
    case 'increment': {
      const start = spec.min ?? 1;
      return (i) => start + i;
    }
    case 'uuid':
      return () => rng.uuid();

    case 'firstName':
      return () => rng.pick(FIRST_NAMES);
    case 'lastName':
      return () => rng.pick(LAST_NAMES);
    case 'fullName':
      return () => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;

    case 'username': {
      // 'zephyr_kestrel42' style; unique flag appends the row index instead.
      if (spec.unique) return (i) => `${rng.pick(WORDS)}_${rng.pick(WORDS)}${i}`;
      return () => `${rng.pick(WORDS)}_${rng.pick(WORDS)}${rng.nextInt(100)}`;
    }

    case 'email': {
      // Composition: first.last[index]@domain. With unique=true the row index
      // guarantees zero collisions at ANY row count without a dedupe set.
      if (spec.unique) {
        return (i) =>
          `${rng.pick(FIRST_NAMES).toLowerCase()}.${rng.pick(LAST_NAMES).toLowerCase()}${i}@${rng.pick(EMAIL_DOMAINS)}`;
      }
      return () =>
        `${rng.pick(FIRST_NAMES).toLowerCase()}.${rng.pick(LAST_NAMES).toLowerCase()}@${rng.pick(EMAIL_DOMAINS)}`;
    }

    case 'phone': {
      // NANP-shaped, avoids 0/1 leading digits in area code.
      return () => {
        const area = 200 + rng.nextInt(800);
        const mid = 200 + rng.nextInt(800);
        const tail = rng.nextInt(10000);
        return `(${area}) ${mid}-${String(tail).padStart(4, '0')}`;
      };
    }

    case 'street':
      return () =>
        `${1 + rng.nextInt(9899)} ${rng.pick(STREET_NAMES)} ${rng.pick(STREET_SUFFIXES)}`;
    case 'city':
      return () => rng.pick(CITIES);
    case 'country':
      return () => rng.pick(COUNTRIES);
    case 'company':
      return () => `${rng.pick(COMPANY_HEADS)} ${rng.pick(COMPANY_TAILS)}`;

    case 'word':
      return () => rng.pick(WORDS);
    case 'sentence': {
      const min = spec.min ?? 5;
      const max = spec.max ?? 12;
      return () => {
        const n = rng.intBetween(min, max);
        let s = rng.pick(WORDS);
        s = s[0].toUpperCase() + s.slice(1);
        for (let w = 1; w < n; w++) s += ' ' + rng.pick(WORDS);
        return s + '.';
      };
    }

    case 'int': {
      const min = spec.min ?? 0;
      const max = spec.max ?? 1_000_000;
      return () => rng.intBetween(min, max);
    }
    case 'float': {
      const min = spec.min ?? 0;
      const max = spec.max ?? 1000;
      const factor = 10 ** (spec.precision ?? 2);
      const span = max - min;
      return () => Math.round((min + rng.next() * span) * factor) / factor;
    }
    case 'bool':
      // SQLite has no boolean type; emit 0/1 directly.
      return () => (rng.next() < 0.5 ? 1 : 0);

    case 'date': {
      const [from, to] = parseRange(spec);
      const days = Math.floor((to - from) / DAY_MS);
      return () => new Date(from + rng.nextInt(days) * DAY_MS).toISOString().slice(0, 10);
    }
    case 'datetime': {
      const [from, to] = parseRange(spec);
      const span = to - from;
      return () =>
        new Date(from + Math.floor(rng.next() * span)).toISOString().replace('T', ' ').slice(0, 19);
    }

    case 'enum': {
      const values = spec.values;
      if (!values || values.length === 0) {
        throw new Error(`Column '${spec.name}': enum requires values[]`);
      }
      if (spec.weights) {
        if (spec.weights.length !== values.length) {
          throw new Error(`Column '${spec.name}': weights[] length must match values[]`);
        }
        const cum = buildCumulative(spec.weights);
        return () => rng.pickWeighted(values, cum);
      }
      return () => rng.pick(values);
    }

    case 'pattern': {
      // Tokenize the mask once; per-row cost is one switch-free loop.
      const mask = spec.pattern;
      if (!mask) throw new Error(`Column '${spec.name}': pattern requires a mask`);
      const emitters: Array<(r: Rng) => string> = [...mask].map((ch) => {
        switch (ch) {
          case '#': return (r) => DIGITS[r.nextInt(10)];
          case 'A': return (r) => UPPER[r.nextInt(26)];
          case '@': return (r) => LOWER[r.nextInt(26)];
          case '?': return (r) => ALNUM[r.nextInt(36)];
          default: return () => ch;
        }
      });
      return () => {
        let out = '';
        for (let k = 0; k < emitters.length; k++) out += emitters[k](rng);
        return out;
      };
    }

    case 'template': {
      // Pre-split '{slot}' segments at compile time.
      const tpl = spec.template;
      if (!tpl) throw new Error(`Column '${spec.name}': template requires a template string`);
      const parts = tpl.split(/(\{[a-zA-Z]+\})/).filter((p) => p.length > 0);
      const emitters: Array<(r: Rng) => string> = parts.map((p) => {
        const m = /^\{([a-zA-Z]+)\}$/.exec(p);
        if (!m) return () => p;
        const dict = TEMPLATE_SLOTS[m[1]];
        if (!dict) {
          throw new Error(
            `Column '${spec.name}': unknown template slot {${m[1]}}. ` +
              `Available: ${Object.keys(TEMPLATE_SLOTS).join(', ')}`,
          );
        }
        return (r) => r.pick(dict);
      });
      return () => {
        let out = '';
        for (let k = 0; k < emitters.length; k++) out += emitters[k](rng);
        return out;
      };
    }

    case 'fk':
      throw new Error(
        `Column '${spec.name}': fk columns are compiled by the seeder, not compileColumn`,
      );

    default:
      throw new Error(`Column '${spec.name}': unknown kind '${(spec as ColumnSpec).kind}'`);
  }
}
