// PCA projection of high-dim embeddings to 3D for the galaxy view.
// Deterministic, dependency-free, fast for thousands of points.

function meanVector(vectors) {
  const dim = vectors[0].length;
  const mean = new Float64Array(dim);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += v[i];
  for (let i = 0; i < dim; i++) mean[i] /= vectors.length;
  return mean;
}

// Power iteration to find top eigenvector of covariance (implicitly, via X^T X v)
function topComponent(centered, dim, iters = 60) {
  let v = new Float64Array(dim);
  // deterministic init
  for (let i = 0; i < dim; i++) v[i] = Math.sin(i * 12.9898) * 0.5 + 0.5;
  for (let it = 0; it < iters; it++) {
    const next = new Float64Array(dim);
    for (const row of centered) {
      let proj = 0;
      for (let i = 0; i < dim; i++) proj += row[i] * v[i];
      for (let i = 0; i < dim; i++) next[i] += proj * row[i];
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] = next[i] / norm;
  }
  return v;
}

function deflate(centered, comp) {
  for (const row of centered) {
    let proj = 0;
    for (let i = 0; i < row.length; i++) proj += row[i] * comp[i];
    for (let i = 0; i < row.length; i++) row[i] -= proj * comp[i];
  }
}

// Returns { positions: [[x,y,z]...], project: (vector) => [x,y,z] }
export function pca3(vectors, spread = 60) {
  if (vectors.length === 0) return { positions: [], project: () => [0, 0, 0] };
  if (vectors.length === 1)
    return { positions: [[0, 0, 0]], project: () => [0, 0, 8] };

  const dim = vectors[0].length;
  const mean = meanVector(vectors);
  const centered = vectors.map((v) => {
    const row = new Float64Array(dim);
    for (let i = 0; i < dim; i++) row[i] = v[i] - mean[i];
    return row;
  });

  const comps = [];
  for (let c = 0; c < 3; c++) {
    const comp = topComponent(centered, dim);
    comps.push(comp);
    deflate(centered, comp);
  }

  // Re-center originals for projection
  const projectRaw = (v) => {
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let i = 0; i < dim; i++) s += (v[i] - mean[i]) * comps[c][i];
      out[c] = s;
    }
    return out;
  };

  const raw = vectors.map(projectRaw);

  // Normalize scale so the cloud fits nicely in view
  let maxAbs = 1e-9;
  for (const p of raw)
    for (const x of p) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = spread / maxAbs;

  return {
    positions: raw.map((p) => p.map((x) => x * scale)),
    project: (v) => projectRaw(v).map((x) => x * scale)
  };
}
