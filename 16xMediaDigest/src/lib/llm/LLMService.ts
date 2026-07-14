/**
 * LLMService — single abstraction over Ollama (local) and OpenRouter (cloud).
 *
 * The pipeline never talks to a provider directly; it calls
 * `LLMService.digestChunk()` / `.complete()`. Switching providers is a
 * settings change, not a code change.
 *
 * Notes for Tauri:
 *  - Ollama's default OLLAMA_ORIGINS whitelist includes `tauri://*`, so plain
 *    `fetch` from the webview works with a stock Ollama install.
 *  - OpenRouter serves permissive CORS, so it also works with plain `fetch`.
 */

// ---------- Settings ----------

export type ProviderKind = "ollama" | "openrouter";

export interface LLMSettings {
  provider: ProviderKind;
  ollama: {
    baseUrl: string; // "http://localhost:11434"
    model: string;   // e.g. "gemma2:9b", "qwen2.5:7b" (good Urdu coverage)
    /** context window to request; keep modest for small models */
    numCtx: number;  // e.g. 4096
  };
  openrouter: {
    apiKey: string;
    model: string;   // e.g. "google/gemini-flash-1.5", "meta-llama/llama-3.1-8b-instruct"
  };
  /** shared generation options */
  temperature: number;  // 0.2 — digest work wants low creativity
  maxOutputTokens: number; // budget per chunk summary, e.g. 700
  requestTimeoutMs: number; // 120_000
}

export const DEFAULT_SETTINGS: LLMSettings = {
  provider: "ollama",
  ollama: { baseUrl: "http://localhost:11434", model: "gemma2:9b", numCtx: 4096 },
  openrouter: { apiKey: "", model: "google/gemini-flash-1.5" },
  temperature: 0.2,
  maxOutputTokens: 700,
  requestTimeoutMs: 120_000,
};

// ---------- Provider interface ----------

export interface CompletionRequest {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
}

interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
  /** cheap connectivity probe for the settings screen */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

// ---------- Shared plumbing ----------

class LLMError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

/** Combine caller cancellation with a hard timeout. */
function timeoutSignal(ms: number, upstream?: AbortSignal): AbortSignal {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`LLM request timed out after ${ms}ms`)), ms);
  upstream?.addEventListener("abort", () => ctl.abort(upstream.reason), { once: true });
  ctl.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return ctl.signal;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof LLMError ? err.retryable : true; // network errors retry
      if (!retryable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // 1s, 2s, 4s
    }
  }
  throw lastErr;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new LLMError(`Network error calling ${url}: ${String(err)}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 429 + 5xx are transient; 4xx (bad key, bad model) are not.
    const retryable = res.status === 429 || res.status >= 500;
    throw new LLMError(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`, retryable);
  }
  return res.json();
}

// ---------- Ollama ----------

class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  constructor(private readonly s: LLMSettings) {}

  async complete(req: CompletionRequest): Promise<string> {
    const { baseUrl, model, numCtx } = this.s.ollama;
    const json = await postJson(
      `${baseUrl}/api/generate`,
      {
        model,
        prompt: req.prompt,
        system: req.system ?? "",
        stream: false,
        options: {
          temperature: this.s.temperature,
          num_predict: this.s.maxOutputTokens,
          num_ctx: numCtx,
        },
      },
      {},
      timeoutSignal(this.s.requestTimeoutMs, req.signal)
    );
    if (typeof json.response !== "string") {
      throw new LLMError(`Unexpected Ollama payload: ${JSON.stringify(json).slice(0, 200)}`, false);
    }
    return json.response.trim();
  }

  async healthCheck() {
    try {
      const res = await fetch(`${this.s.ollama.baseUrl}/api/tags`, {
        signal: timeoutSignal(5000),
      });
      if (!res.ok) return { ok: false, detail: `Ollama responded HTTP ${res.status}` };
      const { models = [] } = await res.json();
      const names = models.map((m: any) => m.name as string);
      const have = names.some((n: string) => n.startsWith(this.s.ollama.model.split(":")[0]));
      return have
        ? { ok: true, detail: `Ollama up, ${this.s.ollama.model} available` }
        : { ok: false, detail: `Ollama up, but run: ollama pull ${this.s.ollama.model}` };
    } catch (err) {
      return { ok: false, detail: `Cannot reach Ollama — is it running? (${String(err)})` };
    }
  }
}

