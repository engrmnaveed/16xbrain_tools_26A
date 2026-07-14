// The swarm orchestrator: Planner → Coder → QA with a rejection/retry loop.
// Emits granular events so the UI can visualize every hop and the trace
// inspector can reconstruct the full run.

import { streamChat } from './openrouter.js';
import {
  PLANNER_SYSTEM,
  CODER_SYSTEM,
  QA_SYSTEM,
  coderUserMessage,
  qaUserMessage,
} from './prompts.js';

export const AGENTS = ['planner', 'coder', 'qa'];

export class Emitter {
  constructor() {
    this.listeners = new Set();
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type, data = {}) {
    const evt = { type, ts: Date.now(), ...data };
    for (const fn of this.listeners) fn(evt);
    return evt;
  }
}

export function parseVerdict(text) {
  const firstLine = (text || '').trim().split('\n')[0].toUpperCase();
  if (firstLine.includes('VERDICT') && firstLine.includes('APPROVE')) return 'APPROVE';
  if (firstLine.includes('VERDICT') && firstLine.includes('REJECT')) return 'REJECT';
  // Fallback: search whole text
  if (/VERDICT:\s*APPROVE/i.test(text)) return 'APPROVE';
  if (/VERDICT:\s*REJECT/i.test(text)) return 'REJECT';
  return 'UNKNOWN';
}

/**
 * Run the swarm on a task.
 * @param {object} cfg
 * @param {string} cfg.task
 * @param {string} cfg.apiKey
 * @param {{planner:string, coder:string, qa:string}} cfg.models
 * @param {number} cfg.maxIterations
 * @param {number} cfg.temperature
 * @param {Emitter} cfg.emitter
 * @param {AbortSignal} cfg.signal
 */
export async function runSwarm({ task, apiKey, models, maxIterations = 3, temperature = 0.4, emitter, signal }) {
  const runId = `run-${Date.now()}`;
  emitter.emit('run:start', { runId, task, models, maxIterations });

  const callAgent = async (agent, messages) => {
    emitter.emit('agent:start', { agent, model: models[agent] });
    const t0 = performance.now();
    const { content, usage } = await streamChat({
      apiKey,
      model: models[agent],
      messages,
      temperature,
      signal,
      onToken: (token) => emitter.emit('agent:token', { agent, token }),
    });
    const ms = Math.round(performance.now() - t0);
    emitter.emit('agent:done', { agent, content, usage, ms, model: models[agent] });
    return content;
  };

  try {
    // 1. User → Planner
    emitter.emit('flow', { from: 'user', to: 'planner', label: 'TASK' });
    const spec = await callAgent('planner', [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: task },
    ]);

    let feedback = null;
    let code = null;

    for (let i = 1; i <= maxIterations; i++) {
      emitter.emit('iteration', { n: i, max: maxIterations });

      // 2. Planner/QA → Coder
      emitter.emit('flow', {
        from: feedback ? 'qa' : 'planner',
        to: 'coder',
        label: feedback ? `REJECTED · RETRY ${i - 1}` : 'SPEC',
      });
      code = await callAgent('coder', [
        { role: 'system', content: CODER_SYSTEM },
        { role: 'user', content: coderUserMessage(spec, feedback, code) },
      ]);

      // 3. Coder → QA
      emitter.emit('flow', { from: 'coder', to: 'qa', label: `CODE v${i}` });
      const review = await callAgent('qa', [
        { role: 'system', content: QA_SYSTEM },
        { role: 'user', content: qaUserMessage(spec, code) },
      ]);

      const verdict = parseVerdict(review);
      emitter.emit('verdict', { verdict, iteration: i, review });

      if (verdict === 'APPROVE') {
        emitter.emit('flow', { from: 'qa', to: 'user', label: 'APPROVED ✓' });
        emitter.emit('run:done', { runId, status: 'approved', iterations: i, spec, code, review });
        return { status: 'approved', spec, code, review, iterations: i };
      }

      feedback = review;

      if (i === maxIterations) {
        emitter.emit('flow', { from: 'qa', to: 'user', label: 'MAX RETRIES ✗' });
        emitter.emit('run:done', { runId, status: 'max_iterations', iterations: i, spec, code, review });
        return { status: 'max_iterations', spec, code, review, iterations: i };
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      emitter.emit('run:done', { runId, status: 'aborted' });
      return { status: 'aborted' };
    }
    emitter.emit('error', { message: err.message });
    emitter.emit('run:done', { runId, status: 'error', error: err.message });
    return { status: 'error', error: err.message };
  }
}
