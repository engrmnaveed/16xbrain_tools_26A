/**
 * AI layer — OpenRouter integration, deeply wired into the simulator.
 *
 * Capabilities (all context-aware, all can drive the engine):
 *  - Copilot chat grounded in live topology + event log + metrics
 *  - Executable actions: AI replies may include ```actions JSON blocks that
 *    the app renders as one-click "Run" buttons (kill nodes, scale, scenarios…)
 *  - Incident post-mortems generated from the actual event timeline
 *  - Architecture resilience review with a 0-100 score + fix actions
 *  - Natural-language chaos scenario generation ("simulate Black Friday")
 *  - "Explain" — narrates what just happened for client demos
 *
 * Works through Electron IPC (main process does HTTPS) with a browser-fetch
 * fallback so the renderer also runs standalone.
 */

export const ACTION_SCHEMA = `
You can control the simulator by including ONE fenced code block labeled "actions"
containing a JSON array. Available ops (group = service group name, fuzzy matched):
  {"op":"kill_node","group":"orders"}            — crash one healthy instance
  {"op":"kill_db_primary"}                        — crash the database primary
  {"op":"inject_latency","group":"db","ms":500,"duration":10}
  {"op":"partition","group":"redis-cache","duration":8}   — network partition (seconds)
  {"op":"cpu_spike","group":"catalog","duration":10}
  {"op":"set_traffic","multiplier":3,"duration":20}        — traffic spike
  {"op":"set_rps","rps":30}                                — base request rate
  {"op":"set_replicas","group":"web","count":4}            — scale a group
  {"op":"chaos_monkey","on":true}
  {"op":"wait","seconds":5}                                — pause between steps
Only include an actions block when the user asks you to do/simulate/fix something.
Keep the block minimal and valid JSON.`;

const BASE_SYSTEM = `You are the resident Site Reliability Engineer inside "16x SelfHeal",
a self-healing microservice system visualizer by 16xBrains. You watch a live simulated
topology with load balancing, health checks, circuit breakers, Kubernetes-style
auto-replacement and database failover.

Be concise, concrete and technically sharp. Explain resilience concepts in plain words
when the audience seems non-technical (this tool is also used in client demos).
When referencing services, use their exact group names from the snapshot.
${ACTION_SCHEMA}`;

export class AI {
  constructor(engine) {
    this.engine = engine;
    this.settings = { apiKey: '', model: 'openrouter/auto' };
    this.history = []; // chat turns {role, content}
    this.busy = false;
  }

  async loadSettings() {
    if (window.selfheal) this.settings = await window.selfheal.getSettings();
    else {
      try { this.settings = JSON.parse(localStorage.getItem('selfheal-settings')) || this.settings; } catch {}
    }
    return this.settings;
  }

  async saveSettings(s) {
    this.settings = { ...this.settings, ...s };
    if (window.selfheal) await window.selfheal.setSettings(this.settings);
    else localStorage.setItem('selfheal-settings', JSON.stringify(this.settings));
  }

  get configured() { return !!this.settings.apiKey; }

