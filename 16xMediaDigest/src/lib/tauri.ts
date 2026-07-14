/**
 * Thin, typed wrapper around the Tauri commands implemented in
 * `src-tauri/src/audio.rs` and `src-tauri/src/transcribe.rs`.
 *
 * Kept in one place so the pipeline code never touches `@tauri-apps/api`
 * directly — makes the invoke contract easy to audit against the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ExtractResult {
  wavPath: string;
  durationSecs: number;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  segments: TranscribeSegment[];
  detectedLanguage: string;
}

export type WhisperLanguage = "auto" | "ur" | "en";

export function extractAudio(inputPath: string, jobId: string): Promise<ExtractResult> {
  return invoke("extract_audio", { inputPath, jobId });
}

export function transcribeAudio(
  wavPath: string,
  jobId: string,
  modelPath: string,
  language: WhisperLanguage
): Promise<TranscribeResult> {
  return invoke("transcribe_audio", { wavPath, jobId, modelPath, language });
}

export function onExtractProgress(
  jobId: string,
  cb: (percent: number) => void
): Promise<UnlistenFn> {
  return listen<{ jobId: string; percent: number }>("extract://progress", (e) => {
    if (e.payload.jobId === jobId) cb(e.payload.percent);
  });
}

export function onTranscribeProgress(
  jobId: string,
  cb: (percent: number) => void
): Promise<UnlistenFn> {
  return listen<{ jobId: string; percent: number }>("transcribe://progress", (e) => {
    if (e.payload.jobId === jobId) cb(e.payload.percent);
  });
}
