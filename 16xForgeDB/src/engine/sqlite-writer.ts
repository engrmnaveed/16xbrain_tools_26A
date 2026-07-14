/**
 * Component D — Local SQLite batch writer.
 *
 * Throughput strategy (in order of impact):
 *  1. ONE transaction per table (or per N batches) — SQLite fsyncs per
 *     transaction, so per-row transactions are ~1000x slower.
 *  2. Multi-row prepared INSERTs: `INSERT INTO t VALUES (?,?),(?,?),...`
 *     chunked to stay under SQLITE_MAX_VARIABLE_NUMBER.
 *  3. PRAGMA tuning for bulk load: WAL + synchronous=NORMAL (or OFF during
 *     seed — the file is disposable if the app crashes mid-generation).
 *  4. foreign_keys=OFF during load (integrity is guaranteed by construction
 *     upstream; deferred-edge columns are NULL until pass 2 anyway), then ON +
 *     `PRAGMA foreign_key_check` afterwards as a belt-and-braces audit.
 *
 * The writer talks to a minimal `SqlExecutor` interface so the same class
 * works against:
 *  - @tauri-apps/plugin-sql  (db.execute(sql, binds))
 *  - a custom Tauri invoke() bridge to rusqlite (see src-tauri-example/)
 *  - node:sqlite / better-sqlite3 in tests
 *
 * For maximum throughput in the shipped app, prefer the Rust bridge: batches
 * cross the IPC boundary as JSON once per 10k rows, and rusqlite reuses a
 * single prepared statement inside one transaction (see sqlite_writer.rs).
 */

import type { ColumnSpec, FkPatch, RowBatch, SchemaSpec, TableSpec, SqlValue } from './types.js';

export interface SqlExecutor {
  execute(sql: string, binds?: SqlValue[]): Promise<unknown>;
}

