/** ForgeDB Internal Generation Engine — public API surface. */

export * from './types.js';
export { planGeneration, extractEdges, CircularDependencyError, SchemaValidationError } from './planner.js';
export type { FkEdge, GenerationPlan } from './planner.js';
export { SeederEngine } from './seeder.js';
export type { SeederCallbacks, SeedResult, KeyPool } from './seeder.js';
export { Rng, hashSeed, buildCumulative } from './prng.js';
export { compileColumn } from './generators.js';
export type { ValueGen } from './generators.js';
export { SqliteBatchWriter, buildCreateTable, quoteIdent } from './sqlite-writer.js';
export type { SqlExecutor } from './sqlite-writer.js';
export { DICT_VERSION } from './dictionaries.js';
