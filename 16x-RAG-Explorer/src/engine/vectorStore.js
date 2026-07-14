// In-memory vector store with cosine similarity search.
// Vectors are L2-normalized by the embedder, so dot product == cosine similarity.

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function cosineSim(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export class VectorStore {
  constructor() {
    this.items = []; // { id, docId, docName, text, vector, index, position3d }
  }

  addAll(items) {
    this.items.push(...items);
  }

  removeDoc(docId) {
    this.items = this.items.filter((c) => c.docId !== docId);
  }

  clear() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  // Returns ALL items scored (for visualization) plus topK selection.
  search(queryVector, topK = 5) {
    const scored = this.items.map((item) => ({
      ...item,
      score: dot(queryVector, item.vector)
    }));
    scored.sort((a, b) => b.score - a.score);
    return { top: scored.slice(0, topK), all: scored };
  }
}