// ---------- OpenRouter ----------

class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  private static readonly BASE = "https://openrouter.ai/api/v1";
  constructor(private readonly s: LLMSettings) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.s.openrouter.apiKey}`,
      "HTTP-Referer": "https://16xbrains.com/tools/media-digest",
      "X-Title": "16x Media Digest",
    };
  }

  async complete(req: CompletionRequest): Promise<string> {
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];
    const json = await postJson(
      `${OpenRouterProvider.BASE}/chat/completions`,
      {
        model: this.s.openrouter.model,
        messages,
        temperature: this.s.temperature,
        max_tokens: this.s.maxOutputTokens,
      },
      this.headers(),
      timeoutSignal(this.s.requestTimeoutMs, req.signal)
    );
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LLMError(`Unexpected OpenRouter payload: ${JSON.stringify(json).slice(0, 200)}`, false);
    }
    return content.trim();
  }

  async healthCheck() {
    if (!this.s.openrouter.apiKey) return { ok: false, detail: "OpenRouter API key not set" };
    try {
      const res = await fetch(`${OpenRouterProvider.BASE}/models`, {
        headers: this.headers(),
        signal: timeoutSignal(8000),
      });
      return res.ok
        ? { ok: true, detail: "OpenRouter key valid" }
        : { ok: false, detail: `OpenRouter HTTP ${res.status} — check API key` };
    } catch (err) {
      return { ok: false, detail: `Cannot reach OpenRouter (${String(err)})` };
    }
  }
}

// ---------- Digest prompting ----------

const DIGEST_SYSTEM = `You are a precise bilingual (Urdu/English) technical summarizer.
Rules:
1. If the transcript excerpt is in Urdu (or mixed), translate it to English first. Never output Urdu script.
2. Summarize the key technical points as tight Markdown bullet points.
3. Preserve concrete facts: names, numbers, tools, versions, decisions, action items.
4. Do NOT add information that is not in the excerpt. Do NOT editorialize.
5. Output ONLY the bullet points — no preamble, no headings, no closing remarks.`;

export interface ChunkDigestInput {
  index: number;      // 0-based
  total: number;
  text: string;
  startLabel: string; // "12:40"
  endLabel: string;   // "15:05"
}

function buildDigestPrompt(c: ChunkDigestInput): string {
  return `Transcript excerpt ${c.index + 1} of ${c.total} (media time ${c.startLabel}–${c.endLabel}).
The excerpt may begin mid-topic; summarize only what is present.

<excerpt>
${c.text}
</excerpt>

Translate to English if needed, then summarize the key technical points as Markdown bullets.`;
}

// ---------- Service ----------

export class LLMService {
  private provider: LLMProvider;

  constructor(private settings: LLMSettings = DEFAULT_SETTINGS) {
    this.provider = LLMService.build(settings);
  }

  private static build(s: LLMSettings): LLMProvider {
    return s.provider === "ollama" ? new OllamaProvider(s) : new OpenRouterProvider(s);
  }

  /** Hot-swap provider when the user changes settings. */
  updateSettings(settings: LLMSettings): void {
    this.settings = settings;
    this.provider = LLMService.build(settings);
  }

  get providerName(): string {
    return this.provider.name;
  }

  healthCheck() {
    return this.provider.healthCheck();
  }

  /** Raw completion with retry — building block for any prompt. */
  complete(req: CompletionRequest): Promise<string> {
    return withRetry(() => this.provider.complete(req));
  }

  /** One pipeline step: translate (if Urdu) + summarize one chunk. */
  digestChunk(chunk: ChunkDigestInput, signal?: AbortSignal): Promise<string> {
    return this.complete({
      system: DIGEST_SYSTEM,
      prompt: buildDigestPrompt(chunk),
      signal,
    });
  }
}
