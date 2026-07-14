// ---------------------------------------------------------------
// SchemaMind core data model
// A project is a portable JSON document: { meta, tables, relations, enums, notes }
// Types are generic and mapped per-target (SQL dialects, Mongo, Prisma, TS…)
// ---------------------------------------------------------------

let _id = 0;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}_${(_id++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Generic type system — the single source of truth.
export const FIELD_TYPES = [
  'uuid', 'int', 'bigint', 'float', 'decimal', 'string', 'text',
  'boolean', 'date', 'datetime', 'time', 'json', 'binary', 'enum'
];

export const TYPE_MAP = {
  postgres: {
    uuid: 'UUID', int: 'INTEGER', bigint: 'BIGINT', float: 'DOUBLE PRECISION',
    decimal: 'NUMERIC(12,2)', string: 'VARCHAR(255)', text: 'TEXT', boolean: 'BOOLEAN',
    date: 'DATE', datetime: 'TIMESTAMPTZ', time: 'TIME', json: 'JSONB', binary: 'BYTEA', enum: 'TEXT'
  },
  mysql: {
    uuid: 'CHAR(36)', int: 'INT', bigint: 'BIGINT', float: 'DOUBLE',
    decimal: 'DECIMAL(12,2)', string: 'VARCHAR(255)', text: 'TEXT', boolean: 'TINYINT(1)',
    date: 'DATE', datetime: 'DATETIME', time: 'TIME', json: 'JSON', binary: 'BLOB', enum: 'VARCHAR(64)'
  },
  sqlite: {
    uuid: 'TEXT', int: 'INTEGER', bigint: 'INTEGER', float: 'REAL',
    decimal: 'REAL', string: 'TEXT', text: 'TEXT', boolean: 'INTEGER',
    date: 'TEXT', datetime: 'TEXT', time: 'TEXT', json: 'TEXT', binary: 'BLOB', enum: 'TEXT'
  },
  mongoose: {
    uuid: 'String', int: 'Number', bigint: 'Number', float: 'Number',
    decimal: 'Number', string: 'String', text: 'String', boolean: 'Boolean',
    date: 'Date', datetime: 'Date', time: 'String', json: 'Schema.Types.Mixed', binary: 'Buffer', enum: 'String'
  },
  prisma: {
    uuid: 'String', int: 'Int', bigint: 'BigInt', float: 'Float',
    decimal: 'Decimal', string: 'String', text: 'String', boolean: 'Boolean',
    date: 'DateTime', datetime: 'DateTime', time: 'DateTime', json: 'Json', binary: 'Bytes', enum: 'String'
  },
  typescript: {
    uuid: 'string', int: 'number', bigint: 'bigint', float: 'number',
    decimal: 'number', string: 'string', text: 'string', boolean: 'boolean',
    date: 'Date', datetime: 'Date', time: 'string', json: 'Record<string, unknown>', binary: 'Uint8Array', enum: 'string'
  },
  jsonschema: {
    uuid: 'string', int: 'integer', bigint: 'integer', float: 'number',
    decimal: 'number', string: 'string', text: 'string', boolean: 'boolean',
    date: 'string', datetime: 'string', time: 'string', json: 'object', binary: 'string', enum: 'string'
  }
};

// Reverse mapping for SQL import — pattern → generic type
export function sqlTypeToGeneric(sqlType) {
  const t = String(sqlType || '').toLowerCase();
  if (/uuid/.test(t)) return 'uuid';
  if (/bigint|bigserial/.test(t)) return 'bigint';
  if (/int|serial/.test(t)) return 'int';
  if (/decimal|numeric|money/.test(t)) return 'decimal';
  if (/float|double|real/.test(t)) return 'float';
  if (/bool/.test(t)) return 'boolean';
  if (/timestamp|datetime/.test(t)) return 'datetime';
  if (/^date/.test(t)) return 'date';
  if (/^time/.test(t)) return 'time';
  if (/json/.test(t)) return 'json';
  if (/text|clob/.test(t)) return 'text';
  if (/blob|bytea|binary/.test(t)) return 'binary';
  if (/enum/.test(t)) return 'enum';
  return 'string';
}

export function createField(partial = {}) {
  return {
    id: uid('f'),
    name: 'field',
    type: 'string',
    pk: false,
    unique: false,
    nullable: true,
    indexed: false,
    default: null,        // literal, or 'now', 'uuid', 'autoincrement'
    enumValues: [],        // when type === 'enum'
    note: '',
    ...partial
  };
}

export function createTable(partial = {}) {
  return {
    id: uid('t'),
    name: 'new_table',
    x: 80, y: 80,
    color: null,           // optional accent color
    note: '',
    fields: [createField({ name: 'id', type: 'uuid', pk: true, nullable: false, default: 'uuid' })],
    ...partial
  };
}

// kind: 'one-one' | 'one-many' | 'many-many'
export function createRelation(partial = {}) {
  return {
    id: uid('r'),
    fromTable: null, fromField: null,   // FK side (many side for one-many)
    toTable: null, toField: null,       // referenced side
    kind: 'one-many',
    onDelete: 'cascade',                // cascade | restrict | set null
    note: '',
    ...partial
  };
}

export function createProject(name = 'Untitled Schema') {
  return {
    meta: {
      app: 'SchemaMind',
      formatVersion: 1,
      name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    tables: [],
    relations: [],
    notes: ''
  };
}

export const findTable = (project, idOrName) =>
  project.tables.find(t => t.id === idOrName) ||
  project.tables.find(t => t.name.toLowerCase() === String(idOrName).toLowerCase());

export const findField = (table, idOrName) =>
  table && (table.fields.find(f => f.id === idOrName) ||
  table.fields.find(f => f.name.toLowerCase() === String(idOrName).toLowerCase()));

export function sanitizeName(name) {
  return String(name).trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^(\d)/, '_$1').toLowerCase() || 'unnamed';
}

// Validate a project; returns array of { level: 'error'|'warning', message, tableId? }
export function validateProject(project) {
  const issues = [];
  const names = new Set();
  for (const t of project.tables) {
    const lower = t.name.toLowerCase();
    if (names.has(lower)) issues.push({ level: 'error', message: `Duplicate table name "${t.name}"`, tableId: t.id });
    names.add(lower);
    if (!t.fields.length) issues.push({ level: 'warning', message: `Table "${t.name}" has no fields`, tableId: t.id });
    if (!t.fields.some(f => f.pk)) issues.push({ level: 'warning', message: `Table "${t.name}" has no primary key`, tableId: t.id });
    const fnames = new Set();
    for (const f of t.fields) {
      const fl = f.name.toLowerCase();
      if (fnames.has(fl)) issues.push({ level: 'error', message: `Duplicate field "${f.name}" in "${t.name}"`, tableId: t.id });
      fnames.add(fl);
      if (f.type === 'enum' && !f.enumValues.length)
        issues.push({ level: 'warning', message: `Enum field "${t.name}.${f.name}" has no values`, tableId: t.id });
    }
  }
  for (const r of project.relations) {
    const ft = project.tables.find(t => t.id === r.fromTable);
    const tt = project.tables.find(t => t.id === r.toTable);
    if (!ft || !tt) { issues.push({ level: 'error', message: 'Relation points to a missing table' }); continue; }
    if (!findField(ft, r.fromField) || !findField(tt, r.toField))
      issues.push({ level: 'error', message: `Relation ${ft.name} → ${tt.name} points to a missing field` });
  }
  return issues;
}

// Topological order of tables by FK dependency (referenced tables first).
export function topoOrder(project) {
  const deps = new Map(project.tables.map(t => [t.id, new Set()]));
  for (const r of project.relations) {
    if (r.fromTable !== r.toTable && deps.has(r.fromTable)) deps.get(r.fromTable).add(r.toTable);
  }
  const ordered = [];
  const visited = new Set();
  const visit = (id, stack = new Set()) => {
    if (visited.has(id) || stack.has(id)) return;
    stack.add(id);
    for (const d of deps.get(id) || []) visit(d, stack);
    stack.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const t of project.tables) visit(t.id);
  return ordered.map(id => project.tables.find(t => t.id === id)).filter(Boolean);
}

// Auto-layout: simple grid flow, keeps existing positions when present.
export function autoLayout(project) {
  const COLS = Math.max(1, Math.ceil(Math.sqrt(project.tables.length)));
  const W = 300, H = 260;
  project.tables.forEach((t, i) => {
    t.x = 80 + (i % COLS) * W;
    t.y = 60 + Math.floor(i / COLS) * H;
  });
  return project;
}
