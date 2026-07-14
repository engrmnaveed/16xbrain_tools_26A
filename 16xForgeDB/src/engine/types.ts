/**
 * ForgeDB Engine — shared type definitions.
 *
 * The schema model below is the contract between the visual schema designer
 * (React canvas), the planner (DAG), the seeder, and the SQLite writer.
 * Everything is plain JSON-serializable data so schemas can be saved/loaded
 * as project files.
 */

/** Values that bind directly to SQLite parameters. */
export type SqlValue = string | number | null;

/** How parent primary keys are spread across child foreign-key fields. */
export type DistributionKind =
  /** Every child row picks a random parent. Some parents may get none. */
  | 'uniform'
  /** Power-law hotspot: a few parents receive most children (realistic e-commerce shape). */
  | 'zipf'
  /** Deterministic i % parentCount — guarantees every parent has ≥1 child when childRows >= parentRows. */
  | 'roundRobin'
  /** Bijective: each child gets a distinct parent (childRows must be <= parentRows). For 1:1 relations. */
  | 'oneToOne';

export interface FkRef {
  /** Parent table name. */
  table: string;
  /** Parent column name (must be the parent's primary key or a unique column pool). */
  column: string;
  /** Default: 'uniform'. */
  distribution?: DistributionKind;
  /** Zipf skew exponent. 1 = uniform, 2–4 = increasingly hot hotspots. Default 2. */
  skew?: number;
  /** Fraction (0..1) of child rows whose FK is NULL. */
  nullRatio?: number;
  /**
   * Marks this edge as safely breakable for circular-dependency resolution:
   * the seeder generates the column as NULL in pass 1 and emits an UPDATE
   * patch in pass 2. A nullRatio > 0 also implies breakability.
   */
  deferrable?: boolean;
}

export type ColumnKind =
  // Keys
  | 'increment' | 'uuid' | 'fk'
  // Identity dictionary types
  | 'firstName' | 'lastName' | 'fullName' | 'username' | 'email' | 'phone'
  // Location / org
  | 'street' | 'city' | 'country' | 'company'
  // Text
  | 'word' | 'sentence'
  // Scalars
  | 'int' | 'float' | 'bool' | 'date' | 'datetime'
  // User-defined
  | 'enum' | 'pattern' | 'template';

export interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  primaryKey?: boolean;
  /** For string kinds: embeds the row index so values never collide within the table. */
  unique?: boolean;
  /** Chance (0..1) of NULL for non-FK columns. */
  nullRatio?: number;

  // -- kind-specific options ------------------------------------------------
  /** int/float bounds (inclusive min, exclusive max for float; inclusive for int). */
  min?: number;
  max?: number;
  /** float decimal places. Default 2. */
  precision?: number;
  /** date/datetime range, ISO strings. Defaults: 2020-01-01 .. today. */
  from?: string;
  to?: string;
  /** enum values + optional weights (same length). */
  values?: SqlValue[];
  weights?: number[];
  /** pattern mask: '#'=digit, 'A'=upper, '@'=lower, '?'=alphanumeric, others literal. e.g. 'SKU-####-AA' */
  pattern?: string;
  /** template with dictionary slots, e.g. '{firstName} {lastName} <{word}@{domain}>' */
  template?: string;
  /** FK target (required when kind === 'fk'). */
  ref?: FkRef;
}

export interface TableSpec {
  name: string;
  /** Requested row count. */
  rows: number;
  columns: ColumnSpec[];
}

export interface SchemaSpec {
  /**
   * Deterministic seed. Same schema + same seed => byte-identical dataset,
   * which makes generated datasets reproducible across machines (a key
   * commercial feature: teams can share a seed instead of a 2 GB dump).
   */
  seed?: string;
  tables: TableSpec[];
}

// ---------------------------------------------------------------------------
// Streaming output units (seeder -> writer)
// ---------------------------------------------------------------------------

/** A batch of fully-generated rows for one table, in column order. */
export interface RowBatch {
  table: string;
  columns: string[];
  rows: SqlValue[][];
}

/** Pass-2 FK patch for a deferred (cycle-breaking) edge. */
export interface FkPatch {
  table: string;
  pkColumn: string;
  fkColumn: string;
  /** [childPk, parentFkValue] pairs. */
  pairs: Array<[SqlValue, SqlValue]>;
}

export interface TableStats {
  table: string;
  rows: number;
  ms: number;
}
