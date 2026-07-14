import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import {
  DEFAULT_SETTINGS,
  DependencyInfo,
  EntityDetail,
  EntityKind,
  EntityRow,
  LLMSettings,
} from "./types";

const DB_DIR = process.env.CODEGRAPH_DB_DIR || path.join(os.homedir(), ".codegraph");
fs.mkdirSync(DB_DIR, { recursive: true });

export const db: Database.Database = new Database(path.join(DB_DIR, "codegraph.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,      -- absolute file path
  root_path    TEXT NOT NULL,             -- project root this file belongs to
  hash         TEXT NOT NULL,             -- sha1 of content; unchanged files are skipped
  last_scanned INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id         INTEGER PRIMARY KEY,
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN
               ('function','component','class','interface','type','enum','variable')),
  signature  TEXT,                        -- header only: name, params, return type
  code       TEXT NOT NULL,               -- full source text of the entity
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  exported   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dependencies (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id   INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  target_name TEXT NOT NULL,
  UNIQUE (source_id, target_name)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_name  ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_file  ON entities(file_id);
CREATE INDEX IF NOT EXISTS idx_deps_source    ON dependencies(source_id);
CREATE INDEX IF NOT EXISTS idx_deps_target    ON dependencies(target_id);
CREATE INDEX IF NOT EXISTS idx_files_root     ON files(root_path);
`);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
const qFileByPath = db.prepare("SELECT id, hash FROM files WHERE path = ?");
const qInsertFile = db.prepare(
  "INSERT INTO files (path, root_path, hash, last_scanned) VALUES (?, ?, ?, ?)"
);
const qUpdateFile = db.prepare("UPDATE files SET hash = ?, last_scanned = ? WHERE id = ?");
const qDeleteEntitiesForFile = db.prepare("DELETE FROM entities WHERE file_id = ?");

export function getFile(filePath: string): { id: number; hash: string } | undefined {
  return qFileByPath.get(filePath) as { id: number; hash: string } | undefined;
}

/** Upsert a file row and clear its old entities. Returns file id. */
export function replaceFile(filePath: string, rootPath: string, hash: string): number {
  const existing = getFile(filePath);
  if (existing) {
    qUpdateFile.run(hash, Date.now(), existing.id);
    qDeleteEntitiesForFile.run(existing.id);
    return existing.id;
  }
  return Number(qInsertFile.run(filePath, rootPath, hash, Date.now()).lastInsertRowid);
}

/** Remove files (and cascaded entities) that no longer exist on disk. */
export function pruneMissingFiles(rootPath: string, livePaths: Set<string>): number {
  const rows = db
    .prepare("SELECT id, path FROM files WHERE root_path = ?")
    .all(rootPath) as { id: number; path: string }[];
  const del = db.prepare("DELETE FROM files WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    if (!livePaths.has(r.path)) {
      del.run(r.id);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
const qInsertEntity = db.prepare(`
  INSERT INTO entities (file_id, name, kind, signature, code, start_line, end_line, exported)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

export function insertEntity(e: {
  fileId: number;
  name: string;
  kind: EntityKind;
  signature: string | null;
  code: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}): number {
  return Number(
    qInsertEntity.run(
      e.fileId, e.name, e.kind, e.signature, e.code, e.startLine, e.endLine, e.exported ? 1 : 0
    ).lastInsertRowid
  );
}

/** Map of "filePath::name" -> entity id, used by the scanner to resolve deps. */
export function loadEntityMap(): Map<string, number> {
  const rows = db
    .prepare("SELECT e.id, e.name, f.path FROM entities e JOIN files f ON f.id = e.file_id")
    .all() as { id: number; name: string; path: string }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(`${r.path}::${r.name}`, r.id);
  return map;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------
const qInsertDep = db.prepare(
  "INSERT OR IGNORE INTO dependencies (source_id, target_id, target_name) VALUES (?, ?, ?)"
);
const qClearDepsForSource = db.prepare("DELETE FROM dependencies WHERE source_id = ?");

export function setDependencies(
  sourceId: number,
  deps: { targetId: number | null; targetName: string }[]
): void {
  qClearDepsForSource.run(sourceId);
  for (const d of deps) qInsertDep.run(sourceId, d.targetId, d.targetName);
}

export const runInTransaction = db.transaction((fn: () => void) => fn());

// ---------------------------------------------------------------------------
// Queries for the UI
// ---------------------------------------------------------------------------
export function searchEntities(q: string, limit = 50): EntityRow[] {
  return db
    .prepare(
      `SELECT e.id, e.file_id, f.path AS file_path, e.name, e.kind, e.signature,
              e.code, e.start_line, e.end_line, e.exported
       FROM entities e JOIN files f ON f.id = e.file_id
       WHERE e.name LIKE ? ESCAPE '\\'
       ORDER BY (e.name = ?) DESC, e.exported DESC, length(e.name) ASC
       LIMIT ?`
    )
    .all(`%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`, q, limit) as EntityRow[];
}

export function getEntity(id: number): EntityRow | undefined {
  return db
    .prepare(
      `SELECT e.id, e.file_id, f.path AS file_path, e.name, e.kind, e.signature,
              e.code, e.start_line, e.end_line, e.exported
       FROM entities e JOIN files f ON f.id = e.file_id WHERE e.id = ?`
    )
    .get(id) as EntityRow | undefined;
}

export function getEntityDetail(id: number): EntityDetail | undefined {
  const entity = getEntity(id);
  if (!entity) return undefined;

  const dependencies = db
    .prepare(
      `SELECT t.id, d.target_name AS name, t.kind, f.path AS file_path, t.signature
       FROM dependencies d
       LEFT JOIN entities t ON t.id = d.target_id
       LEFT JOIN files f ON f.id = t.file_id
       WHERE d.source_id = ?
       ORDER BY t.id IS NULL, name`
    )
    .all(id) as DependencyInfo[];

  const dependents = db
    .prepare(
      `SELECT s.id, s.name, s.kind, f.path AS file_path, s.signature
       FROM dependencies d
       JOIN entities s ON s.id = d.source_id
       JOIN files f ON f.id = s.file_id
       WHERE d.target_id = ?
       ORDER BY s.name`
    )
    .all(id) as DependencyInfo[];

  return { entity, dependencies, dependents };
}

export function getStats(): { files: number; entities: number; dependencies: number } {
  const files = (db.prepare("SELECT COUNT(*) c FROM files").get() as { c: number }).c;
  const entities = (db.prepare("SELECT COUNT(*) c FROM entities").get() as { c: number }).c;
  const dependencies = (db.prepare("SELECT COUNT(*) c FROM dependencies").get() as { c: number }).c;
  return { files, entities, dependencies };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export function getSettings(): LLMSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'llm'").get() as
    | { value: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: LLMSettings): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('llm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify(s));
}
