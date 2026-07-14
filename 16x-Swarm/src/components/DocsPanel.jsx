import React, { useState } from 'react';

const TABS = ['Quick start', 'How it works', 'AI features', 'Debugging', 'FAQ'];

const openExternal = (url) => (window.swarm ? window.swarm.openExternal(url) : window.open(url, '_blank'));

export default function DocsPanel({ onClose }) {
  const [tab, setTab] = useState(0);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Documentation</h2>
          <button className="btn tiny" onClick={onClose}>✕</button>
        </header>

        <div className="doc-tabs">
          {TABS.map((t, i) => (
            <button key={t} className={`doc-tab ${tab === i ? 'active' : ''}`} onClick={() => setTab(i)}>{t}</button>
          ))}
        </div>

        <div className="modal-body docs">
          {tab === 0 && (
            <>
              <h3>1 · Try the Demo (no key needed)</h3>
              <p>Hit <b>▶ Demo</b>. A scripted run plays out the full loop: the Planner writes a spec, the Coder ships buggy code, QA <b>rejects</b> it with concrete errors, and the Coder fixes it until QA approves. This is exactly what a real run looks like.</p>
              <h3>2 · Connect OpenRouter</h3>
              <p>Open <b>Settings</b>, paste your API key from{' '}
                <a onClick={() => openExternal('https://openrouter.ai/keys')}>openrouter.ai/keys</a>, and hit <b>Test</b>. The key is encrypted at rest with your OS keychain — it never leaves your machine except to call OpenRouter directly.</p>
              <h3>3 · Run a real task</h3>
              <p>Type a coding task and press <b>⚡ Run Swarm</b> (or ⌘/Ctrl+Enter). Watch data flow across the message bus as the three agents negotiate. Copy the final code from the Coder terminal.</p>
            </>
          )}

          {tab === 1 && (
            <>
              <h3>The pipeline</h3>
              <p><b>USER → PLANNER:</b> your task becomes a strict spec with numbered, testable acceptance criteria.</p>
              <p><b>PLANNER → CODER:</b> the Coder implements every deliverable — complete files, no placeholders.</p>
              <p><b>CODER → QA:</b> the QA agent reviews against the spec and must open with <code>VERDICT: APPROVE</code> or <code>VERDICT: REJECT</code>.</p>
              <p><b>QA → CODER (the loop):</b> on rejection, the QA's numbered issues are fed back to the Coder, which must fix all of them. This repeats up to <b>Max iterations</b> — the adversarial loop is what raises output quality above a single-model answer.</p>
              <h3>Why three models?</h3>
              <p>Each agent can run a different model. A strong coder paired with a different vendor's QA avoids "self-grading" bias — models are more critical of code they didn't write.</p>
            </>
          )}

          {tab === 2 && (
            <>
              <h3>✦ Refine with AI</h3>
              <p>Before a run, the assist model rewrites your vague prompt into a specific, testable task. Better input → tighter spec → fewer QA rejections → cheaper runs.</p>
              <h3>✦ Explain run (Trace Inspector)</h3>
              <p>After any run, open <b>Trace</b> and hit <b>Explain run</b>. The assist model reads the full inter-agent message log and root-causes what happened: why QA rejected, where the loop stalled, and how to improve your prompt or agent configuration.</p>
              <h3>Per-agent model routing</h3>
              <p>Every OpenRouter model ID works in Settings. Suggested patterns: <code>claude-sonnet</code> as Coder + <code>gpt-4o</code> as QA for adversarial review; <code>deepseek-chat</code> everywhere for budget runs; a small model as Planner since specs are short.</p>
            </>
          )}

          {tab === 3 && (
            <>
              <h3>Trace Inspector as a debugging tool</h3>
              <p>Every event — dispatches, hand-offs, verdicts, timings, token counts — is logged. Click a row for the raw JSON payload. <b>Export JSON</b> saves the full trace for offline analysis or attaching to a bug report.</p>
              <h3>Reading failure modes</h3>
              <p><b>Repeated REJECT on the same issue:</b> the Coder model can't satisfy the criterion — upgrade the Coder or simplify the spec.</p>
              <p><b>VERDICT: UNKNOWN:</b> the QA model ignored the output format — switch to a more instruction-following model.</p>
              <p><b>MAX RETRIES HIT:</b> raise Max iterations, or use ✦ Explain run to find the sticking point.</p>
              <h3>Internal use: microservice tracing</h3>
              <p>The exported trace schema (<code>run:start</code>, <code>agent:start/done</code>, <code>flow</code>, <code>verdict</code>, <code>run:done</code>) mirrors multi-agent microservice hops — use it as a reference harness for tracing logic loops and communication failures in your own agent architectures.</p>
            </>
          )}

          {tab === 4 && (
            <>
              <h3>What does a run cost?</h3>
              <p>Depends on models. A three-agent run with two iterations is typically 5–15k tokens total. Use cheap models (gpt-4o-mini, deepseek) to experiment for pennies.</p>
              <h3>Is my code/data sent anywhere?</h3>
              <p>Only to OpenRouter (which routes to your chosen model vendors). There's no 16xbrains backend — the app talks to OpenRouter directly from your machine.</p>
              <h3>Can it write non-Python code?</h3>
              <p>Yes — any language. State it in the prompt ("in Rust", "as a React component") or let ✦ Refine pin it down.</p>
              <h3>Why did my run stop with an error?</h3>
              <p>Usually a bad key, an invalid model ID, or rate limits. The exact OpenRouter error appears in the red bar and the trace.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