/** Conservative default; SQLite >= 3.32 allows 32766 bound variables. */
const MAX_BOUND_VARS = 32_000;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: '${name}'`);
  return `"${name}"`;
}

function sqliteType(col: ColumnSpec): string {
  switch (col.kind) {
    case 'increment':
    case 'int':
    case 'bool':
      return 'INTEGER';
    case 'float':
      return 'REAL';
    case 'fk':
      return 'INTEGER'; // overridden to TEXT below when parent PK is a uuid
    default:
      return 'TEXT';
  }
}

export function buildCreateTable(table: TableSpec, schema: SchemaSpec): string {
  const parentKinds = new Map<string, ColumnSpec>();
  for (const t of schema.tables) {
    for (const c of t.columns) parentKinds.set(`${t.name}.${c.name}`, c);
  }

  const defs: string[] = [];
  const fks: string[] = [];
  for (const col of table.columns) {
    let type = sqliteType(col);
    if (col.kind === 'fk' && col.ref) {
      const parent = parentKinds.get(`${col.ref.table}.${col.ref.column}`);
      if (parent && sqliteType(parent) === 'TEXT') type = 'TEXT';
      fks.push(
        `FOREIGN KEY (${quoteIdent(col.name)}) REFERENCES ` +
          `${quoteIdent(col.ref.table)}(${quoteIdent(col.ref.column)})`,
      );
    }
    const pk = col.primaryKey ? ' PRIMARY KEY' : '';
    defs.push(`${quoteIdent(col.name)} ${type}${pk}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${[...defs, ...fks].join(', ')})`;
}

export class SqliteBatchWriter {
  private stmtCache = new Map<string, string>();

  constructor(private readonly db: SqlExecutor) {}

  /** Bulk-load pragmas + DDL. Call once before streaming batches. */
  async init(schema: SchemaSpec): Promise<void> {
    await this.db.execute('PRAGMA journal_mode = WAL');
    await this.db.execute('PRAGMA synchronous = OFF'); // seed file is disposable mid-run
    await this.db.execute('PRAGMA temp_store = MEMORY');
    await this.db.execute('PRAGMA cache_size = -64000'); // 64 MB page cache
    await this.db.execute('PRAGMA foreign_keys = OFF'); // integrity handled upstream
    for (const table of schema.tables) {
      await this.db.execute(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
      await this.db.execute(buildCreateTable(table, schema));
    }
  }

  /**
   * Write one seeder batch. Chunks rows so `cols * rowsPerStmt` stays under
   * the bound-variable limit, all inside a single transaction.
   */
  async writeBatch(batch: RowBatch): Promise<void> {
    const nCols = batch.columns.length;
    const rowsPerStmt = Math.max(1, Math.floor(MAX_BOUND_VARS / nCols));
    const colList = batch.columns.map(quoteIdent).join(', ');
    const rowPlaceholder = `(${new Array(nCols).fill('?').join(',')})`;

    await this.db.execute('BEGIN');
    try {
      for (let offset = 0; offset < batch.rows.length; offset += rowsPerStmt) {
        const chunk = batch.rows.slice(offset, offset + rowsPerStmt);

        // Cache the SQL text per (table, chunkLength) — string building is
        // measurable at 100k+ rows, and full-size chunks all share one string.
        const cacheKey = `${batch.table}:${chunk.length}`;
        let sql = this.stmtCache.get(cacheKey);
        if (!sql) {
          sql =
            `INSERT INTO ${quoteIdent(batch.table)} (${colList}) VALUES ` +
            new Array(chunk.length).fill(rowPlaceholder).join(',');
          this.stmtCache.set(cacheKey, sql);
        }

        const binds = new Array<SqlValue>(chunk.length * nCols);
        let b = 0;
        for (let r = 0; r < chunk.length; r++) {
          const row = chunk[r];
          for (let c = 0; c < nCols; c++) binds[b++] = row[c];
        }
        await this.db.execute(sql, binds);
      }
      await this.db.execute('COMMIT');
    } catch (err) {
      await this.db.execute('ROLLBACK');
      throw err;
    }
  }

  /**
   * Pass-2 UPDATE for deferred (cycle-breaking) FK edges. Loads pairs into an
   * indexed temp table and applies one set-based UPDATE — orders of magnitude
   * faster than per-row UPDATE statements.
   */
  async applyPatch(patch: FkPatch): Promise<void> {
    await this.db.execute('BEGIN');
    try {
      await this.db.execute(
        'CREATE TEMP TABLE IF NOT EXISTS _forge_patch (k PRIMARY KEY, v) WITHOUT ROWID',
      );
      await this.db.execute('DELETE FROM _forge_patch');

      const rowsPerStmt = Math.floor(MAX_BOUND_VARS / 2);
      for (let offset = 0; offset < patch.pairs.length; offset += rowsPerStmt) {
        const chunk = patch.pairs.slice(offset, offset + rowsPerStmt);
        const sql =
          'INSERT INTO _forge_patch (k, v) VALUES ' +
          new Array(chunk.length).fill('(?,?)').join(',');
        const binds: SqlValue[] = [];
        for (const [k, v] of chunk) binds.push(k, v);
        await this.db.execute(sql, binds);
      }

      const t = quoteIdent(patch.table);
      const pk = quoteIdent(patch.pkColumn);
      const fk = quoteIdent(patch.fkColumn);
      await this.db.execute(
        `UPDATE ${t} SET ${fk} = (SELECT v FROM _forge_patch WHERE k = ${t}.${pk}) ` +
          `WHERE ${pk} IN (SELECT k FROM _forge_patch)`,
      );
      await this.db.execute('COMMIT');
    } catch (err) {
      await this.db.execute('ROLLBACK');
      throw err;
    }
  }

  /** Restore safe pragmas and audit integrity after the seed completes. */
  async finalize(): Promise<void> {
    await this.db.execute('PRAGMA synchronous = NORMAL');
    await this.db.execute('PRAGMA foreign_keys = ON');
    await this.db.execute('PRAGMA foreign_key_check'); // returns rows only on violations
    await this.db.execute('PRAGMA optimize');
  }
}
