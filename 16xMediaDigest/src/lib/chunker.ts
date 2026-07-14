/**
 * Smart Chunking Algorithm — deterministic, bilingual (Urdu/English).
 *
 * Purpose: small local LLMs (4k–8k ctx) cannot ingest a full transcript.
 * This module splits a Whisper transcript into sentence-aligned chunks that
 * fit a strict word budget, preserving timestamps so every digest section
 * can cite where in the media it came from.
 *
 * Guarantees:
 *  - Deterministic: pure function, same input → same output. No randomness.
 *  - Sentence-safe: never splits mid-sentence unless a single sentence
 *    exceeds the hard word cap (then it splits on word boundaries).
 *  - Bilingual: recognizes Urdu terminators (۔ ؟ ‼) and English (. ! ?).
 *  - Timestamped: each chunk carries [startTime, endTime] interpolated from
 *    Whisper segment timings.
 *  - Context continuity: optional N-sentence overlap between chunks so the
 *    LLM doesn't lose the thread at boundaries.
 */

// ---------- Types ----------

/** One timestamped segment as emitted by whisper.cpp (JSON or SRT parsed). */
export interface WhisperSegment {
  /** seconds */
  start: number;
  /** seconds */
  end: number;
  text: string;
}

export interface Sentence {
  text: string;
  wordCount: number;
  /** seconds, interpolated within the parent segment by character offset */
  start: number;
  end: number;
}

export interface TranscriptChunk {
  /** 0-based position in the chunk sequence */
  index: number;
  text: string;
  wordCount: number;
  sentenceCount: number;
  /** seconds */
  startTime: number;
  /** seconds */
  endTime: number;
  /** true if this chunk begins with overlap sentences repeated from the previous chunk */
  hasOverlap: boolean;
}

export interface ChunkerOptions {
  /** Target word budget per chunk. ~500 words ≈ 650–900 tokens (EN) — safely
   *  inside a 4k window once system prompt + output budget are added. */
  maxWords?: number;
  /** Absolute cap. A pathological run-on sentence longer than this gets
   *  force-split on word boundaries. */
  hardMaxWords?: number;
  /** Don't emit a final tiny chunk below this; merge it into the previous
   *  chunk instead (may slightly exceed maxWords, never hardMaxWords). */
  minTailWords?: number;
  /** Sentences repeated from the end of chunk N at the start of chunk N+1. */
  overlapSentences?: number;
}

const DEFAULTS: Required<ChunkerOptions> = {
  maxWords: 500,
  hardMaxWords: 650,
  minTailWords: 120,
  overlapSentences: 1,
};

// ---------- Sentence splitting ----------

/**
 * Sentence terminators:
 *   English: . ! ?        Urdu: ۔ (U+06D4 full stop)  ؟ (U+061F question)
 * A "sentence" is text up to and including a terminator run, or trailing
 * text with no terminator (Whisper often ends segments mid-sentence).
 */
