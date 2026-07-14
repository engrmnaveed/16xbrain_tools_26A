// SchemaMind core-engine smoke tests — run with: npm test  (plain node, no deps)
import assert from 'node:assert';
import { parseScript, serializeProject } from '../src/dsl/parser.js';
import { importSQL, importJSON, importCSV } from '../src/io/importers.js';
import { exportSQL, exportMongoose, exportPrisma, exportTypeScript, exportJSONSchema, exportDBML, exportMarkdown, exportMongoValidator } from '../src/io/exporters.js';
import { generateData, dataToCSV, dataToSQLInserts, dataToMongoInserts } from '../src/datagen/generator.js';
import { validateProject, topoOrder, createProject } from '../src/model/schema.js';

// Node has no localStorage — not needed for these modules.
let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log('\nSchemaMind smoke tests\n');

// ---------- DSL ----------
const DSL = `
table users {
  note: "Registered accounts"
  id uuid pk
  email string unique !null
  role enum(admin, member, guest) default(member)
  created_at datetime default(now) index
}

table orders {
  id int pk default(autoincrement)
  total decimal !null
  status enum(pending, paid, shipped) default(pending)
}

table profiles {
  id uuid pk
  bio text
}

ref orders.user_id > users.id
ref profiles.user_id - users.id [delete: restrict]
`;

let project;
test('DSL parses tables, enums, modifiers, refs', () => {
  const { tables, relations } = parseScript(DSL);
  assert.equal(tables.length, 3);
  assert.equal(relations.length, 2);
  const users = tables.find(t => t.name === 'users');
  assert.equal(users.note, 'Registered accounts');
  const role = users.fields.find(f => f.name === 'role');
  assert.deepEqual(role.enumValues, ['admin', 'member', 'guest']);
  assert.equal(role.default, 'member');
  const email = users.fields.find(f => f.name === 'email');
  assert.ok(email.unique && !email.nullable);
  // auto-created FK
  const orders = tables.find(t => t.name === 'orders');
  assert.ok(orders.fields.find(f => f.name === 'user_id'));
  const oneone = relations.find(r => r.kind === 'one-one');
  assert.equal(oneone.onDelete, 'restrict');
  project = { ...createProject('Test'), tables, relations };
});

test('DSL round-trips (serialize → parse)', () => {
  const text = serializeProject(project);
  const again = parseScript(text);
  assert.equal(again.tables.length, project.tables.length);
  assert.equal(again.relations.length, project.relations.length);
  const u1 = project.tables.find(t => t.name === 'users').fields.map(f => f.name).sort();
  const u2 = again.tables.find(t => t.name === 'users').fields.map(f => f.name).sort();
  assert.deepEqual(u1, u2);
});

test('DSL errors carry line numbers', () => {
  assert.throws(() => parseScript('table x {\n  id wat pk\n}'), /Line 2/);
});

// ---------- validation & topo ----------
test('validateProject flags missing pk', () => {
  const { tables, relations } = parseScript('table a {\n  id uuid pk\n}\ntable b {\n  name string\n}');
  const issues = validateProject({ tables, relations });
  assert.ok(issues.some(i => /no primary key/.test(i.message)));
});

test('topoOrder puts referenced tables first', () => {
  const order = topoOrder(project).map(t => t.name);
  assert.ok(order.indexOf('users') < order.indexOf('orders'));
  assert.ok(order.indexOf('users') < order.indexOf('profiles'));
});

// ---------- SQL import ----------
const SQL = `
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  status ENUM('active','banned') DEFAULT 'active',
  balance NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL,
  total DECIMAL(10,2),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
`;
test('SQL DDL import: columns, constraints, FKs', () => {
  const { tables, relations } = importSQL(SQL);
  assert.equal(tables.length, 2);
  assert.equal(relations.length, 1);
  const c = tables.find(t => t.name === 'customers');
  assert.equal(c.fields.find(f => f.name === 'id').default, 'autoincrement');
  assert.ok(c.fields.find(f => f.name === 'email').unique);
  const st = c.fields.find(f => f.name === 'status');
  assert.equal(st.type, 'enum');
  assert.deepEqual(st.enumValues, ['active', 'banned']);
  assert.equal(c.fields.find(f => f.name === 'created_at').default, 'now');
});

