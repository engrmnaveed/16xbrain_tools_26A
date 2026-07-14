import { chunkTranscript, formatTimestamp } from "../lib/chunker";
import type { WhisperSegment } from "../lib/chunker";
import type { LLMService } from "../lib/llm/LLMService";
import {
  extractAudio,
  transcribeAudio,
  onExtractProgress,
  onTranscribeProgress,
  type WhisperLanguage,
} from "../lib/tauri";
import { compileMarkdown } from "./compileMarkdown";

export type Stage =
  | { kind: "extracting"; percent: number }
  | { kind: "transcribing"; percent: number }
  | { kind: "digesting"; index: number; total: number }
  | { kind: "done" };

export interface TranscriptCacheEntry {
  segments: WhisperSegment[];
  detectedLanguage: string;
  durationSecs: number;
}

/** Keyed by source file path — lets "rerun cheaply" skip re-transcription. */
export type TranscriptCache = Map<string, TranscriptCacheEntry>;

export interface RunDigestOptions {
  filePath: string;
  fileName: string;
  whisperModelPath: string;
  language: WhisperLanguage;
  llm: LLMService;
  /** e.g. "gemma2:9b (local)" — shown in the digest header */
  providerLabel: string;
  cache: TranscriptCache;
  onStage: (stage: Stage) => void;
  signal?: AbortSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Extract → transcribe (or reuse cache) → chunk → digest each chunk → compile Markdown. */
export async function runDigest(opts: RunDigestOptions): Promise<string> {
  const jobId = crypto.randomUUID();
  let entry = opts.cache.get(opts.filePath);

  if (!entry) {
    opts.onStage({ kind: "extracting", percent: 0 });
    const unlistenExtract = await onExtractProgress(jobId, (percent) =>
      opts.onStage({ kind: "extracting", percent })
    );
    let extracted;
    try {
      extracted = await extractAudio(opts.filePath, jobId);
    } finally {
      unlistenExtract();
    }
    throwIfAborted(opts.signal);

    opts.onStage({ kind: "transcribing", percent: 0 });
    const unlistenTranscribe = await onTranscribeProgress(jobId, (percent) =>
      opts.onStage({ kind: "transcribing", percent })
    );
    let transcribed;
    try {
      transcribed = await transcribeAudio(
        extracted.wavPath,
        jobId,
        opts.whisperModelPath,
        opts.language
      );
    } finally {
      unlistenTranscribe();
    }
    throwIfAborted(opts.signal);

    entry = {
      segments: transcribed.segments,
      detectedLanguage: transcribed.detectedLanguage,
      durationSecs: extracted.durationSecs,
    };
    opts.cache.set(opts.filePath, entry);
  }

  const chunks = chunkTranscript(entry.segments);
  const digests: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(opts.signal);
    opts.onStage({ kind: "digesting", index: i + 1, total: chunks.length });
    const chunk = chunks[i];
    const text = await opts.llm.digestChunk(
      {
        index: i,
        total: chunks.length,
        text: chunk.text,
        startLabel: formatTimestamp(chunk.startTime),
        endLabel: formatTimestamp(chunk.endTime),
      },
      opts.signal
    );
    digests.push(text);
  }

  const markdown = compileMarkdown(
    {
      fileName: opts.fileName,
      detectedLanguage: entry.detectedLanguage || opts.language,
      durationSecs: entry.durationSecs,
      sectionCount: chunks.length,
      providerLabel: opts.providerLabel,
    },
    chunks,
    digests
  );

  opts.onStage({ kind: "done" });
  return markdown;
}
