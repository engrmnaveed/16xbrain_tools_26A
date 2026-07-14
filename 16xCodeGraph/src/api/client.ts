import { Entity, EntityDetail, LLMSettings, RefactorEvent, ScanStatus } from "../types";

const BASE = "http://127.0.0.1:43917";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () =>
    json<{ ok: boolean; stats: { files: number; entities: number; dependencies: number } }>(
      "/api/health"
    ),

  startScan: (rootPath: string) =>
    json<{ started: boolean }>("/api/scan", {
      method: "POST",
      body: JSON.stringify({ rootPath }),
    }),

  scanStatus: () => json<ScanStatus>("/api/scan/status"),

  search: (q: string) => json<Entity[]>(`/api/search?q=${encodeURIComponent(q)}`),

  entity: (id: number) => json<EntityDetail>(`/api/entity/${id}`),

  getSettings: () => json<LLMSettings>("/api/settings"),

  saveSettings: (s: LLMSettings) =>
    json<LLMSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),

  testLLM: () => json<{ ok: boolean; message: string }>("/api/llm/test", { method: "POST" }),

  /** POST /api/refactor and yield parsed SSE events. */
  refactor: async function* (
    entityId: number,
    instruction: string,
    signal?: AbortSignal
  ): AsyncGenerator<RefactorEvent> {
    const res = await fetch(`${BASE}/api/refactor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId, instruction }),
      signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Refactor failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(5)) as RefactorEvent;
        } catch {
          /* skip malformed */
        }
      }
    }
  },
};

/** Native folder picker in Tauri; text prompt fallback in plain-browser dev. */
export async function pickDirectory(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "Select a TypeScript project" });
    return typeof dir === "string" ? dir : null;
  } catch {
    return window.prompt("Absolute path of the TypeScript project to scan:");
  }
}
