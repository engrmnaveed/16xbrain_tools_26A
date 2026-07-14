import { formatTimestamp, type TranscriptChunk } from "../lib/chunker";

export interface DigestMetadata {
  fileName: string;
  detectedLanguage: string;
  durationSecs: number;
  sectionCount: number;
  providerLabel: string; // e.g. "gemma2:9b (local)"
}

/** Stitch per-chunk digest text into one timestamped Markdown document. */
export function compileMarkdown(
  meta: DigestMetadata,
  chunks: TranscriptChunk[],
  digests: string[]
): string {
  const minutes = Math.round(meta.durationSecs / 60);
  const header = [
    `# Digest: ${meta.fileName}`,
    `*Detected language: ${meta.detectedLanguage} · ${minutes} min · ${meta.sectionCount} sections · ${meta.providerLabel}*`,
    "",
  ].join("\n");

  const sections = chunks.map((chunk, i) => {
    const range = `[${formatTimestamp(chunk.startTime)}–${formatTimestamp(chunk.endTime)}]`;
    const body = (digests[i] ?? "").trim();
    return `## ${range}\n${body}`;
  });

  return [header, ...sections].join("\n\n").trim() + "\n";
}
