// ---------------------------------------------------------------------------
// 16xDataFlux — SQL DDL Parser
// Parses CREATE TABLE / CREATE INDEX statements into a schema model.
// Supports: inline + table-level PRIMARY KEY, inline REFERENCES,
// table-level FOREIGN KEY, UNIQUE, NOT NULL, CREATE [UNIQUE] INDEX.
// ---------------------------------------------------------------------------

const stripComments = (sql) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const unquote = (s) => (s || '').replace(/[`"'\[\]]/g, '').trim();

/** Split the body of CREATE TABLE (...) on top-level commas */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Extract balanced (...) starting at the given index of '(' */
function extractParens(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') {
      depth--;
      if (depth === 0) return { inner: str.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

const CONSTRAINT_STARTS = /^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE\s*\(|CHECK\s*\(|INDEX\s|KEY\s)/i;

function parseColumnDef(def) {
  const m = def.match(/^([`"\[]?[\w$]+[`"\]]?)\s+([\w]+(?:\s*\([\w\s,]*\))?(?:\s+UNSIGNED)?)/i);
  if (!m) return null;
  const col = {
    name: unquote(m[1]),
    type: m[2].replace(/\s+/g, ' ').toUpperCase(),
    pk: /PRIMARY\s+KEY/i.test(def),
    notNull: /NOT\s+NULL/i.test(def),
    unique: /\bUNIQUE\b/i.test(def) && !/PRIMARY/i.test(def),
    autoIncrement: /AUTO_INCREMENT|AUTOINCREMENT|SERIAL|IDENTITY/i.test(def),
    default: null,
    fk: null
  };
  const dm = def.match(/DEFAULT\s+((?:'[^']*')|(?:\w+(?:\(\))?))/i);
  if (dm) col.default = dm[1];
  const rm = def.match(/REFERENCES\s+([`"\[]?[\w$]+[`"\]]?)\s*(?:\(\s*([`"\[]?[\w$]+[`"\]]?)\s*\))?/i);
  if (rm) {
    col.fk = {
      table: unquote(rm[1]),
      column: rm[2] ? unquote(rm[2]) : 'id',
      onDelete: (def.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/i) || [])[1] || null
    };
  }
  return col;
}

function parseConstraint(def, table) {
  const pk = def.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
  if (pk) {
    const cols = pk[1].split(',').map(unquote);
    cols.forEach((c) => {
      const col = table.columns.find((x) => x.name === c);
      if (col) col.pk = true;
    });
    if (cols.length > 1) table.compositePk = cols;
    return;
  }
  const fk = def.match(
    /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"\[]?[\w$]+[`"\]]?)\s*(?:\(([^)]+)\))?/i
  );
  if (fk) {
    const local = fk[1].split(',').map(unquote);
    const refCols = fk[3] ? fk[3].split(',').map(unquote) : ['id'];
    local.forEach((lc, i) => {
      const col = table.columns.find((x) => x.name === lc);
      if (col) {
        col.fk = {
          table: unquote(fk[2]),
          column: refCols[i] || refCols[0],
          onDelete: (def.match(/ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION)/i) || [])[1] || null
        };
      }
    });
    return;
  }
  const uq = def.match(/UNIQUE\s*\(([^)]+)\)/i);
  if (uq) {
    uq[1].split(',').map(unquote).forEach((c) => {
      const col = table.columns.find((x) => x.name === c);
      if (col) col.unique = true;
    });
  }
}

/**
 * Parse SQL DDL → { tables, relationships, indexes, errors }
 */
export function parseSchema(sql) {
  const clean = stripComments(sql);
  const tables = [];
  const indexes = [];
  const errors = [];

  // CREATE TABLE
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w$.]+[`"\]]?)\s*\(/gi;
  let m;
  while ((m = tableRe.exec(clean))) {
    const openIdx = tableRe.lastIndex - 1;
    const extracted = extractParens(clean, openIdx);
    if (!extracted) {
      errors.push(`Unbalanced parentheses in table ${unquote(m[1])}`);
      continue;
    }
    const table = {
      name: unquote(m[1]).split('.').pop(),
      columns: [],
      compositePk: null
    };
    for (const def of splitTopLevel(extracted.inner)) {
      if (CONSTRAINT_STARTS.test(def)) {
        parseConstraint(def.replace(/^CONSTRAINT\s+[`"\[]?[\w$]+[`"\]]?\s+/i, ''), table);
      } else {
        const col = parseColumnDef(def);
        if (col) table.columns.push(col);
      }
    }
    if (table.columns.length) tables.push(table);
  }

  // CREATE INDEX
  const idxRe =
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w$]+[`"\]]?)\s+ON\s+([`"\[]?[\w$.]+[`"\]]?)\s*\(([^)]+)\)/gi;
  while ((m = idxRe.exec(clean))) {
    indexes.push({
      name: unquote(m[2]),
      table: unquote(m[3]).split('.').pop(),
      columns: m[4].split(',').map((c) => unquote(c.replace(/\s+(ASC|DESC)$/i, ''))),
      unique: !!m[1]
    });
  }

  // Relationships from FKs
  const tableNames = new Set(tables.map((t) => t.name));
  const relationships = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.fk) {
        if (!tableNames.has(c.fk.table)) {
          errors.push(`${t.name}.${c.name} references unknown table "${c.fk.table}"`);
          continue;
        }
        relationships.push({
          from: t.name,
          fromColumn: c.name,
          to: c.fk.table,
          toColumn: c.fk.column,
          onDelete: c.fk.onDelete,
          // many rows in `from` point to one row in `to`
          type: c.unique ? 'one-to-one' : 'many-to-one'
        });
      }
    }
  }

  // Junction table detection: exactly 2 FKs + (composite PK of those, or only FK/meta columns)
  for (const t of tables) {
    const fkCols = t.columns.filter((c) => c.fk);
    if (fkCols.length === 2) {
      // True junction: nothing but keys + timestamps (payload columns mean it's an entity)
      const nonKeyCols = t.columns.filter(
        (c) => !c.fk && !c.pk && !/^(created_at|updated_at|added_at|.*_at)$/i.test(c.name)
      );
      const hasOwnIdentity = t.columns.some((c) => c.pk && !c.fk && c.autoIncrement);
      if (nonKeyCols.length === 0 && !hasOwnIdentity) t.junction = true;
    }
  }

  if (!tables.length) errors.push('No CREATE TABLE statements found.');
  return { tables, relationships, indexes, errors };
}

/** Quick stats for badges */
export function schemaStats(schema) {
  return {
    tables: schema.tables.length,
    columns: schema.tables.reduce((n, t) => n + t.columns.length, 0),
    relationships: schema.relationships.length,
    indexes: schema.indexes.length,
    junctions: schema.tables.filter((t) => t.junction).length
  };
}
