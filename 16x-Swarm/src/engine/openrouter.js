// OpenRouter streaming client (SSE over fetch).
// Works in Electron's renderer; OpenRouter supports browser-side CORS.

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Stream a chat completion from OpenRouter.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {(token:string)=>void} [opts.onToken]
 * @returns {Promise<{content:string, usage:object|null, model:string}>}
 */
export async function streamChat({ apiKey, model, messages, temperature = 0.4, signal, onToken }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://16xbrains.com/tools/16x-swarm',
      'X-Title': '16x-Swarm',
    },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || JSON.stringify(err);
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`OpenRouter ${res.status}: ${detail || res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onToken?.(delta);
        }
        if (json.usage) usage = json.usage;
      } catch {
        /* partial JSON across chunks is retained in buffer */
      }
    }
  }

  return { content, usage, model };
}

/** Quick non-streamed call, used by AI-assist helpers (prompt refiner, failure explainer). */
export async function completeChat({ apiKey, model, messages, temperature = 0.4, signal }) {
  const { content } = await streamChat({ apiKey, model, messages, temperature, signal });
  return content;
}

/** Validate an API key with a cheap models request. */
export async function checkKey(apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.ok;
}
