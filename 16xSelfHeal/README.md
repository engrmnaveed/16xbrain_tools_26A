# 16x SelfHeal — Self-Healing System Visualizer

A cross-platform (macOS + Windows) desktop app by **16xBrains** that makes *high availability* concrete.
It simulates a live microservice topology — load balancer, API gateway, services, caches, databases,
queues — and lets you break it on purpose. Watch traffic reroute, circuit breakers trip, replicas get
promoted, and a Kubernetes-style orchestrator spin up replacements in real time.

**Public showcase:** clients see firsthand why robust architecture is worth paying for.
**Internal utility:** a sandbox for reasoning about replica counts, retry logic, and fallback states before touching production.

![stack](https://img.shields.io/badge/Electron-31-blue) ![ai](https://img.shields.io/badge/AI-OpenRouter-green) ![deps](https://img.shields.io/badge/runtime%20deps-zero-brightgreen)

---

## Quick start (development)

Requirements: **Node.js 18+** and npm.

```bash
npm install       # installs electron + electron-builder (dev-only; zero runtime deps)
npm start         # launches the app
npm test          # runs the headless simulation-engine test suite (27 assertions)
```

## Building installers

```bash
npm run dist:mac    # → release/  .dmg + .zip   (arm64 + x64)  — run on macOS
npm run dist:win    # → release/  NSIS installer + portable .exe (x64)
npm run dist        # both (cross-building Windows from macOS works out of the box)
```

Notes:

- **macOS signing/notarization** — unsigned builds run locally but Gatekeeper warns on download.
  For distribution set `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID cert) and add your
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` for notarization. See electron-builder docs.
- **Windows signing** — optional; set `CSC_LINK` to a code-signing cert to avoid SmartScreen warnings.
- The icon lives at `build/icon.png` (512×512). electron-builder derives `.icns`/`.ico` automatically.
- Build output goes to `release/` (git-ignore it).

## Enabling the AI copilot

1. Get an API key from [openrouter.ai](https://openrouter.ai/keys) (one key → Claude, GPT, Gemini, Llama, 300+ models).
2. In the app: **⚙ Settings → paste key → ↻ fetch models → Save** (or keep `openrouter/auto`).
3. The key is stored locally, encrypted with the OS keychain when available (Electron `safeStorage`),
   and is only ever sent to `openrouter.ai`. Everything except AI features works with no key and no network.

### What the AI actually does (not just chat)

The copilot receives a live snapshot of the topology, per-second metrics, and the real event log on every call:

| Feature | What happens |
|---|---|
| 🏗 **Architecture review** | Scores resilience /100, finds SPOFs, and proposes fixes as **executable actions** (e.g. scale weak groups) — you click ▶ Run to apply them to the simulator |
| 📋 **Post-mortem** | Writes an incident report from the *actual* event timeline: detection, rerouting, breakers, MTTR |
| ✨ **NL → chaos scenario** | "Simulate Black Friday with a payment DB failure" → a timed, executable action sequence |
| 🎙 **Explain** | Plain-words narration of the last incident — built for client demos |
| 💬 **Copilot chat** | Grounded Q&A; any reply may include an actions block you can run with one click |

Nothing the AI proposes executes without an explicit click. The action schema is in `src/js/ai/ai.js`.

## Project layout

```
electron/          main process (window, settings persistence, OpenRouter proxy over IPC)
src/index.html     app shell + built-in user guide (📖 Docs modal)
src/css/app.css    dark ops-console theme
src/js/engine/     pure simulation engine (no DOM — unit-testable in node) + topology presets
src/js/ui/         canvas renderer (particles, pan/zoom) + app wiring
src/js/ai/         OpenRouter client, prompts, executable-action parsing
tests/             headless engine test suite (npm test)
website/           landing page for 16xbrains.com/tools (standalone HTML)
build/icon.png     app icon source
```

## How the simulation works (30 seconds)

Requests spawn at the client and route hop-by-hop with **least-connections** selection among pool
members. When you kill an instance, it *stays in the LB pool until health checks fail twice* — that
brief error window (with automatic retries against siblings) is the point: it shows what detection
latency costs. The orchestrator then boots a replacement (blue) which rejoins the pool. Database
groups run primary/replica with **leader election** on primary loss. Per-edge **circuit breakers**
open at >50% failure rate, go half-open after 4s, and probe before closing. Cache/DB outages produce
**degraded fallback** responses instead of hard failures. Every incident is timed → **MTTR** appears
in metrics.

## Simulator hotkeys

`Space` pause · `K` kill random instance · `M` chaos monkey · `1/2/3` presets · `F` fit view · `?` in-app guide

## Publishing on 16xbrains.com

`website/index.html` is a self-contained landing page (docs included) for the new **Tools** section.
Drop it at `/tools/selfheal/`, adapt header/footer to the site shell, and point the download buttons
at your released artifacts (GitHub Releases or S3).

---

MIT © 16xBrains
