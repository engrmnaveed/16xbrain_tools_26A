import { DatabaseSync } from 'node:sqlite';
import { SeederEngine } from '../dist/src/engine/seeder.js';
// Run: tsc --outDir dist src/engine/*.ts && node --experimental-sqlite scripts/sqlite-e2e.mjs
import { SqliteBatchWriter } from '../dist/src/engine/sqlite-writer.js';

// Reuse the demo schema by importing its module would run its asserts; define compact one:
const schema = {
  seed: 'e2e-1',
  tables: [
    { name: 'teams', rows: 100, columns: [
      { name: 'id', kind: 'increment', primaryKey: true },
      { name: 'name', kind: 'company' },
      { name: 'lead_user_id', kind: 'fk', ref: { table: 'users', column: 'id', deferrable: true } },
    ]},
    { name: 'users', rows: 10000, columns: [
      { name: 'id', kind: 'increment', primaryKey: true },
      { name: 'email', kind: 'email', unique: true },
      { name: 'team_id', kind: 'fk', ref: { table: 'teams', column: 'id' } },
    ]},
    { name: 'orders', rows: 100000, columns: [
      { name: 'id', kind: 'increment', primaryKey: true },
      { name: 'user_id', kind: 'fk', ref: { table: 'users', column: 'id', distribution: 'zipf' } },
      { name: 'total', kind: 'float', min: 5, max: 900 },
      { name: 'placed_at', kind: 'datetime' },
    ]},
  ],
};

const db = new DatabaseSync('/tmp/forge-e2e.db');
const executor = { execute: async (sql, binds) => binds ? db.prepare(sql).run(...binds) : db.exec(sql) };

const writer = new SqliteBatchWriter(executor);
await writer.init(schema);

const t0 = performance.now();
const engine = new SeederEngine(schema);
await engine.run({
  onBatch: (b) => writer.writeBatch(b),
  onPatch: (p) => writer.applyPatch(p),
});
await writer.finalize();
const ms = performance.now() - t0;

const count = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
const broken = db.prepare(`SELECT count(*) c FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE u.id IS NULL`).get().c;
const nullLeads = db.prepare(`SELECT count(*) c FROM teams WHERE lead_user_id IS NULL`).get().c;
const fkViolations = db.prepare(`SELECT count(*) c FROM pragma_foreign_key_check`).get().c;

console.log(`rows: teams=${count('teams')} users=${count('users')} orders=${count('orders')}`);
console.log(`gen+write time: ${ms.toFixed(0)} ms (110,100 rows -> disk)`);
console.log(`broken order->user FKs: ${broken}`);
console.log(`teams with NULL lead after patch: ${nullLeads}`);
console.log(`PRAGMA foreign_key_check violations: ${fkViolations}`);
if (broken || nullLeads || fkViolations) { console.log('E2E FAIL'); process.exit(1); }
console.log('SQLITE E2E OK');
