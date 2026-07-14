import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import TopBar from './components/TopBar.jsx';
import FlowCanvas from './components/FlowCanvas.jsx';
import AgentTerminal from './components/AgentTerminal.jsx';
import PromptBar from './components/PromptBar.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import DocsPanel from './components/DocsPanel.jsx';
import TracePanel from './components/TracePanel.jsx';
import { Emitter, runSwarm, AGENTS } from './engine/orchestrator.js';
import { runDemo } from './engine/demo.js';
import { completeChat } from './engine/openrouter.js';
import { REFINER_SYSTEM, EXPLAINER_SYSTEM } from './engine/prompts.js';

const DEFAULT_SETTINGS = {
  apiKey: '',
  models: {
    planner: 'anthropic/claude-sonnet-4',
    coder: 'anthropic/claude-sonnet-4',
    qa: 'openai/gpt-4o',
  },
  assistModel: 'openai/gpt-4o-mini',
  maxIterations: 3,
  temperature: 0.4,
};

const emptyAgent = () => ({ status: 'idle', output: '', model: '', ms: null, tokens: null });

const initialState = {
  agents: { planner: emptyAgent(), coder: emptyAgent(), qa: emptyAgent() },
  flows: [],            // active flow animations
  trace: [],            // full event log
  running: false,
  demo: false,
  iteration: 0,
  maxIterations: 3,
  runStatus: null,      // approved | max_iterations | error | aborted
  error: null,
};

let flowSeq = 0;

