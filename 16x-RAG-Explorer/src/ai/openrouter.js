// OpenRouter client — streaming chat completions.
// Key is stored locally (Electron userData) and only ever sent to openrouter.ai.

const BASE = 'https://openrouter.ai/api/v1';

export const SUGGESTED_MODELS = [
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini (fast/cheap)' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3' }
];

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://16xbrains.com',
    'X-Title': 'RAG Explorer by 16xBrains'
  };
}

export async function chat(apiKey, model, messages, { json = false, maxTokens = 1024 } = {}) {
  const body = { model, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Streaming: calls onToken(text) as tokens arrive; returns full text.
export async function chatStream(apiKey, model, messages, onToken, { maxTokens = 1600, signal } = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true }),
    signal
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta, full);
        }
      } catch { /* partial line */ }
    }
  }
  return full;
}

export function extractJson(text) {
  // Models sometimes wrap JSON in fences or prose — extract robustly.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  for (let end = candidate.length; end > start; end--) {
    try {
      return JSON.parse(candidate.slice(start, end));
    } catch { /* keep shrinking */ }
  }
  throw new Error('Could not parse JSON from model output');
}
