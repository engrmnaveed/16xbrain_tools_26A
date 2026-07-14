// Smoke tests for the RAG engine (pure logic — no model download needed).
// Run: npm test
import assert from 'node:assert';
import { chunkFixed, chunkSentence, chunkParagraph, chunkDocument } from '../src/engine/chunker.js';
import { VectorStore, cosineSim, dot } from '../src/engine/vectorStore.js';
import { pca3 } from '../src/engine/projection.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const LONG_TEXT = Array.from({ length: 30 }, (_, i) =>
  `This is sentence number ${i + 1} about warehouse robotics and fleet management systems. ` +
  `It describes batteries, navigation, and safety compliance in detail.`
).join(' ');

const PARA_TEXT = Array.from({ length: 8 }, (_, i) =>
  `Paragraph ${i + 1}. It has multiple sentences about a distinct topic. More detail follows here to pad the paragraph out to a reasonable length for chunking tests.`
).join('\n\n');

console.log('chunker');
test('fixed chunking covers text with overlap', () => {
  const chunks = chunkFixed(LONG_TEXT, { chunkSize: 500, overlap: 100 });
  assert.ok(chunks.length > 3, `expected >3 chunks, got ${chunks.length}`);
  assert.ok(chunks.every((c) => c.text.length <= 500));
  // consecutive chunks overlap
  assert.ok(chunks[1].start < chunks[0].end);
});

test('sentence chunking respects sentence boundaries', () => {
  const chunks = chunkSentence(LONG_TEXT, { chunkSize: 400, overlap: 1 });
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.ok(/[.!?]$/.test(c.text.trim()), `chunk should end with punctuation: "${c.text.slice(-30)}"`);
});

test('paragraph chunking respects paragraph boundaries', () => {
  const chunks = chunkParagraph(PARA_TEXT, { chunkSize: 400 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.text.startsWith('Paragraph'));
});

test('chunkDocument attaches ids and metadata', () => {
  const doc = { id: 'd1', name: 'test.md', text: LONG_TEXT };
  const chunks = chunkDocument(doc, 'sentence', { chunkSize: 400 });
  assert.strictEqual(chunks[0].id, 'd1#0');
  assert.strictEqual(chunks[0].docName, 'test.md');
  assert.strictEqual(chunks[2].index, 2);
});

console.log('vector store');
test('search ranks by cosine similarity', () => {
  const store = new VectorStore();
  const mk = (id, v) => ({ id, docId: 'd', docName: 'd', text: id, vector: v, index: 0 });
  store.addAll([
    mk('exact', [1, 0, 0]),
    mk('close', [0.9, 0.43, 0]),
    mk('orthogonal', [0, 1, 0]),
    mk('opposite', [-1, 0, 0])
  ]);
  const { top, all } = store.search([1, 0, 0], 2);
  assert.strictEqual(top[0].id, 'exact');
  assert.strictEqual(top[1].id, 'close');
  assert.strictEqual(all.length, 4);
  assert.ok(all[3].score < 0);
});

test('cosineSim of identical vectors is 1', () => {
  assert.ok(Math.abs(cosineSim([0.3, 0.4, 0.5], [0.3, 0.4, 0.5]) - 1) < 1e-9);
});

test('dot equals cosine for normalized vectors', () => {
  const n = Math.sqrt(2);
  const a = [1 / n, 1 / n, 0];
  assert.ok(Math.abs(dot(a, a) - cosineSim(a, a)) < 1e-9);
});

test('removeDoc removes only that doc', () => {
  const store = new VectorStore();
  store.addAll([
    { id: 'a#0', docId: 'a', vector: [1, 0] },
    { id: 'b#0', docId: 'b', vector: [0, 1] }
  ]);
  store.removeDoc('a');
  assert.strictEqual(store.size, 1);
  assert.strictEqual(store.items[0].docId, 'b');
});

console.log('projection');
test('pca3 separates distinct clusters', () => {
  // two clusters in 10-dim space
  const vectors = [];
  for (let i = 0; i < 20; i++) {
    const v = new Array(10).fill(0).map(() => Math.sin(i * 7.13 + 1) * 0.05);
    if (i < 10) v[0] += 1; else v[1] += 1;
    vectors.push(v);
  }
  const { positions, project } = pca3(vectors);
  assert.strictEqual(positions.length, 20);
  // cluster centroids should be far apart in 3D
  const centroid = (idx) => {
    const c = [0, 0, 0];
    for (const i of idx) for (let k = 0; k < 3; k++) c[k] += positions[i][k] / idx.length;
    return c;
  };
  const c1 = centroid([...Array(10).keys()]);
  const c2 = centroid([...Array(10).keys()].map((i) => i + 10));
  const distApart = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
  assert.ok(distApart > 20, `clusters should separate, dist=${distApart}`);
  // project() maps a known vector near its own cluster
  const p = project(vectors[0]);
  const dToOwn = Math.hypot(p[0] - c1[0], p[1] - c1[1], p[2] - c1[2]);
  const dToOther = Math.hypot(p[0] - c2[0], p[1] - c2[1], p[2] - c2[2]);
  assert.ok(dToOwn < dToOther);
});

test('pca3 handles edge cases', () => {
  assert.deepStrictEqual(pca3([]).positions, []);
  assert.strictEqual(pca3([[1, 2, 3]]).positions.length, 1);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
