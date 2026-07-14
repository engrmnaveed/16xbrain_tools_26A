// ---------------------------------------------------------------
// Importers: SQL DDL, JSON (schema inference), CSV headers, DBML-lite
// Every importer returns { tables, relations } fragments (ids resolved).
// ---------------------------------------------------------------

import { createTable, createField, createRelation, sanitizeName, sqlTypeToGeneric, findTable, findField } from '../model/schema.js';

// ---------- SQL DDL (PostgreSQL / MySQL / SQLite CREATE TABLE) ----------
export function importSQL(sql) {
  const tables = [];
  const relations = [];
  const pendingFks = [];

  const cleaned = String(sql)
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?(\w+)[`"\]]?\s*\(([\s\S]*?)\)\s*(?:ENGINE|WITHOUT|;|$)/gi;
  let m;
  while ((m = tableRe.exec(cleaned)) !== null) {
    const tableName = sanitizeName(m[1]);
    const body = m[2];
    const table = createTable({ name: tableName, fields: [] });
    const pkCols = new Set();
    const uniqueCols = new Set();

    for (const rawLine of splitColumns(body)) {
      const line = rawLine.trim();
      if (!line) continue;

      let c = line.match(/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (c) { c[1].split(',').forEach(s => pkCols.add(cleanIdent(s))); continue; }

      c = line.match(/^(?:CONSTRAINT\s+\S+\s+)?UNIQUE\s*(?:KEY\s+\S+\s*)?\(([^)]+)\)/i);
      if (c) { c[1].split(',').forEach(s => uniqueCols.add(cleanIdent(s))); continue; }

      c = line.match(/^(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+[`"[]?(\w+)[`"\]]?\s*\(([^)]+)\)(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/i);
      if (c) {
        pendingFks.push({
          fromTable: tableName, fromField: cleanIdent(c[1]),
          toTable: sanitizeName(c[2]), toField: cleanIdent(c[3]),
          onDelete: c[4] ? c[4].toLowerCase().replace(/\s+/, ' ') : 'cascade'
        });
        continue;
      }

      if (/^(KEY|INDEX|CHECK|FULLTEXT)\b/i.test(line)) continue;

      // column definition
      c = line.match(/^[`"[]?(\w+)[`"\]]?\s+(\w+(?:\s*\([^)]*\))?)([\s\S]*)$/);
      if (!c) continue;
      const [, colName, colType, restRaw] = c;
      const rest = restRaw || '';
      const field = createField({
        name: sanitizeName(colName),
        type: sqlTypeToGeneric(colType),
        pk: /PRIMARY\s+KEY/i.test(rest),
        unique: /\bUNIQUE\b/i.test(rest),
        nullable: !/NOT\s+NULL/i.test(rest) && !/PRIMARY\s+KEY/i.test(rest)
      });
      if (/serial/i.test(colType) || /AUTO_INCREMENT|AUTOINCREMENT/i.test(rest)) field.default = 'autoincrement';
      const dm = rest.match(/DEFAULT\s+(?:'([^']*)'|(\w+(?:\(\))?))/i);
      if (dm) {
        const v = dm[1] != null ? dm[1] : dm[2];
        field.default = /now\(\)|current_timestamp/i.test(v) ? 'now' : /uuid|gen_random_uuid/i.test(v) ? 'uuid' : v;
      }
      const em = colType.match(/enum\s*\(([^)]*)\)/i);
      if (em) { field.type = 'enum'; field.enumValues = em[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')); }
      const refm = rest.match(/REFERENCES\s+[`"[]?(\w+)[`"\]]?\s*\((\w+)\)(?:\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/i);
      if (refm) pendingFks.push({ fromTable: tableName, fromField: field.name, toTable: sanitizeName(refm[1]), toField: refm[2], onDelete: refm[3] ? refm[3].toLowerCase().replace(/\s+/, ' ') : 'cascade' });
      table.fields.push(field);
    }

    for (const f of table.fields) {
      if (pkCols.has(f.name)) { f.pk = true; f.nullable = false; }
      if (uniqueCols.has(f.name)) f.unique = true;
    }
    tables.push(table);
  }

  const fragment = { tables };
  for (const fk of pendingFks) {
    const ft = findTable(fragment, fk.fromTable);
    const tt = findTable(fragment, fk.toTable);
    if (!ft || !tt) continue;
    const ff = findField(ft, fk.fromField);
    const tf = findField(tt, fk.toField);
    if (!ff || !tf) continue;
    relations.push(createRelation({ fromTable: ft.id, fromField: ff.id, toTable: tt.id, toField: tf.id, kind: ff.unique ? 'one-one' : 'one-many', onDelete: fk.onDelete }));
  }
  if (!tables.length) throw new Error('No CREATE TABLE statements found in the SQL.');
  return { tables, relations };
}

function splitColumns(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
const cleanIdent = (s) => sanitizeName(s.replace(/[`"[\]]/g, '').trim());

// ---------- JSON → schema inference ----------
export function importJSON(text, rootName = 'root') {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON: ' + e.message); }
  const tables = [];
  const relations = [];

  function inferType(v) {
    if (v === null || v === undefined) return 'string';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
    if (typeof v === 'string') {
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+/.test(v)) return 'datetime';
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return 'uuid';
      return 'string';
    }
    return 'json';
  }

  function walkObject(obj, name, parentInfo = null) {
    const table = createTable({ name: sanitizeName(name), fields: [] });
    const sample = Array.isArray(obj) ? (obj.find(o => o && typeof o === 'object') || {}) : obj;
    const hasId = Object.keys(sample).some(k => k.toLowerCase() === 'id');
    if (!hasId) table.fields.push(createField({ name: 'id', type: 'uuid', pk: true, nullable: false, default: 'uuid' }));

    for (const [key, value] of Object.entries(sample)) {
      const fname = sanitizeName(key);
      if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null) {
        walkObject(value, singular(name) + '_' + fname, { table, fname });
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walkObject(value, singular(name) + '_' + fname, { table, fname, oneToOne: true });
        continue;
      }
      const f = createField({ name: fname, type: Array.isArray(value) ? 'json' : inferType(value) });
      if (fname === 'id') { f.pk = true; f.nullable = false; f.type = inferType(value) === 'int' ? 'int' : 'uuid'; }
      table.fields.push(f);
    }
    tables.push(table);

    if (parentInfo) {
      const fkName = singular(parentInfo.table.name) + '_id';
      const fk = createField({ name: sanitizeName(fkName), type: parentInfo.table.fields.find(f => f.pk)?.type || 'uuid', nullable: false, indexed: true, unique: !!parentInfo.oneToOne });
      table.fields.push(fk);
      const parentPk = parentInfo.table.fields.find(f => f.pk);
      if (parentPk) relations.push(createRelation({
        fromTable: table.id, fromField: fk.id,
        toTable: parentInfo.table.id, toField: parentPk.id,
        kind: parentInfo.oneToOne ? 'one-one' : 'one-many'
      }));
    }
    return table;
  }

  walkObject(data, rootName);
  return { tables, relations };
}

const singular = (s) => s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s;

// ---------- CSV headers → table ----------
export function importCSV(text, name = 'imported') {
  const lines = String(text).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('CSV appears to be empty.');
  const headers = parseCsvLine(lines[0]);
  const samples = lines.slice(1, 26).map(parseCsvLine);
  const table = createTable({ name: sanitizeName(name), fields: [] });

  headers.forEach((h, idx) => {
    const values = samples.map(r => r[idx]).filter(v => v != null && v !== '');
    const f = createField({ name: sanitizeName(h), type: inferCsvType(values) });
    if (f.name === 'id') { f.pk = true; f.nullable = false; }
    table.fields.push(f);
  });
  if (!table.fields.some(f => f.pk)) table.fields.unshift(createField({ name: 'id', type: 'int', pk: true, nullable: false, default: 'autoincrement' }));
  return { tables: [table], relations: [] };
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function inferCsvType(values) {
  if (!values.length) return 'string';
  if (values.every(v => /^-?\d+$/.test(v))) return 'int';
  if (values.every(v => /^-?\d*\.?\d+$/.test(v))) return 'float';
  if (values.every(v => /^(true|false|0|1|yes|no)$/i.test(v))) return 'boolean';
  if (values.every(v => /^\d{4}-\d{2}-\d{2}/.test(v))) return values.some(v => v.includes('T') || v.includes(':')) ? 'datetime' : 'date';
  if (values.every(v => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v))) return 'uuid';
  return 'string';
}
