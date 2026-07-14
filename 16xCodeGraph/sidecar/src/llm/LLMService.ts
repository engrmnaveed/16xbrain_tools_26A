import { LLMProvider, LLMSettings } from "../types";

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: LLMProvider,
    public readonly kind: "connection" | "auth" | "model" | "http" | "abort" | "unknown"
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export interface GenerateOptions {
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  temperature?: number;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Unified LLM client. `generate(prompt)` routes to Ollama's native REST API
 * or OpenRouter's OpenAI-compatible API based on settings, streams tokens,
 * and optionally falls back to the other provider on failure.
 */
export class LLMService {
  constructor(private settings: LLMSettings) {}

  async generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
    const primary = this.settings.provider;
    try {
      return await this.generateWith(primary, prompt, opts);
    } catch (err) {
      const canFallback =
        this.settings.fallbackEnabled &&
        !(err instanceof LLMError && err.kind === "abort") &&
        this.isConfigured(other(primary));
      if (!canFallback) throw err;
      opts.onToken?.(`\n[16x CodeGraph] ${primary} failed (${(err as Error).message}); falling back to ${other(primary)}…\n`);
      return await this.generateWith(other(primary), prompt, opts);
    }
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      const text = await this.generateWith(this.settings.provider, "Reply with exactly: ok", {
        temperature: 0,
      });
      return { ok: true, message: `Connected. Model replied: ${text.trim().slice(0, 80)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------------

  private isConfigured(provider: LLMProvider): boolean {
    if (provider === "ollama")
      return Boolean(this.settings.ollamaEndpoint && this.settings.ollamaModel);
    return Boolean(this.settings.openrouterApiKey && this.settings.openrouterModel);
  }

  private generateWith(
    provider: LLMProvider,
    prompt: string,
    opts: GenerateOptions
  ): Promise<string> {
    return provider === "ollama"
      ? this.generateOllama(prompt, opts)
      : this.generateOpenRouter(prompt, opts);
  }

  // ---- Ollama (native /api/generate, NDJSON stream) -----------------------

  private async generateOllama(prompt: string, opts: GenerateOptions): Promise<string> {
    const { ollamaEndpoint, ollamaModel } = this.settings;
    let res: Response;
    try {
      res = await fetch(ollamaEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          prompt,
          stream: true,
          options: { temperature: opts.temperature ?? 0.2 },
        }),
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError")
        throw new LLMError("Generation cancelled.", "ollama", "abort");
      throw new LLMError(
        `Cannot reach Ollama at ${ollamaEndpoint}. Is Ollama running? Start it with \`ollama serve\`, or check the endpoint in Settings.`,
        "ollama",
        "connection"
      );
    }

    if (res.status === 404) {
      const body = await safeText(res);
      if (/model/i.test(body))
        throw new LLMError(
          `Ollama does not have model "${ollamaModel}". Pull it first: \`ollama pull ${ollamaModel}\`.`,
          "ollama",
          "model"
        );
      throw new LLMError(
        `Ollama endpoint returned 404 — check that the endpoint ends with /api/generate.`,
        "ollama",
        "http"
      );
    }
    if (!res.ok)
      throw new LLMError(`Ollama error ${res.status}: ${await safeText(res)}`, "ollama", "http");
    if (!res.body) throw new LLMError("Ollama returned an empty body.", "ollama", "unknown");

    // NDJSON: one JSON object per line: { response: "...", done: false }
    let full = "";
    for await (const line of iterateLines(res.body, opts.signal)) {
      if (!line.trim()) continue;
      let obj: { response?: string; done?: boolean; error?: string };
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new LLMError(`Ollama: ${obj.error}`, "ollama", "unknown");
      if (obj.response) {
        full += obj.response;
        opts.onToken?.(obj.response);
      }
      if (obj.done) break;
    }
    return full;
  }

  // ---- OpenRouter (OpenAI-compatible /chat/completions, SSE stream) -------

  private async generateOpenRouter(prompt: string, opts: GenerateOptions): Promise<string> {
    const { openrouterApiKey, openrouterModel } = this.settings;
    if (!openrouterApiKey)
      throw new LLMError("No OpenRouter API key configured. Add one in Settings.", "openrouter", "auth");

    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openrouterApiKey}`,
          "HTTP-Referer": "https://16xbrains.com/tools/codegraph",
          "X-Title": "16x CodeGraph",
        },
        body: JSON.stringify({
          model: openrouterModel,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          temperature: opts.temperature ?? 0.2,
        }),
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError")
        throw new LLMError("Generation cancelled.", "openrouter", "abort");
      throw new LLMError(
        "Cannot reach OpenRouter — check your internet connection.",
        "openrouter",
        "connection"
      );
    }

    if (res.status === 401)
      throw new LLMError("OpenRouter rejected the API key (401). Check it in Settings.", "openrouter", "auth");
    if (res.status === 402)
      throw new LLMError("OpenRouter: insufficient credits (402).", "openrouter", "auth");
    if (res.status === 404)
      throw new LLMError(
        `OpenRouter: model "${openrouterModel}" not found. Check the model ID.`,
        "openrouter",
        "model"
      );
    if (!res.ok)
      throw new LLMError(
        `OpenRouter error ${res.status}: ${await safeText(res)}`,
        "openrouter",
        "http"
      );
    if (!res.body) throw new LLMError("OpenRouter returned an empty body.", "openrouter", "unknown");

    // SSE: lines of `data: {json}` terminated by `data: [DONE]`
    let full = "";
    for await (const line of iterateLines(res.body, opts.signal)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;
      try {
        const obj = JSON.parse(payload);
        const token: string | undefined = obj.choices?.[0]?.delta?.content;
        if (token) {
          full += token;
          opts.onToken?.(token);
        }
      } catch {
        /* keep-alive comments etc. */
      }
    }
    return full;
  }
}

function other(p: LLMProvider): LLMProvider {
  return p === "ollama" ? "openrouter" : "ollama";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/** Decode a web ReadableStream into complete text lines. */
async function* iterateLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new LLMError("Generation cancelled.", "ollama", "abort");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
