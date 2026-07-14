# 16x-Swarm — Multi-Agent Collaboration Matrix

A cross-platform desktop app (macOS + Windows) that visualizes autonomous AI agents collaborating on a coding task. Give it a prompt like *"Write a Python script to scrape a site and write unit tests"* and watch three agents — **Planner**, **Coder**, and **QA** — negotiate over a live message bus: the Planner writes a spec, the Coder implements it, and the QA rejects it with concrete errors until the code passes.

Built by [16xBrains](https://16xbrains.com) · Product page: `site/16x-swarm.html`

![stack](https://img.shields.io/badge/Electron-33-47848F) ![stack](https://img.shields.io/badge/React-18-61DAFB) ![stack](https://img.shields.io/badge/Vite-6-646CFF)

---

## Features

- **Three-terminal agent matrix** — live token streaming per agent, status LEDs, per-agent timing and token counts.
- **Animated message bus** — data packets literally flow USER → PLANNER → CODER → QA (and back on rejection) across an SVG bus.
- **Adversarial retry loop** — QA must open with `VERDICT: APPROVE/REJECT`; rejections feed numbered issues back to the Coder for up to N iterations.
- **OpenRouter integration** — any model ID per agent (mix vendors to avoid self-grading bias). Key is validated in-app and encrypted at rest via the OS keychain (`safeStorage`).
- **Demo mode** — a fully scripted run (spec → buggy code → rejection → fix → approval) with zero API cost. Perfect for showcasing.
- **Deep AI assistance** (not a chat bolt-on):
  - **✦ Refine with AI** — rewrites vague prompts into specific, testable tasks before dispatch.
  - **✦ Explain run** — AI reads the full inter-agent trace and root-causes rejections/failures.
- **Trace Inspector** — every dispatch, hand-off, verdict, and timing logged; click for raw JSON; export the trace for offline debugging of multi-agent architectures.
- **Built-in docs** — 5-tab documentation inside the app (Docs button).

## Requirements

- Node.js ≥ 18 and npm
- An [OpenRouter API key](https://openrouter.ai/keys) for real runs (Demo mode needs nothing)

## Run it

```bash
npm install

# Development (Vite dev server + Electron with hot reload)
npm run dev

# Production preview (build renderer, run packaged-style Electron)
npm start
```

## Build installers

```bash
npm run dist:mac   # .dmg + .zip (arm64 + x64) → release/
npm run dist:win   # NSIS installer + portable .exe (x64) → release/
npm run dist       # current platform
```

Notes:
- Build Windows installers on Windows and macOS installers on macOS (or use CI, e.g. a GitHub Actions matrix with `electron-builder`).
- macOS distribution outside your team requires codesigning + notarization: set `CSC_LINK`/`CSC_KEY_PASSWORD` and `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` env vars — electron-builder handles the rest.
- Unsigned Windows builds will show SmartScreen warnings; an OV/EV cert removes them.

## Using the app

1. **▶ Demo** — instant scripted showcase, no key needed.
2. **Settings** — paste your OpenRouter key (Test button validates it), pick per-agent models, set max iterations (1–8) and temperature.
3. Type a task → **⚡ Run Swarm** (⌘/Ctrl+Enter). Optionally hit **✦ Refine with AI** first.
4. **Trace** — inspect every event, **✦ Explain run** for AI root-cause analysis, **Export JSON** for offline analysis.

Full usage docs live inside the app under **Docs**.

## Architecture

```
electron/
  main.cjs        # window, IPC, safeStorage-encrypted settings, trace export
  preload.cjs     # contextBridge API (no nodeIntegration, sandboxed)
src/
  engine/
    orchestrator.js  # Planner→Coder→QA state machine, event emitter, retry loop
    openrouter.js    # SSE streaming client, key validation
    prompts.js       # agent system prompts + message builders
    demo.js          # scripted run emitting identical events
  components/        # TopBar, FlowCanvas, AgentTerminal, PromptBar,
                     # SettingsPanel, TracePanel, DocsPanel
  App.jsx            # reducer-driven state, event → UI binding
site/
  16x-swarm.html     # landing page for 16xbrains.com/tools/
```

**Event schema** (also the exported trace format): `run:start`, `agent:start`, `agent:token`, `agent:done`, `flow {from,to,label}`, `iteration`, `verdict`, `error`, `run:done`. The demo and real runs emit identical streams, so the UI and trace tooling are engine-agnostic — reuse the schema as a reference harness for tracing your own multi-agent microservices.

## Security

- Renderer is sandboxed: `contextIsolation: true`, `nodeIntegration: false`, strict CSP (`connect-src` limited to openrouter.ai).
- API key encrypted at rest with `safeStorage` (Keychain / DPAPI); requests go from your machine straight to OpenRouter — no intermediary backend.

## Engine tests

The orchestrator was verified headlessly (mocked SSE): verdict parsing, the reject→retry loop, error propagation, aborts, and demo mode. To re-run the same style of check, stub `globalThis.fetch` with an SSE `ReadableStream` and call `runSwarm` from Node ≥ 18.

## License

MIT © 16xBrains
