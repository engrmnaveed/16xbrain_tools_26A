// ---------------------------------------------------------------
// Random data generator — name/type-aware, relation-aware, seeded.
// generateData(project, { rowsPerTable, seed }) → { tableName: rows[] }
// FK integrity: referenced tables are generated first (topo order) and
// FK values are sampled from actual parent PKs.
// ---------------------------------------------------------------

import { topoOrder } from '../model/schema.js';

// Mulberry32 — deterministic seeded PRNG
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['James', 'Mary', 'Ali', 'Fatima', 'Wei', 'Aisha', 'Carlos', 'Yuki', 'Emma', 'Omar', 'Sofia', 'Liam', 'Zara', 'Noah', 'Amara', 'Lucas', 'Priya', 'Ethan', 'Layla', 'Hassan', 'Nina', 'Oliver', 'Sana', 'Ivan', 'Mei'];
const LAST = ['Smith', 'Khan', 'Garcia', 'Chen', 'Ahmed', 'Silva', 'Müller', 'Tanaka', 'Brown', 'Ali', 'Rossi', 'Kim', 'Patel', 'Novak', 'Diaz', 'Larsen', 'Osei', 'Haddad', 'Iqbal', 'Nakamura'];
const WORDS = ['alpha', 'nova', 'echo', 'prime', 'quantum', 'vertex', 'cobalt', 'zephyr', 'atlas', 'orbit', 'lumen', 'delta', 'onyx', 'pulse', 'vivid', 'crest', 'ember', 'flux', 'ridge', 'sable'];
const CITIES = ['Lahore', 'London', 'Tokyo', 'Berlin', 'Toronto', 'Dubai', 'Singapore', 'Sydney', 'Karachi', 'New York', 'Paris', 'Istanbul', 'Seoul', 'Nairobi', 'Lisbon'];
const COUNTRIES = ['Pakistan', 'UK', 'Japan', 'Germany', 'Canada', 'UAE', 'Singapore', 'Australia', 'USA', 'France', 'Turkey', 'Korea', 'Kenya', 'Portugal', 'Brazil'];
const STREETS = ['Main St', 'Oak Ave', 'Maple Rd', 'Cedar Ln', 'Park Blvd', 'Hill St', 'Lake Dr', 'River Rd', 'Sunset Ave', 'Garden Way'];
const COMPANIES = ['Acme Corp', 'Globex', 'Initech', 'Umbrella Ltd', 'Stark Industries', 'Wayne Enterprises', 'Hooli', 'Vandelay', 'Wonka Co', 'Cyberdyne'];
const DOMAINS = ['example.com', 'mail.test', 'demo.org', 'sample.net', 'inbox.dev'];
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const int = (rnd, min, max) => Math.floor(rnd() * (max - min + 1)) + min;

function uuidFrom(rnd) {
  const hex = () => Math.floor(rnd() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c =>
    c === 'x' ? hex() : ((Math.floor(rnd() * 16) & 0x3) | 0x8).toString(16));
}

function dateBetween(rnd, startYear = 2021, endYear = 2026) {
  const start = Date.UTC(startYear, 0, 1);
  const end = Date.UTC(endYear, 6, 1);
  return new Date(start + rnd() * (end - start));
}

