/* ============================================================================
 * 16xGateway — src/core/audit.ts
 * Append-only JSONL audit writer. Lines carry plugin/request ids, statuses,
 * reason codes, token strings and byte counts ONLY — never raw payload values.
 * ==========================================================================*/

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface AuditWriter {
  write(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** Keys that may legitimately appear; anything else is dropped defensively. */
const ALLOWED_KEYS = new Set([
  "type", "requestId", "pluginId", "pluginVersion", "status", "durationMs",
  "tokenCount", "category", "hostname", "reasonCodes", "errorCode", "bytes",
  "message", "ts",
]);

function sanitizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(event)) {
    if (ALLOWED_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export function createAuditWriter(auditFile: string | null, consoleLevel = true): AuditWriter {
  let stream: WriteStream | null = null;
  if (auditFile) {
    try {
      mkdirSync(dirname(auditFile), { recursive: true });
      stream = createWriteStream(auditFile, { flags: "a" });
    } catch {
      stream = null; // fail-soft: never let audit setup crash the gateway
    }
  }

  return {
    write(event: Record<string, unknown>): void {
      const line = JSON.stringify(sanitizeEvent(event));
      if (stream) {
        stream.write(line + "\n");
      } else if (consoleLevel) {
        process.stdout.write(line + "\n");
      }
    },
    async close(): Promise<void> {
      if (!stream) return;
      await new Promise<void>((resolve) => stream!.end(resolve));
      stream = null;
    },
  };
}
