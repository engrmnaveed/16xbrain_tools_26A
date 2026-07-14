// Local embedding via transformers.js — documents never leave the machine.
// Model: Xenova/all-MiniLM-L6-v2 (384-dim), ~25MB, downloaded once then cached.

let pipelinePromise = null;
let progressCb = null;

export function onModelProgress(cb) {
  progressCb = cb;
}

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        progress_callback: (p) => {
          if (progressCb && p.status === 'progress') {
            progressCb({ file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
          }
        }
      });
    })();
  }
  return pipelinePromise;
}

export async function embedTexts(texts, onBatch) {
  const pipe = await getPipeline();
  const out = [];
  const BATCH = 8;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await pipe(batch, { pooling: 'mean', normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let j = 0; j < batch.length; j++) {
      out.push(Array.from(res.data.slice(j * dim, (j + 1) * dim)));
    }
    if (onBatch) onBatch(Math.min(i + BATCH, texts.length), texts.length);
    // Yield to UI thread
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

export async function embedText(text) {
  return (await embedTexts([text]))[0];
}

export async function warmup() {
  await getPipeline();
}
