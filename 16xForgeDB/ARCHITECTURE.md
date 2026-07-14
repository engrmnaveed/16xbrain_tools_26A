# ForgeDB — Internal Generation Engine

Offline relational mock server & schema seeder. Zero runtime LLM/cloud/network dependency: every byte of generated data comes from a deterministic procedural engine bundled in the client (Tauri + React + TypeScript, SQLite via rusqlite `bundled`).

## Pipeline

```
SchemaSpec (JSON from visual designer)
   │
   ▼
Component A  planner.ts        FK edges → Kahn topological sort → GenerationPlan
   │                           { order, levels, activeEdges, selfEdges, deferredEdges }
   ▼
Component B  seeder.ts         per-table compiled closures + KeyPools + FK samplers
   │                           emits RowBatch (10k rows) + FkPatch streams
   ▼
Component D  sqlite-writer.ts  WAL + single-txn batches + multi-row prepared INSERTs
             src-tauri/src/seed.rs  (Rust bridge for max throughput)
```

Component C (prng.ts, dictionaries.ts, generators.ts) underpins B: every value is drawn from seeded PRNG streams over bundled dictionaries.

## Component A — Topological Schema Planner

`planGeneration(schema)` validates all FK refs, then runs Kahn's algorithm with name-sorted tie-breaking (deterministic plans). Output includes `levels` — tables in one level share no dependency, ready for future worker parallelism.

Cycle strategy, in order:

1. **Self-references** (`employees.manager_id → employees.id`) are lifted out before sorting; the seeder resolves them in-table by sampling only from rows already generated (row *i* may reference rows `0..i-1`), so hierarchies are acyclic by construction.
2. **Multi-table cycles** are broken at a *breakable* edge (FK marked `deferrable: true` or `nullRatio > 0`): pass 1 writes NULL, pass 2 emits `[childPk, parentKey]` UPDATE patches. The loop defers one edge per detected cycle until acyclic — terminates in ≤ |edges| iterations.
3. **Unresolvable cycles** (no breakable edge) throw `CircularDependencyError` carrying the exact cycle path, so the schema canvas can highlight the offending relation loop.

## Component B — Relational Seeder

Integrity by construction, not by checking: FK values are only ever *drawn from the parent's key pool*, which is complete before any child runs (topological guarantee). Broken FKs are unrepresentable.

- **KeyPools**: auto-increment PKs use an arithmetic pool (base + count — 10M keys ≈ 16 bytes); only string keys (uuid) buffer real values. Pools exist only for columns some FK actually references.
- **Distributions** per FK edge: `uniform`, `zipf` (power-law hotspot via `floor(n·u^skew)` — realistic "few customers place most orders" shape), `roundRobin` (`i % n` — guarantees every parent has children), `oneToOne` (Fisher–Yates permutation — bijective, for 1:1 relations).
- **Hot loop**: each column compiles once to a monomorphic closure; the row loop is `row[c] = gens[c](i)` with no branching, option lookup, or object allocation. Async is bypassed unless the batch callback actually returns a Promise.
- **Streaming**: rows leave the engine in 10k-row `RowBatch` arrays, so the writer flushes to disk while generation continues; peak memory ≈ batchSize × columns, independent of total rows.

Measured (sandbox, single thread): **217,200 rows across 6 tables in 81 ms (~2.7M rows/sec)**; 110k rows generated *and committed to a real SQLite file* in 152 ms.

## Component C — Dictionaries & Determinism

- **PRNG**: mulberry32 (one `imul` mix per draw) seeded via xmur3 string hashing. Streams are derived per table and per column (`root.derive('table:users').derive('col:email')`), so adding a table never shifts any other table's data — datasets are stable and diffable.
- **Reproducibility as a feature**: schema + seed string ⇒ byte-identical dataset on any machine. Teams share a 20-char seed instead of a 2 GB dump. Dictionary arrays are append-only and versioned (`DICT_VERSION`) so old projects regenerate identically across app updates.
- **Composition beats enumeration**: ~10 KB of orthogonal word lists yields 10k+ full names, unbounded unique emails (`first.last{rowIndex}@domain` — collision-free at any scale without a dedupe set), ~2.4M addresses. Scaling path: promote arrays to bundled JSON locale assets (`en.json`, `de.json`, …) — generators never change, matrices grow.
- **Custom patterns**: mask patterns (`SKU-####-AA`), weighted enums (binary-searched prefix sums), and `{slot}` templates cover user-defined formats, all compiled to closures at table start.

## Component D — SQLite Writer

Ranked by real-world impact: one transaction per batch (SQLite's cost is the per-transaction fsync, not per-row execute); multi-row prepared INSERTs chunked under `SQLITE_MAX_VARIABLE_NUMBER` (32k vars, `rowsPerStmt = floor(32000 / nCols)`); bulk-load pragmas (`journal_mode=WAL`, `synchronous=OFF` during seed — the file is disposable mid-run — then `NORMAL`, `temp_store=MEMORY`, 64 MB cache); `foreign_keys=OFF` during load with a `pragma_foreign_key_check` audit at finalize (must return 0 rows — belt-and-braces on top of by-construction integrity).

Deferred-edge patches load pairs into an indexed temp table and apply one set-based `UPDATE … WHERE pk IN (SELECT k FROM _forge_patch)` — orders of magnitude faster than per-row UPDATEs.

The TS writer targets a minimal `SqlExecutor` interface, so it runs against `@tauri-apps/plugin-sql`, `node:sqlite` (tests), or the production path used by the app: `src-tauri/src/seed.rs`, a rusqlite bridge taking one IPC hop per 10k-row batch with `prepare_cached` statements inside a single transaction, keeping the webview thread free for progress UI.

## Layout

```
src/engine/
  types.ts          Schema/plan/batch contracts (JSON-serializable project files)
  planner.ts        Component A
  seeder.ts         Component B
  prng.ts           Component C — seeded PRNG core
  dictionaries.ts   Component C — bundled word matrices
  generators.ts     Component C — ColumnSpec → closure compiler
  sqlite-writer.ts  Component D (TS side)
  index.ts          Public API barrel
src/                React GUI (App.tsx, main.tsx, styles.css, defaultSchema.ts)
src-tauri/
  src/seed.rs       Component D (Rust bridge — used by the desktop app)
  src/lib.rs        Tauri builder + command registration
scripts/
  demo.ts           Verification harness (plan, integrity, determinism, perf)
  sqlite-e2e.mjs    End-to-end: seeder → writer → real SQLite file → FK audit
```

Verify: `npm run typecheck && npm run demo` (or `tsc --outDir dist src/engine/*.ts scripts/demo.ts && node dist/scripts/demo.js`).
