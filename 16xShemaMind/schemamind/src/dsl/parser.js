// ---------------------------------------------------------------
// SchemaScript — SchemaMind's human-friendly DSL (DBML-inspired)
//
//   table users {
//     id uuid pk
//     email string unique !null
//     role enum(admin, member, guest) default(member)
//     created_at datetime default(now) index
//     // comment lines allowed
//   }
//
//   ref orders.user_id > users.id            // many-to-one (FK on orders)
//   ref profiles.user_id - users.id          // one-to-one
//   ref posts.id <> tags.id                  // many-to-many
//
// Two-way: parseScript(text) → project fragment, serializeProject(project) → text
// ---------------------------------------------------------------

import { createTable, createField, createRelation, sanitizeName, findTable, findField, FIELD_TYPES } from '../model/schema.js';

export class DslError extends Error {
  constructor(message, line) {
    super(line != null ? `Line ${line}: ${message}` : message);
    this.line = line;
  }
}

const FLAGS = new Set(['pk', 'unique', 'index', 'indexed', '!null', 'notnull', 'null']);

function parseFieldLine(line, lineNo) {
  // name type [modifiers...]  e.g.  email string unique !null default('x') note("...")
  const noteMatch = line.match(/note\((["'])(.*?)\1\)/);
  const note = noteMatch ? noteMatch[2] : '';
  let rest = line.replace(/note\((["']).*?\1\)/, '').trim();

  const defMatch = rest.match(/default\(\s*(['"]?)(.*?)\1\s*\)/);
  const def = defMatch ? defMatch[2] : null;
  rest = rest.replace(/default\(\s*(['"]?).*?\1\s*\)/, '').trim();

  const enumMatch = rest.match(/enum\s*\(([^)]*)\)/);
  const enumValues = enumMatch ? enumMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  if (enumMatch) rest = rest.replace(/enum\s*\([^)]*\)/, 'enum').trim();

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) throw new DslError(`Field needs a name and a type: "${line}"`, lineNo);
  const [name, rawType, ...mods] = tokens;
  const type = rawType.toLowerCase();
  if (!FIELD_TYPES.includes(type))
    throw new DslError(`Unknown type "${rawType}". Valid: ${FIELD_TYPES.join(', ')}`, lineNo);

  const field = createField({ name: sanitizeName(name), type, enumValues, note, default: def });
  for (const m of mods) {
    const mod = m.toLowerCase();
    if (!FLAGS.has(mod)) throw new DslError(`Unknown modifier "${m}"`, lineNo);
    if (mod === 'pk') { field.pk = true; field.nullable = false; }
    else if (mod === 'unique') field.unique = true;
    else if (mod === 'index' || mod === 'indexed') field.indexed = true;
    else if (mod === '!null' || mod === 'notnull') field.nullable = false;
    else if (mod === 'null') field.nullable = true;
  }
  return field;
}

export function parseScript(text) {
  const tables = [];
  const relations = [];
  const lines = String(text).split('\n');
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim();
    if (!line) continue;
    const lineNo = i + 1;

    if (current) {
      if (line === '}') { tables.push(current); current = null; continue; }
      if (line.startsWith('note')) {
        const m = line.match(/note\s*:?\s*(["'])(.*?)\1/);
        if (m) { current.note = m[2]; continue; }
      }
      current.fields.push(parseFieldLine(line, lineNo));
      continue;
    }

    let m = line.match(/^table\s+([A-Za-z_][\w]*)\s*\{?\s*$/i);
    if (m) {
      current = createTable({ name: sanitizeName(m[1]), fields: [] });
      if (!line.includes('{')) {
        // allow "table users" then "{" on next line
        while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
        if (lines[i + 1] && lines[i + 1].trim() === '{') i++;
      }
      continue;
    }

    m = line.match(/^ref\s+([\w]+)\.([\w]+)\s*(<>|>|<|-)\s*([\w]+)\.([\w]+)\s*(?:\[(.*?)\])?$/i);
    if (m) {
      const [, t1, f1, op, t2, f2, opts] = m;
      let kind = 'one-many', fromTable = t1, fromField = f1, toTable = t2, toField = f2;
      if (op === '-') kind = 'one-one';
      else if (op === '<>') kind = 'many-many';
      else if (op === '<') { fromTable = t2; fromField = f2; toTable = t1; toField = f1; }
      const rel = createRelation({ fromTable, fromField, toTable, toField, kind });
      if (opts && /delete\s*:\s*(cascade|restrict|set null)/i.test(opts))
        rel.onDelete = opts.match(/delete\s*:\s*(cascade|restrict|set null)/i)[1].toLowerCase();
      relations.push(rel);
      continue;
    }

    throw new DslError(`Cannot parse: "${line}"`, lineNo);
  }
  if (current) throw new DslError(`Table "${current.name}" is missing its closing }`);

  // Resolve relation names → ids; auto-create missing FK fields
  for (const r of relations) {
    const fragment = { tables };
    const ft = findTable(fragment, r.fromTable);
    const tt = findTable(fragment, r.toTable);
    if (!ft) throw new DslError(`Relation references unknown table "${r.fromTable}"`);
    if (!tt) throw new DslError(`Relation references unknown table "${r.toTable}"`);
    let ff = findField(ft, r.fromField);
    const tf = findField(tt, r.toField);
    if (!tf) throw new DslError(`Relation references unknown field "${r.toTable}.${r.toField}"`);
    if (!ff) {
      ff = createField({ name: sanitizeName(r.fromField), type: tf.type, nullable: false, indexed: true });
      ft.fields.push(ff);
    }
    r.fromTable = ft.id; r.fromField = ff.id;
    r.toTable = tt.id; r.toField = tf.id;
  }
  return { tables, relations };
}

// ---------- serialize ----------
function fieldToLine(f) {
  let s = `  ${f.name} ${f.type}`;
  if (f.type === 'enum' && f.enumValues.length) s = `  ${f.name} enum(${f.enumValues.join(', ')})`;
  if (f.pk) s += ' pk';
  if (f.unique) s += ' unique';
  if (!f.nullable && !f.pk) s += ' !null';
  if (f.indexed) s += ' index';
  if (f.default != null && f.default !== '') {
    const needsQuote = !/^(now|uuid|autoincrement|true|false|-?\d+(\.\d+)?)$/i.test(String(f.default));
    s += needsQuote ? ` default('${f.default}')` : ` default(${f.default})`;
  }
  if (f.note) s += ` note("${f.note.replace(/"/g, "'")}")`;
  return s;
}

export function serializeProject(project) {
  const out = [];
  for (const t of project.tables) {
    out.push(`table ${t.name} {`);
    if (t.note) out.push(`  note: "${t.note.replace(/"/g, "'")}"`);
    for (const f of t.fields) out.push(fieldToLine(f));
    out.push('}', '');
  }
  for (const r of project.relations) {
    const ft = project.tables.find(t => t.id === r.fromTable);
    const tt = project.tables.find(t => t.id === r.toTable);
    if (!ft || !tt) continue;
    const ff = ft.fields.find(f => f.id === r.fromField);
    const tf = tt.fields.find(f => f.id === r.toField);
    if (!ff || !tf) continue;
    const op = r.kind === 'one-one' ? '-' : r.kind === 'many-many' ? '<>' : '>';
    const opts = r.onDelete && r.onDelete !== 'cascade' ? ` [delete: ${r.onDelete}]` : '';
    out.push(`ref ${ft.name}.${ff.name} ${op} ${tt.name}.${tf.name}${opts}`);
  }
  return out.join('\n');
}
