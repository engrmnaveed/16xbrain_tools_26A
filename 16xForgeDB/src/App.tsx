import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { SchemaSpec, TableStats } from './engine/types.js';
import type { GenerationPlan } from './engine/planner.js';
import { planGeneration, CircularDependencyError, SchemaValidationError } from './engine/planner.js';
import { SeederEngine } from './engine/seeder.js';
import { buildCreateTable, quoteIdent } from './engine/sqlite-writer.js';
import { DEFAULT_SCHEMA } from './defaultSchema.js';

type Phase = 'idle' | 'planned' | 'generating' | 'done' | 'error';

interface DoneInfo {
  path: string;
  stats: TableStats[];
  totalRows: number;
  totalMs: number;
  fkViolations: number;
}

export default function App() {
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(DEFAULT_SCHEMA, null, 2));
  const [phase, setPhase] = useState<Phase>('idle');
  const [plan, setPlan] = useState<GenerationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ written: 0, total: 0, table: '' });
  const [done, setDone] = useState<DoneInfo | null>(null);
  const generating = useRef(false);

  const parsed = useMemo<{ schema: SchemaSpec | null; parseError: string | null }>(() => {
    try {
      return { schema: JSON.parse(schemaText) as SchemaSpec, parseError: null };
    } catch (e) {
      return { schema: null, parseError: (e as Error).message };
    }
  }, [schemaText]);

  const totalRows = parsed.schema?.tables?.reduce((s, t) => s + (t.rows || 0), 0) ?? 0;

  function handlePlan() {
    setError(null);
    setDone(null);
    if (!parsed.schema) {
      setError(`Invalid JSON: ${parsed.parseError}`);
      setPhase('error');
      return;
    }
    try {
      setPlan(planGeneration(parsed.schema));
      setPhase('planned');
    } catch (e) {
      if (e instanceof CircularDependencyError) {
        setError(`Circular dependency: ${e.cycle.join(' → ')} → ${e.cycle[0]}. Mark one FK in this loop as "deferrable": true.`);
      } else if (e instanceof SchemaValidationError) {
        setError(e.message);
      } else {
        setError((e as Error).message);
      }
      setPlan(null);
      setPhase('error');
    }
  }

  async function handleGenerate() {
    if (generating.current || !parsed.schema || !plan) return;
    const schema = parsed.schema;

    const path = await save({
      title: 'Save generated SQLite database',
      defaultPath: 'forgedb-seed.db',
      filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (!path) return;

    generating.current = true;
    setPhase('generating');
    setError(null);
    setDone(null);
    setProgress({ written: 0, total: totalRows, table: '' });

    try {
      // DDL in dependency order (planner guarantees parents first).
      const byName = new Map(schema.tables.map((t) => [t.name, t]));
      const ddl: string[] = [];
      for (const name of plan.order) {
        ddl.push(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
        ddl.push(buildCreateTable(byName.get(name)!, schema));
      }
      await invoke('seed_open', { path, ddl });

      let written = 0;
      const t0 = performance.now();
      const engine = new SeederEngine(schema, plan);
      const result = await engine.run({
        batchSize: 10_000,
        onBatch: async (batch) => {
          await invoke('seed_write_batch', { batch });
          written += batch.rows.length;
          setProgress({ written, total: totalRows, table: batch.table });
        },
        onPatch: async (patch) => {
          await invoke('seed_apply_patch', { patch });
        },
      });
      const fkViolations = await invoke<number>('seed_finalize');
      setDone({
        path,
        stats: result.stats,
        totalRows: result.totalRows,
        totalMs: performance.now() - t0,
        fkViolations,
      });
      setPhase('done');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    } finally {
      generating.current = false;
    }
  }

  const pct = progress.total > 0 ? Math.round((progress.written / progress.total) * 100) : 0;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">⚒</span>
          <div>
            <h1>ForgeDB</h1>
            <p>Offline relational mock data seeder — deterministic, zero network</p>
          </div>
        </div>
        <div className="header-meta">
          {parsed.schema && <span className="chip">{parsed.schema.tables?.length ?? 0} tables · {totalRows.toLocaleString()} rows</span>}
        </div>
      </header>

      <main>
        <section className="panel editor-panel">
          <div className="panel-title">
            <h2>Schema</h2>
            <button className="secondary" onClick={() => setSchemaText(JSON.stringify(DEFAULT_SCHEMA, null, 2))}>
              Reset example
            </button>
          </div>
          <textarea
            spellCheck={false}
            value={schemaText}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              setSchemaText(e.target.value);
              setPhase('idle');
              setPlan(null);
            }}
          />
          {parsed.parseError && <div className="inline-error">JSON: {parsed.parseError}</div>}
        </section>

        <section className="panel result-panel">
          <div className="actions">
            <button onClick={handlePlan} disabled={phase === 'generating' || !!parsed.parseError}>
              1 · Validate &amp; Plan
            </button>
            <button
              className="primary"
              onClick={handleGenerate}
              disabled={phase !== 'planned' && phase !== 'done'}
            >
              2 · Generate SQLite…
            </button>
          </div>

          {error && <div className="error-box">{error}</div>}

          {plan && (
            <div className="card">
              <h3>Execution plan</h3>
              <div className="plan-order">
                {plan.order.map((t, i) => (
                  <span key={t}>
                    {i > 0 && <span className="arrow">→</span>}
                    <span className="table-chip">{t}</span>
                  </span>
                ))}
              </div>
              {plan.deferredEdges.length > 0 && (
                <p className="note">
                  Cycle resolved: {plan.deferredEdges.map((e) => `${e.childTable}.${e.childColumn}`).join(', ')} will be
                  NULL in pass 1 and patched in pass 2.
                </p>
              )}
              {plan.selfEdges.length > 0 && (
                <p className="note">
                  Self-references handled in-table: {plan.selfEdges.map((e) => `${e.childTable}.${e.childColumn}`).join(', ')}
                </p>
              )}
            </div>
          )}

          {phase === 'generating' && (
            <div className="card">
              <h3>Generating… {progress.table && <span className="muted">({progress.table})</span>}</h3>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <p className="muted">
                {progress.written.toLocaleString()} / {progress.total.toLocaleString()} rows ({pct}%)
              </p>
            </div>
          )}

          {done && (
            <div className="card success">
              <h3>Database written ✓</h3>
              <p className="path">{done.path}</p>
              <table>
                <thead>
                  <tr><th>Table</th><th>Rows</th><th>Gen time</th></tr>
                </thead>
                <tbody>
                  {done.stats.map((s) => (
                    <tr key={s.table}>
                      <td>{s.table}</td>
                      <td>{s.rows.toLocaleString()}</td>
                      <td>{s.ms.toFixed(1)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                <strong>{done.totalRows.toLocaleString()} rows</strong> in {(done.totalMs / 1000).toFixed(2)}s ·
                FK audit: {done.fkViolations === 0 ? '0 violations ✓' : `${done.fkViolations} VIOLATIONS ✗`}
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
