import {
  chunkTranscript,
  chunkPlainText,
  segmentsToSentences,
  countWords,
  formatTimestamp,
} from "./chunker";
import type { WhisperSegment } from "./chunker";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("FAIL:", msg);
  } else {
    console.log("ok  :", msg);
  }
}

// --- 1. English long transcript: budget respected, sentence-safe ---
const enSentences: WhisperSegment[] = [];
for (let i = 0; i < 100; i++) {
  enSentences.push({
    start: i * 10,
    end: i * 10 + 10,
    text: `Sentence number ${i} talks about the deployment pipeline and covers roughly twelve distinct words total.`,
  });
}
const enChunks = chunkTranscript(enSentences);
assert(enChunks.length > 1, "long EN transcript produces multiple chunks");
assert(
  enChunks.every((c) => c.wordCount <= 650),
  "no chunk exceeds hardMaxWords"
);
assert(
  enChunks.slice(0, -1).every((c) => c.wordCount >= 400),
  "non-tail chunks are reasonably full (>=400 words)"
);
assert(
  enChunks.slice(1).every((c) => c.hasOverlap),
  "all chunks after the first carry overlap"
);
assert(
  enChunks.every((c, i) => c.index === i),
  "indices are sequential"
);
assert(
  enChunks.every((c) => c.endTime > c.startTime),
  "timestamps are ordered"
);
// monotonic chunk time ranges
assert(
  enChunks.slice(1).every((c, i) => c.startTime >= enChunks[i].startTime),
  "chunk start times are monotonic"
);

// --- 2. Determinism ---
const again = chunkTranscript(enSentences);
assert(JSON.stringify(again) === JSON.stringify(enChunks), "deterministic: identical output on rerun");

// --- 3. Urdu sentence splitting (۔ and ؟) ---
const ur: WhisperSegment[] = [
  { start: 0, end: 8, text: "یہ ایک تکنیکی گفتگو ہے۔ کیا آپ نے سرور کی ترتیب دیکھی؟ ہم نے ڈیٹا بیس کو بہتر بنایا۔" },
];
const urSent = segmentsToSentences(ur);
assert(urSent.length === 3, `Urdu terminators split into 3 sentences (got ${urSent.length})`);
assert(urSent[1].text.endsWith("؟"), "Urdu question mark preserved");

// --- 4. Cross-segment sentence merging ---
const split: WhisperSegment[] = [
  { start: 0, end: 5, text: "This sentence continues across" },
  { start: 5, end: 10, text: "the segment boundary. Second sentence here." },
];
const merged = segmentsToSentences(split);
assert(merged.length === 2, `mid-sentence segments merge (got ${merged.length})`);
assert(merged[0].text === "This sentence continues across the segment boundary.", "merged text correct");
assert(merged[0].start === 0 && merged[0].end > 5, "merged sentence spans both segments' time");

// --- 5. Pathological run-on sentence gets force-split ---
const runon = "word ".repeat(2000).trim(); // 2000 words, no terminator
const runonChunks = chunkPlainText(runon);
assert(runonChunks.length >= 3, "2000-word run-on splits into multiple chunks");
assert(runonChunks.every((c) => c.wordCount <= 650 + 650), "force-split respects caps");

// --- 6. Tiny tail merge ---
const tail: WhisperSegment[] = [];
for (let i = 0; i < 40; i++) tail.push({ start: i, end: i + 1, text: "Twelve words in this sentence about systems and pipelines for testing now." });
tail.push({ start: 41, end: 42, text: "Short tail." });
const tailChunks = chunkTranscript(tail);
const last = tailChunks[tailChunks.length - 1];
assert(last.wordCount >= 120 || tailChunks.length === 1, "no tiny orphan tail chunk");

// --- 7. Empty / whitespace input ---
assert(chunkTranscript([]).length === 0, "empty input → no chunks");
assert(chunkTranscript([{ start: 0, end: 1, text: "   " }]).length === 0, "whitespace-only → no chunks");

// --- 8. Utilities ---
assert(countWords("ایک دو تین") === 3, "Urdu word counting");
assert(formatTimestamp(75) === "1:15", "mm:ss format");
assert(formatTimestamp(3723) === "1:02:03", "h:mm:ss format");

// --- 9. Single short input → single chunk, no overlap ---
const single = chunkPlainText("Just one short sentence.");
assert(single.length === 1 && !single[0].hasOverlap, "short input → one chunk without overlap");

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