// ---------- JSON import ----------
test('JSON inference creates child tables + FKs', () => {
  const { tables, relations } = importJSON(JSON.stringify({
    id: 1, name: 'Ada', address: { city: 'London' },
    orders: [{ id: 10, total: 9.99, placed_at: '2026-01-01T10:00:00Z' }]
  }), 'customers');
  assert.equal(tables.length, 3);
  assert.equal(relations.length, 2);
  const orders = tables.find(t => /orders/.test(t.name));
  assert.equal(orders.fields.find(f => f.name === 'total').type, 'float');
  assert.equal(orders.fields.find(f => f.name === 'placed_at').type, 'datetime');
  assert.ok(relations.some(r => r.kind === 'one-one')); // address
});

// ---------- CSV import ----------
test('CSV import infers types from samples', () => {
  const { tables } = importCSV('id,name,price,active,joined\n1,Ann,9.99,true,2024-01-05\n2,Bob,12.50,false,2024-02-11', 'products');
  const t = tables[0];
  assert.equal(t.fields.find(f => f.name === 'id').type, 'int');
  assert.equal(t.fields.find(f => f.name === 'price').type, 'float');
  assert.equal(t.fields.find(f => f.name === 'active').type, 'boolean');
  assert.equal(t.fields.find(f => f.name === 'joined').type, 'date');
});

// ---------- exporters ----------
test('exports produce non-empty, well-formed output', () => {
  const pg = exportSQL(project, 'postgres');
  assert.ok(pg.includes('CREATE TABLE "users"'));
  assert.ok(pg.includes('FOREIGN KEY'));
  assert.ok(/CHECK \("role" IN \('admin', 'member', 'guest'\)\)/.test(pg));
  const my = exportSQL(project, 'mysql');
  assert.ok(my.includes('ENUM(') && my.includes('`users`'));
  const mg = exportMongoose(project);
  assert.ok(mg.includes("mongoose.model('Users'") && mg.includes('Schema.Types.ObjectId'));
  const pr = exportPrisma(project);
  assert.ok(pr.includes('model Users') && pr.includes('@relation'));
  const ts = exportTypeScript(project);
  assert.ok(ts.includes('export interface Users') && ts.includes("'admin' | 'member' | 'guest'"));
  const js = JSON.parse(exportJSONSchema(project));
  assert.ok(js.$defs.users.properties.email);
  assert.ok(exportDBML(project).includes('Ref: orders.user_id > users.id'));
  assert.ok(exportMarkdown(project).includes('| email |'));
  assert.ok(exportMongoValidator(project).includes('$jsonSchema'));
});

// ---------- data generator ----------
test('data generator: counts, FK integrity, determinism, uniqueness', () => {
  const d1 = generateData(project, { defaultRows: 30, seed: 7 });
  const d2 = generateData(project, { defaultRows: 30, seed: 7 });
  assert.deepEqual(d1, d2); // seeded determinism
  assert.equal(d1.users.length, 30);
  const userIds = new Set(d1.users.map(r => r.id));
  for (const o of d1.orders) assert.ok(userIds.has(o.user_id), 'FK must reference a real user');
  const emails = d1.users.map(r => r.email);
  assert.equal(new Set(emails).size, emails.length, 'unique emails');
  assert.ok(emails[0].includes('@'));
  const statuses = new Set(d1.orders.map(r => r.status).filter(Boolean));
  for (const s of statuses) assert.ok(['pending', 'paid', 'shipped'].includes(s));
});

test('data serializers: CSV, SQL inserts, Mongo', () => {
  const d = generateData(project, { defaultRows: 5, seed: 1 });
  const csv = dataToCSV(d.users);
  assert.equal(csv.split('\n').length, 6);
  const sql = dataToSQLInserts(project, d);
  assert.ok(sql.indexOf('INSERT INTO "users"') < sql.indexOf('INSERT INTO "orders"'), 'parents inserted first');
  assert.ok(dataToMongoInserts(d).includes('db.users.insertMany'));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}\n`);