const SENTENCE_RE = /[^.!?۔؟]+[.!?۔؟]+["'”’«»]?\s*|[^.!?۔؟]+$/g;

/** Whitespace tokenization — valid for both English and Urdu (space-delimited). */
export function countWords(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

/**
 * Split one Whisper segment into sentences, interpolating timestamps by
 * character offset (proportional — good enough for citation-level accuracy).
 */
function splitSegment(seg: WhisperSegment): Sentence[] {
  const text = seg.text.trim();
  if (text === "") return [];
  const duration = Math.max(0, seg.end - seg.start);
  const out: Sentence[] = [];
  let offset = 0;
  for (const raw of text.match(SENTENCE_RE) ?? [text]) {
    const s = raw.trim();
    const startFrac = offset / text.length;
    const endFrac = Math.min(1, (offset + raw.length) / text.length);
    offset += raw.length;
    if (s === "") continue;
    out.push({
      text: s,
      wordCount: countWords(s),
      start: seg.start + duration * startFrac,
      end: seg.start + duration * endFrac,
    });
  }
  return out;
}

/**
 * Whisper segments are time-sliced, not sentence-sliced: a sentence often
 * spans segments. Merge a segment's trailing fragment (no terminator) with
 * the next segment's leading text so downstream chunking sees whole sentences.
 */
export function segmentsToSentences(segments: WhisperSegment[]): Sentence[] {
  const sentences: Sentence[] = [];
  let carry: Sentence | null = null;

  for (const seg of segments) {
    for (const s of splitSegment(seg)) {
      const merged: Sentence = carry
        ? {
            text: `${carry.text} ${s.text}`,
            wordCount: carry.wordCount + s.wordCount,
            start: carry.start,
            end: s.end,
          }
        : s;
      carry = /[.!?۔؟]["'”’«»]?$/.test(merged.text) ? null : merged;
      if (!carry) sentences.push(merged);
    }
  }
  if (carry) sentences.push(carry); // transcript ended mid-sentence
  return sentences;
}

// ---------- Force-split for pathological sentences ----------

function forceSplit(s: Sentence, hardMaxWords: number): Sentence[] {
  if (s.wordCount <= hardMaxWords) return [s];
  const words = s.text.split(/\s+/);
  const pieces: Sentence[] = [];
  const duration = s.end - s.start;
  for (let i = 0; i < words.length; i += hardMaxWords) {
    const slice = words.slice(i, i + hardMaxWords);
    pieces.push({
      text: slice.join(" "),
      wordCount: slice.length,
      start: s.start + duration * (i / words.length),
      end: s.start + duration * (Math.min(i + hardMaxWords, words.length) / words.length),
    });
  }
  return pieces;
}

// ---------- Chunking ----------

/**
 * Greedy, sentence-boundary chunking with word budget + overlap.
 * Deterministic by construction: a single forward pass, no heuristics that
 * depend on anything but the input.
 */
export function chunkTranscript(
  segments: WhisperSegment[],
  options: ChunkerOptions = {}
): TranscriptChunk[] {
  const opt = { ...DEFAULTS, ...options };
  if (opt.hardMaxWords < opt.maxWords) opt.hardMaxWords = opt.maxWords;

  const sentences = segmentsToSentences(segments).flatMap((s) =>
    forceSplit(s, opt.hardMaxWords)
  );
  if (sentences.length === 0) return [];

  // 1) Greedy pack into groups of whole sentences.
  const groups: Sentence[][] = [];
  let current: Sentence[] = [];
  let currentWords = 0;
  for (const s of sentences) {
    if (current.length > 0 && currentWords + s.wordCount > opt.maxWords) {
      groups.push(current);
      current = [];
      currentWords = 0;
    }
    current.push(s);
    currentWords += s.wordCount;
  }
  if (current.length > 0) groups.push(current);

  // 2) Merge a tiny tail into the previous group (bounded by hardMaxWords).
  if (groups.length >= 2) {
    const tail = groups[groups.length - 1];
    const tailWords = tail.reduce((n, s) => n + s.wordCount, 0);
    const prev = groups[groups.length - 2];
    const prevWords = prev.reduce((n, s) => n + s.wordCount, 0);
    if (tailWords < opt.minTailWords && prevWords + tailWords <= opt.hardMaxWords) {
      prev.push(...tail);
      groups.pop();
    }
  }

  // 3) Materialize chunks, prepending overlap from the previous group.
  return groups.map((group, i) => {
    const overlap =
      i > 0 && opt.overlapSentences > 0
        ? groups[i - 1].slice(-opt.overlapSentences)
        : [];
    const all = [...overlap, ...group];
    return {
      index: i,
      text: all.map((s) => s.text).join(" "),
      wordCount: all.reduce((n, s) => n + s.wordCount, 0),
      sentenceCount: all.length,
      startTime: group[0].start, // chunk owns its own time range, not the overlap's
      endTime: group[group.length - 1].end,
      hasOverlap: overlap.length > 0,
    };
  });
}

/** Convenience: chunk raw text with no timestamps (manual paste, .txt import). */
export function chunkPlainText(
  text: string,
  options: ChunkerOptions = {}
): TranscriptChunk[] {
  return chunkTranscript([{ start: 0, end: 0, text }], options);
}

/** `mm:ss` / `h:mm:ss` label for UI + digest headings. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