  async listModels() {
    try {
      const res = window.selfheal
        ? await window.selfheal.aiModels()
        : await (await fetch('https://openrouter.ai/api/v1/models')).json();
      return (res.data || [])
        .map((m) => ({ id: m.id, name: m.name || m.id }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch { return []; }
  }

  /** Raw chat call. messages: [{role, content}] */
  async chat(messages, opts = {}) {
    const payload = {
      messages,
      model: this.settings.model || 'openrouter/auto',
      temperature: opts.temperature ?? 0.4,
      maxTokens: opts.maxTokens ?? 2000,
    };
    let res;
    if (window.selfheal) {
      res = await window.selfheal.aiChat(payload);
    } else {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.settings.apiKey}`,
          'HTTP-Referer': 'https://16xbrains.com/tools/selfheal',
          'X-Title': '16x SelfHeal Visualizer',
        },
        body: JSON.stringify({
          model: payload.model, messages, temperature: payload.temperature, max_tokens: payload.maxTokens,
        }),
      });
      res = await r.json();
      if (!r.ok) throw new Error(res.error?.message || `HTTP ${r.status}`);
    }
    const content = res.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from model');
    return content;
  }

  _context() {
    return `LIVE SYSTEM SNAPSHOT:\n${JSON.stringify(this.engine.snapshot(), null, 1)}\n\nRECENT EVENT LOG:\n${this.engine.recentEventsText(35) || '(no events yet)'}`;
  }

  /** Copilot conversation turn with live context injected. */
  async ask(userText) {
    this.history.push({ role: 'user', content: userText });
    const messages = [
      { role: 'system', content: BASE_SYSTEM },
      { role: 'system', content: this._context() },
      ...this.history.slice(-12),
    ];
    const reply = await this.chat(messages);
    this.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  /** Post-mortem from the actual incident timeline. */
  async postMortem() {
    const inc = this.engine.incidents.slice(-1)[0];
    const prompt = `Write a crisp incident post-mortem for the most recent incident in this simulation${inc ? ` (cause: ${inc.cause}, MTTR ${(inc.mttr / 1000).toFixed(1)}s)` : ''}.
Structure: Summary · Timeline (use the event log timestamps) · Root cause · What the system did automatically (detection, rerouting, breakers, replacement, failover) · Blast radius (failed vs degraded vs fallback requests) · Recommendations.
Keep it under 350 words. No actions block needed.`;
    return this.chat([
      { role: 'system', content: BASE_SYSTEM },
      { role: 'system', content: this._context() },
      { role: 'user', content: prompt },
    ]);
  }

  /** Architecture review with resilience score and fix actions. */
  async architectureReview() {
    const prompt = `Review this topology's resilience like a principal SRE.
1) Give a RESILIENCE SCORE: X/100 on the first line.
2) List single points of failure and under-replicated tiers.
3) Note what's done well.
4) Recommend concrete improvements — and include an "actions" block that applies the top fixes (e.g. set_replicas on weak groups).`;
    return this.chat([
      { role: 'system', content: BASE_SYSTEM },
      { role: 'system', content: this._context() },
      { role: 'user', content: prompt },
    ]);
  }

  /** Natural language → executable chaos scenario. */
  async generateScenario(description) {
    const prompt = `Design a chaos engineering scenario for: "${description}".
Reply with 2-3 sentences describing the scenario narrative and the hypothesis being tested, then EXACTLY ONE "actions" block implementing it as a timed sequence (use "wait" between steps, keep total under 60s, 3-8 actions). Use only group names that exist in the snapshot.`;
    return this.chat([
      { role: 'system', content: BASE_SYSTEM },
      { role: 'system', content: this._context() },
      { role: 'user', content: prompt },
    ], { temperature: 0.7 });
  }

  /** Plain-words narration of the last ~30s — great in client demos. */
  async explain() {
    const prompt = `In plain, non-technical words a client would understand, explain what just happened in the system over the recent events: what broke, how the system noticed, how traffic was protected, and how it healed itself. Use a short story-like tone, max 180 words. No actions block.`;
    return this.chat([
      { role: 'system', content: BASE_SYSTEM },
      { role: 'system', content: this._context() },
      { role: 'user', content: prompt },
    ]);
  }

  clearHistory() { this.history = []; }
}

/** Extract ```actions block → array | null. Exposed for tests. */
export function parseActions(text) {
  const m = text.match(/```(?:actions|json)?\s*\n?(\[[\s\S]*?\])\s*\n?```/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return null;
    return arr.filter((a) => a && typeof a.op === 'string');
  } catch { return null; }
}

/** Strip the actions block for display. */
export function stripActions(text) {
  return text.replace(/```(?:actions|json)?\s*\n?\[[\s\S]*?\]\s*\n?```/, '').trim();
}