// Heuristic value generation from field name + type
function valueFor(field, rnd, ctx) {
  const n = field.name.toLowerCase();

  if (field.type === 'enum' && field.enumValues.length) return pick(rnd, field.enumValues);
  if (field.type === 'boolean') return rnd() > 0.5;
  if (field.type === 'uuid') return uuidFrom(rnd);
  if (field.type === 'date') return dateBetween(rnd).toISOString().slice(0, 10);
  if (field.type === 'datetime') return dateBetween(rnd).toISOString();
  if (field.type === 'time') return `${String(int(rnd, 0, 23)).padStart(2, '0')}:${String(int(rnd, 0, 59)).padStart(2, '0')}:00`;
  if (field.type === 'json') return { tags: [pick(rnd, WORDS), pick(rnd, WORDS)] };
  if (field.type === 'binary') return null;

  if (field.type === 'int' || field.type === 'bigint') {
    if (/age/.test(n)) return int(rnd, 18, 80);
    if (/year/.test(n)) return int(rnd, 1990, 2026);
    if (/qty|quantity|count|stock/.test(n)) return int(rnd, 0, 500);
    if (/rating|stars/.test(n)) return int(rnd, 1, 5);
    return int(rnd, 1, 10000);
  }
  if (field.type === 'float' || field.type === 'decimal') {
    if (/price|amount|total|cost|fee|salary|balance/.test(n)) return Math.round(rnd() * 99900 + 100) / 100;
    if (/lat/.test(n)) return Math.round((rnd() * 180 - 90) * 1e6) / 1e6;
    if (/lon|lng/.test(n)) return Math.round((rnd() * 360 - 180) * 1e6) / 1e6;
    if (/rate|ratio|percent/.test(n)) return Math.round(rnd() * 10000) / 100;
    return Math.round(rnd() * 100000) / 100;
  }

  // strings — name-driven
  const first = pick(rnd, FIRST), last = pick(rnd, LAST);
  if (/^(full_?name|name)$/.test(n) && ctx.isPersonish) return `${first} ${last}`;
  if (/first_?name/.test(n)) return first;
  if (/last_?name|surname/.test(n)) return last;
  if (/user_?name|login|handle/.test(n)) return `${first.toLowerCase()}${int(rnd, 1, 999)}`;
  if (/e?mail/.test(n)) return `${first.toLowerCase()}.${last.toLowerCase()}${int(rnd, 1, 99)}@${pick(rnd, DOMAINS)}`;
  if (/phone|mobile|tel/.test(n)) return `+${int(rnd, 1, 92)} ${int(rnd, 300, 399)} ${int(rnd, 1000000, 9999999)}`;
  if (/city/.test(n)) return pick(rnd, CITIES);
  if (/country/.test(n)) return pick(rnd, COUNTRIES);
  if (/address|street/.test(n)) return `${int(rnd, 1, 999)} ${pick(rnd, STREETS)}`;
  if (/zip|postal/.test(n)) return String(int(rnd, 10000, 99999));
  if (/company|organization|org_name/.test(n)) return pick(rnd, COMPANIES);
  if (/url|website|link/.test(n)) return `https://www.${pick(rnd, WORDS)}${pick(rnd, WORDS)}.com`;
  if (/image|avatar|photo|thumbnail/.test(n)) return `https://picsum.photos/seed/${pick(rnd, WORDS)}${int(rnd, 1, 999)}/400/300`;
  if (/password|hash|token|secret/.test(n)) return Array.from({ length: 24 }, () => pick(rnd, '0123456789abcdef'.split(''))).join('');
  if (/color|colour/.test(n)) return `#${Array.from({ length: 6 }, () => pick(rnd, '0123456789abcdef'.split(''))).join('')}`;
  if (/slug/.test(n)) return `${pick(rnd, WORDS)}-${pick(rnd, WORDS)}-${int(rnd, 1, 99)}`;
  if (/sku|code|ref/.test(n)) return `${pick(rnd, WORDS).toUpperCase().slice(0, 3)}-${int(rnd, 1000, 9999)}`;
  if (/currency/.test(n)) return pick(rnd, ['USD', 'EUR', 'GBP', 'PKR', 'JPY', 'AED']);
  if (/title|subject|headline|name/.test(n)) return cap(`${pick(rnd, WORDS)} ${pick(rnd, WORDS)} ${pick(rnd, WORDS)}`);
  if (/description|summary|bio|body|content|text|note|comment|message/.test(n) || field.type === 'text')
    return cap(Array.from({ length: int(rnd, 8, 22) }, () => pick(rnd, LOREM)).join(' ')) + '.';
  return cap(`${pick(rnd, WORDS)} ${pick(rnd, WORDS)}`);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function generateData(project, { rowsPerTable = {}, defaultRows = 25, seed = 42 } = {}) {
  const rnd = mulberry32(seed);
  const result = {};
  const pksByTable = {}; // tableId → array of pk values

  const ordered = topoOrder(project);
  for (const table of ordered) {
    const count = Math.max(0, Math.min(10000, rowsPerTable[table.id] ?? defaultRows));
    const rows = [];
    const isPersonish = /user|person|customer|employee|member|author|student|contact|profile/.test(table.name.toLowerCase());
    const fkMap = {}; // fieldId → { parentTableId, parentValues }
    for (const r of project.relations) {
      if (r.fromTable !== table.id) continue;
      const parentVals = pksByTable[r.toTable];
      if (parentVals && parentVals.length) fkMap[r.fromField] = { values: parentVals, kind: r.kind };
    }
    const usedUnique = {}; // fieldId → Set

    for (let i = 0; i < count; i++) {
      const row = {};
      for (const f of table.fields) {
        // FK — sample real parent keys; one-one relations consume each parent once
        if (fkMap[f.id]) {
          const { values, kind } = fkMap[f.id];
          if (kind === 'one-one') {
            row[f.name] = i < values.length ? values[i] : null;
          } else {
            row[f.name] = pick(rnd, values);
          }
          continue;
        }
        if (f.pk) {
          if (f.type === 'int' || f.type === 'bigint' || f.default === 'autoincrement') row[f.name] = i + 1;
          else row[f.name] = uuidFrom(rnd);
          continue;
        }
        if (f.nullable && rnd() < 0.06) { row[f.name] = null; continue; }
        let v = valueFor(f, rnd, { isPersonish });
        if (f.unique) {
          const set = (usedUnique[f.id] ||= new Set());
          let guard = 0;
          while (set.has(typeof v === 'object' ? JSON.stringify(v) : v) && guard++ < 50) {
            v = typeof v === 'string' ? `${v}_${int(rnd, 1, 99999)}` : valueFor(f, rnd, { isPersonish });
          }
          set.add(typeof v === 'object' ? JSON.stringify(v) : v);
        }
        row[f.name] = v;
      }
      rows.push(row);
    }
    result[table.name] = rows;
    const pkField = table.fields.find(f => f.pk);
    pksByTable[table.id] = pkField ? rows.map(r => r[pkField.name]) : [];
  }
  return result;
}

// ---------- serializers for generated data ----------
export function dataToJSON(dataByTable) {
  return JSON.stringify(dataByTable, null, 2);
}

export function dataToCSV(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');
}

export function dataToSQLInserts(project, dataByTable, dialect = 'postgres') {
  const q = dialect === 'mysql' ? '`' : '"';
  const out = [`-- Seed data generated by SchemaMind`, ''];
  for (const table of topoOrder(project)) {
    const rows = dataByTable[table.name];
    if (!rows || !rows.length) continue;
    const keys = Object.keys(rows[0]);
    out.push(`INSERT INTO ${q}${table.name}${q} (${keys.map(k => q + k + q).join(', ')}) VALUES`);
    const vals = rows.map(r => '  (' + keys.map(k => sqlLit(r[k])).join(', ') + ')');
    out.push(vals.join(',\n') + ';', '');
  }
  return out.join('\n');
}

function sqlLit(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

export function dataToMongoInserts(dataByTable) {
  const out = [`// Mongo seed script generated by SchemaMind — run in mongosh`, ''];
  for (const [name, rows] of Object.entries(dataByTable)) {
    if (!rows.length) continue;
    out.push(`db.${name}.insertMany(${JSON.stringify(rows, null, 2)});`, '');
  }
  return out.join('\n');
}