function reducer(state, action) {
  switch (action.type) {
    case 'RESET_RUN':
      return {
        ...initialState,
        trace: [],
        running: true,
        demo: !!action.demo,
        maxIterations: action.maxIterations ?? 3,
      };
    case 'EVENT': {
      const e = action.event;
      const next = { ...state, trace: [...state.trace, e] };
      switch (e.type) {
        case 'agent:start':
          next.agents = {
            ...state.agents,
            [e.agent]: { ...emptyAgent(), status: 'streaming', model: e.model },
          };
          break;
        case 'agent:token': {
          const a = state.agents[e.agent];
          next.agents = { ...state.agents, [e.agent]: { ...a, output: a.output + e.token } };
          // token events are high-frequency; don't store each in trace
          next.trace = state.trace;
          break;
        }
        case 'agent:done': {
          const a = state.agents[e.agent];
          next.agents = {
            ...state.agents,
            [e.agent]: {
              ...a,
              status: 'done',
              output: e.content,
              ms: e.ms,
              tokens: e.usage?.completion_tokens ?? null,
            },
          };
          break;
        }
        case 'flow': {
          const flow = { id: ++flowSeq, from: e.from, to: e.to, label: e.label };
          next.flows = [...state.flows.slice(-4), flow];
          break;
        }
        case 'iteration':
          next.iteration = e.n;
          next.maxIterations = e.max;
          break;
        case 'verdict':
          if (e.verdict === 'REJECT') {
            next.agents = { ...next.agents, coder: { ...next.agents.coder, status: 'rejected' } };
          }
          break;
        case 'error':
          next.error = e.message;
          break;
        case 'run:done':
          next.running = false;
          next.runStatus = e.status;
          break;
        default:
          break;
      }
      return next;
    }
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [panel, setPanel] = useState(null); // 'settings' | 'docs' | 'trace' | null
  const [prompt, setPrompt] = useState('');
  const [refining, setRefining] = useState(false);
  const [explanation, setExplanation] = useState(null);
  const [explaining, setExplaining] = useState(false);
  const abortRef = useRef(null);
  const emitterRef = useRef(null);

  // Load persisted settings (Electron IPC when available, localStorage fallback for `vite` browser dev)
  useEffect(() => {
    (async () => {
      try {
        if (window.swarm) {
          const saved = await window.swarm.loadSettings();
          if (saved && Object.keys(saved).length) {
            setSettings((s) => ({ ...s, ...saved, models: { ...s.models, ...(saved.models || {}) } }));
          }
        } else {
          const raw = localStorage.getItem('swarm-settings');
          if (raw) {
            const saved = JSON.parse(raw);
            setSettings((s) => ({ ...s, ...saved, models: { ...s.models, ...(saved.models || {}) } }));
          }
        }
      } catch { /* first launch */ }
    })();
  }, []);

  const saveSettings = useCallback(async (next) => {
    setSettings(next);
    try {
      if (window.swarm) await window.swarm.saveSettings(next);
      else localStorage.setItem('swarm-settings', JSON.stringify(next));
    } catch { /* non-fatal */ }
  }, []);

  const startRun = useCallback(async (demo = false) => {
    if (state.running) return;
    if (!demo && !settings.apiKey) {
      setPanel('settings');
      return;
    }
    if (!demo && !prompt.trim()) return;

    setExplanation(null);
    const emitter = new Emitter();
    emitterRef.current = emitter;
    const controller = new AbortController();
    abortRef.current = controller;
    emitter.on((event) => dispatch({ type: 'EVENT', event }));
    dispatch({ type: 'RESET_RUN', demo, maxIterations: settings.maxIterations });

    if (demo) {
      await runDemo({ task: prompt, emitter, signal: controller.signal });
    } else {
      await runSwarm({
        task: prompt,
        apiKey: settings.apiKey,
        models: settings.models,
        maxIterations: settings.maxIterations,
        temperature: settings.temperature,
        emitter,
        signal: controller.signal,
      });
    }
  }, [state.running, settings, prompt]);

  const stopRun = useCallback(() => abortRef.current?.abort(), []);

  // AI assist: refine the user's prompt before running
  const refinePrompt = useCallback(async () => {
    if (!prompt.trim() || refining) return;
    if (!settings.apiKey) { setPanel('settings'); return; }
    setRefining(true);
    try {
      const improved = await completeChat({
        apiKey: settings.apiKey,
        model: settings.assistModel,
        temperature: 0.3,
        messages: [
          { role: 'system', content: REFINER_SYSTEM },
          { role: 'user', content: prompt },
        ],
      });
      if (improved?.trim()) setPrompt(improved.trim());
    } catch (err) {
      dispatch({ type: 'EVENT', event: { type: 'error', ts: Date.now(), message: `Refiner: ${err.message}` } });
    } finally {
      setRefining(false);
    }
  }, [prompt, refining, settings]);

  // AI assist: explain the run trace (root-cause rejections/failures)
  const explainRun = useCallback(async () => {
    if (explaining || !state.trace.length) return;
    if (!settings.apiKey) { setPanel('settings'); return; }
    setExplaining(true);
    try {
      const compact = state.trace
        .filter((e) => e.type !== 'agent:token')
        .map((e) => {
          const copy = { ...e };
          if (copy.content) copy.content = copy.content.slice(0, 1500);
          if (copy.review) copy.review = copy.review.slice(0, 1500);
          return copy;
        });
      const text = await completeChat({
        apiKey: settings.apiKey,
        model: settings.assistModel,
        temperature: 0.2,
        messages: [
          { role: 'system', content: EXPLAINER_SYSTEM },
          { role: 'user', content: `Run trace:\n${JSON.stringify(compact, null, 1)}` },
        ],
      });
      setExplanation(text);
    } catch (err) {
      setExplanation(`Could not analyze trace: ${err.message}`);
    } finally {
      setExplaining(false);
    }
  }, [explaining, state.trace, settings]);

  const exportTrace = useCallback(async () => {
    const json = JSON.stringify(state.trace, null, 2);
    if (window.swarm) {
      await window.swarm.exportTrace(json);
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `swarm-trace-${Date.now()}.json`;
      a.click();
    }
  }, [state.trace]);

  return (
    <div className="app">
      <TopBar
        running={state.running}
        demo={state.demo}
        iteration={state.iteration}
        maxIterations={state.maxIterations}
        runStatus={state.runStatus}
        onOpen={setPanel}
      />

      <FlowCanvas flows={state.flows} agents={state.agents} running={state.running} />

      <main className="terminals">
        {AGENTS.map((name) => (
          <AgentTerminal key={name} name={name} data={state.agents[name]} />
        ))}
      </main>

      {state.error && (
        <div className="error-bar" onClick={() => dispatch({ type: 'CLEAR_ERROR' })}>
          ⚠ {state.error} <span className="dim">(click to dismiss)</span>
        </div>
      )}

      <PromptBar
        prompt={prompt}
        setPrompt={setPrompt}
        running={state.running}
        refining={refining}
        hasKey={!!settings.apiKey}
        onRun={() => startRun(false)}
        onDemo={() => startRun(true)}
        onStop={stopRun}
        onRefine={refinePrompt}
      />

      {panel === 'settings' && (
        <SettingsPanel settings={settings} onSave={saveSettings} onClose={() => setPanel(null)} />
      )}
      {panel === 'docs' && <DocsPanel onClose={() => setPanel(null)} />}
      {panel === 'trace' && (
        <TracePanel
          trace={state.trace}
          explanation={explanation}
          explaining={explaining}
          hasKey={!!settings.apiKey}
          onExplain={explainRun}
          onExport={exportTrace}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
