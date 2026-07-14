import type { SchemaSpec } from './engine/types.js';

/** Starter schema shown on first launch — demonstrates every engine feature. */
export const DEFAULT_SCHEMA: SchemaSpec = {
  seed: 'my-project-seed',
  tables: [
    {
      name: 'teams',
      rows: 200,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'name', kind: 'company' },
        { name: 'lead_user_id', kind: 'fk', ref: { table: 'users', column: 'id', deferrable: true } },
      ],
    },
    {
      name: 'users',
      rows: 10000,
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
      rows: 5000,
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
      rows: 50000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'user_id', kind: 'fk', ref: { table: 'users', column: 'id', distribution: 'zipf', skew: 2 } },
        { name: 'status', kind: 'enum', values: ['pending', 'shipped', 'delivered', 'cancelled'], weights: [1, 2, 6, 1] },
        { name: 'ordered_at', kind: 'datetime', from: '2024-01-01', to: '2026-07-01' },
      ],
    },
    {
      name: 'order_items',
      rows: 150000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'order_id', kind: 'fk', ref: { table: 'orders', column: 'id', distribution: 'roundRobin' } },
        { name: 'product_id', kind: 'fk', ref: { table: 'products', column: 'id' } },
        { name: 'quantity', kind: 'int', min: 1, max: 5 },
      ],
    },
    {
      name: 'employees',
      rows: 2000,
      columns: [
        { name: 'id', kind: 'increment', primaryKey: true },
        { name: 'name', kind: 'fullName' },
        { name: 'manager_id', kind: 'fk', ref: { table: 'employees', column: 'id', nullRatio: 0.05 } },
      ],
    },
  ],
};
