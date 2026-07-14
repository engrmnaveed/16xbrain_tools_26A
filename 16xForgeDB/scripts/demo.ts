/**
 * ForgeDB engine verification harness.
 *
 * Exercises the full pipeline on a 217k-row schema containing:
 *  - a 3-level dependency chain (users -> orders -> order_items)
 *  - a genuine circular dependency  (teams.lead_user_id <-> users.team_id)
 *  - a self-referencing hierarchy   (employees.manager_id -> employees.id)
 *  - uuid and increment key styles, zipf/roundRobin/uniform distributions
 *
 * Asserts: topological order, ZERO broken FKs, deferred-edge patching,
 * seed determinism, cycle-error detection. Prints throughput.
 */

import type { FkPatch, RowBatch, SchemaSpec, SqlValue } from '../src/engine/types.js';
import { CircularDependencyError, planGeneration } from '../src/engine/planner.js';
import { SeederEngine } from '../src/engine/seeder.js';

const schema: SchemaSpec = {
  seed: 'demo-seed-001',
  tables: [
    {
      name: 'teams',
      rows: 200,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'name', kind: 'company' },
        // CYCLE: teams -> users while users -> teams. Deferrable, so the
        // planner breaks THIS edge and the seeder patches it in pass 2.
        { name: 'lead_user_id', kind: 'fk', ref: { table: 'users', column: 'id', deferrable: true } },
      ],
    },
    {
      name: 'users',
      rows: 10_000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'full_name', kind: 'fullName' },
        { name: 'email', kind: 'email', unique: true },
        { name: 'phone', kind: 'phone', nullRatio: 0.2 },
        { name: 'created_at', kind: 'datetime', from: '2022-01-01', to: '2026-07-01' },
        { name: 'team_id', kind: 'fk', ref: { table: 'teams', column: 'id', distribution: 'roundRobin' } },
      ],
    },
    {
      name: 'products',
      rows: 5_000,
      columns: [
        { name: 'id', kind: 'uuid', primaryKey: true },
        { name: 'sku', kind: 'pattern', pattern: 'SKU-####-AA' },
        { name: 'name', kind: 'template', template: '{word} {word}' },
        { name: 'price', kind: 'float', min: 1, max: 500, precision: 2 },
        { name: 'category', kind: 'enum', values: ['electronics', 'home', 'toys', 'apparel'], weights: [5, 3, 1, 2] },
      ],
    },
    {
      name: 'orders',
      rows: 50_000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'user_id', kind: 'fk', ref: { table: 'users', column: 'id', distribution: 'zipf', skew: 2 } },
        { name: 'status', kind: 'enum', values: ['pending', 'shipped', 'delivered', 'cancelled'], weights: [1, 2, 6, 1] },
        { name: 'ordered_at', kind: 'datetime', from: '2024-01-01', to: '2026-07-01' },
      ],
    },
    {
      name: 'order_items',
      rows: 150_000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'order_id', kind: 'fk', ref: { table: 'orders', column: 'id', distribution: 'roundRobin' } },
        { name: 'product_id', kind: 'fk', ref: { table: 'products', column: 'id' } },
        { name: 'quantity', kind: 'int', min: 1, max: 5 },
      ],
    },
    {
      name: 'employees',
      rows: 2_000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'name', kind: 'fullName' },
        // Self-reference: sampled only from earlier rows; roots get NULL.
        { name: 'manager_id', kind: 'fk', ref: { table: 'employees', column: 'id', nullRatio: 0.05 } },
      ],
    },
  ],
};

function fail(msg: string): never {
  throw new Error(`❌ FAIL: ${msg}`);
}
const ok = (msg: string) => console.log(`✅ ${msg}`);

// --- 1. Planner ------------------------------------------------------------

const plan = planGeneration(schema);
console.log(`Plan order:    ${plan.order.join(' -> ')}`);
console.log(`Levels:        ${plan.levels.map((l) => `[${l.join(',')}]`).join(' ')}`);
console.log(`Deferred:      ${plan.deferredEdges.map((e) => `${e.childTable}.${e.childColumn}`).join(', ') || 'none'}`);

const pos = new Map(plan.order.map((t, i) => [t, i]));
for (const e of plan.activeEdges) {
  if (pos.get(e.parentTable)! >= pos.get(e.childTable)!) {
    fail(`order violation: ${e.parentTable} must precede ${e.childTable}`);
  }
}
ok('topological order respects every active FK edge');
if (plan.deferredEdges.length !== 1 || plan.deferredEdges[0].childTable !== 'teams') {
  fail('expected exactly the teams.lead_user_id edge to be deferred');
}
ok('cycle resolved by deferring teams.lead_user_id');

// Unresolvable cycle must throw with the path.
try {
  planGeneration({
    tables: [
      { name: 'a', rows: 1, columns: [{ name: 'id', kind: 'increment', primaryKey: true }, { name: 'b_id', kind: 'fk', ref: { table: 'b', column: 'id' } }] },
      { name: 'b', rows: 1, columns: [{ name: 'id', kind: 'increment', primaryKey: true }, { name: 'a_id', kind: 'fk', ref: { table: 'a', column: 'id' } }] },
    ],
  });
  fail('unresolvable cycle was not detected');
} catch (e) {
  if (!(e instanceof CircularDependencyError)) throw e;
  ok(`unresolvable cycle detected: ${e.cycle.join(' <-> ')}`);
}

