// Chunking strategies — the heart of RAG tuning.
// Each returns [{ text, start, end, meta }]

function splitSentences(text) {
  // Sentence splitter tolerant of abbreviations & newlines
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n{2,}/g);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function chunkFixed(text, { chunkSize = 512, overlap = 64 } = {}) {
  const chunks = [];
  let i = 0;
  const step = Math.max(1, chunkSize - overlap);
  while (i < text.length) {
    const slice = text.slice(i, i + chunkSize);
    if (slice.trim().length > 20) {
      chunks.push({ text: slice.trim(), start: i, end: i + slice.length });
    }
    i += step;
  }
  return chunks;
}

export function chunkSentence(text, { chunkSize = 512, overlap = 64 } = {}) {
  // Groups sentences up to ~chunkSize chars, overlapping by ~`overlap` chars of tail sentences
  const sentences = splitSentences(text);
  const chunks = [];
  let buf = [];
  let bufLen = 0;
  let cursor = 0;
  const positions = [];
  for (const s of sentences) {
    positions.push(text.indexOf(s, cursor));
    cursor = positions[positions.length - 1] + s.length;
  }
  for (let i = 0; i < sentences.length; i++) {
    buf.push(i);
    bufLen += sentences[i].length;
    if (bufLen >= chunkSize || i === sentences.length - 1) {
      const first = buf[0];
      const last = buf[buf.length - 1];
      const startPos = positions[first] >= 0 ? positions[first] : 0;
      const endPos =
        (positions[last] >= 0 ? positions[last] : startPos) + sentences[last].length;
      const t = buf.map((j) => sentences[j]).join(' ');
      if (t.trim().length > 20) chunks.push({ text: t, start: startPos, end: endPos });
      // keep tail sentences totaling ~overlap chars (never the whole buffer → guaranteed progress)
      const keep = [];
      let keepLen = 0;
      for (let k = buf.length - 1; k >= 1 && keepLen < overlap; k--) {
        keep.unshift(buf[k]);
        keepLen += sentences[buf[k]].length;
      }
      buf = keep;
      bufLen = keepLen;
    }
  }
  return chunks;
}

export function chunkParagraph(text, { chunkSize = 1200 } = {}) {
  const paras = text.split(/\n{2,}/g).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks = [];
  let cursor = 0;
  let buf = '';
  let bufStart = 0;
  for (const p of paras) {
    const pos = text.indexOf(p, cursor);
    cursor = pos + p.length;
    if (!buf) bufStart = pos;
    if (buf && buf.length + p.length > chunkSize) {
      if (buf.trim().length > 20) chunks.push({ text: buf.trim(), start: bufStart, end: pos });
      buf = p;
      bufStart = pos;
    } else {
      buf = buf ? buf + '\n\n' + p : p;
    }
  }
  if (buf.trim().length > 20)
    chunks.push({ text: buf.trim(), start: bufStart, end: bufStart + buf.length });
  return chunks;
}

export const STRATEGIES = {
  fixed: { fn: chunkFixed, label: 'Fixed size', desc: 'Sliding window of N characters with overlap. Predictable, ignores structure.' },
  sentence: { fn: chunkSentence, label: 'Sentence-aware', desc: 'Groups whole sentences up to target size. Best general-purpose default.' },
  paragraph: { fn: chunkParagraph, label: 'Paragraph', desc: 'Respects paragraph boundaries. Great for well-structured docs.' }
};

export function chunkDocument(doc, strategy = 'sentence', options = {}) {
  const s = STRATEGIES[strategy] || STRATEGIES.sentence;
  return s.fn(doc.text, options).map((c, i) => ({
    ...c,
    id: `${doc.id}#${i}`,
    docId: doc.id,
    docName: doc.name,
    index: i
  }));
}