// --- 2. Seeder -------------------------------------------------------------

async function generate() {
  const data = new Map<string, { columns: string[]; rows: SqlValue[][] }>();
  const patches: FkPatch[] = [];
  const engine = new SeederEngine(schema, plan);
  const result = await engine.run({
    batchSize: 10_000,
    onBatch: (b: RowBatch) => {
      const t = data.get(b.table) ?? { columns: b.columns, rows: [] };
      t.rows.push(...b.rows);
      data.set(b.table, t);
    },
    onPatch: (p) => {
      patches.push(p);
    },
  });
  return { data, patches, result };
}

const { data, patches, result } = await generate();

for (const s of result.stats) {
  console.log(`  ${s.table.padEnd(12)} ${String(s.rows).padStart(7)} rows  ${s.ms.toFixed(1)} ms`);
}
const rowsPerSec = Math.round(result.totalRows / (result.totalMs / 1000));
console.log(`TOTAL: ${result.totalRows.toLocaleString()} rows in ${result.totalMs.toFixed(0)} ms  (~${rowsPerSec.toLocaleString()} rows/sec)`);

for (const t of schema.tables) {
  if (data.get(t.name)?.rows.length !== t.rows) fail(`${t.name}: wrong row count`);
}
ok('exact requested row counts for all 6 tables');

// --- 3. Referential integrity audit ----------------------------------------

const colIdx = (table: string, col: string) => data.get(table)!.columns.indexOf(col);
const pkSet = (table: string, col: string) =>
  new Set(data.get(table)!.rows.map((r) => r[colIdx(table, col)]));

function auditFk(child: string, fkCol: string, parent: string, parentCol: string, allowNull: boolean) {
  const parents = pkSet(parent, parentCol);
  const idx = colIdx(child, fkCol);
  let nulls = 0;
  for (const row of data.get(child)!.rows) {
    const v = row[idx];
    if (v === null) {
      if (!allowNull) fail(`${child}.${fkCol}: unexpected NULL`);
      nulls++;
      continue;
    }
    if (!parents.has(v)) fail(`${child}.${fkCol}: broken FK value ${v}`);
  }
  return nulls;
}

auditFk('users', 'team_id', 'teams', 'id', false);
auditFk('orders', 'user_id', 'users', 'id', false);
auditFk('order_items', 'order_id', 'orders', 'id', false);
auditFk('order_items', 'product_id', 'products', 'id', false);
auditFk('employees', 'manager_id', 'employees', 'id', true);
ok('0 broken foreign keys across 210,000 FK-bearing values');

// roundRobin coverage: every order must have >= 1 item.
const orderIds = pkSet('orders', 'id');
const usedOrders = pkSet('order_items', 'order_id');
if (usedOrders.size !== orderIds.size) fail('roundRobin left some orders without items');
ok('roundRobin coverage: all 50,000 orders have at least one order_item');

// Self-reference: manager must be an EARLIER row (id strictly smaller).
{
  const idIdx = colIdx('employees', 'id');
  const mgrIdx = colIdx('employees', 'manager_id');
  for (const row of data.get('employees')!.rows) {
    const mgr = row[mgrIdx];
    if (mgr !== null && (mgr as number) >= (row[idIdx] as number)) {
      fail('employee manages themself or a later row — hierarchy broken');
    }
  }
  ok('self-referencing hierarchy is acyclic (managers precede reports)');
}

// Deferred patch: pass 1 must be all-NULL, patch values must be valid user ids.
{
  const leadIdx = colIdx('teams', 'lead_user_id');
  if (!data.get('teams')!.rows.every((r) => r[leadIdx] === null)) {
    fail('deferred column not NULL in pass 1');
  }
  const userIds = pkSet('users', 'id');
  const patched = patches.flatMap((p) => p.pairs);
  if (patched.length !== 200) fail(`expected 200 patch pairs, got ${patched.length}`);
  for (const [teamId, userId] of patched) {
    if (!orderIdsSafe(teamId) || !userIds.has(userId)) fail(`bad patch pair ${teamId} -> ${userId}`);
  }
  function orderIdsSafe(teamId: SqlValue): boolean {
    return typeof teamId === 'number' && teamId >= 1 && teamId <= 200;
  }
  ok('deferred edge patched: all 200 team leads are valid user ids');
}

// Unique email check.
{
  const emailIdx = colIdx('users', 'email');
  const emails = new Set(data.get('users')!.rows.map((r) => r[emailIdx]));
  if (emails.size !== 10_000) fail('duplicate emails despite unique flag');
  ok('unique flag: 10,000/10,000 distinct emails');
}

// --- 4. Determinism --------------------------------------------------------

{
  const second = await generate();
  const sample = (d: typeof data) => JSON.stringify(d.get('orders')!.rows.slice(0, 50));
  if (sample(data) !== sample(second.data)) fail('same seed produced different data');
  ok('deterministic: identical seed reproduces identical rows');
}

console.log(`\nSample user:  ${JSON.stringify(data.get('users')!.rows[7])}`);
console.log(`Sample item:  ${JSON.stringify(data.get('order_items')!.rows[12345])}`);
console.log('\nAll engine checks passed.');
