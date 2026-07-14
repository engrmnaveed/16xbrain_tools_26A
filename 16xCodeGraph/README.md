# 16x CodeGraph

Local TypeScript code-graph & targeted refactoring tool. Parse a codebase into an AST-backed SQLite graph, then feed small LLMs (local Ollama or cheap OpenRouter models) **only** the function you're refactoring plus its direct dependency signatures — never whole files.

## Why

Small models (a 9GB Gemma, a $0.0001/1k cloud model) can refactor well *if* the context is tiny and precise. This app does the heavy lifting: `ts-morph` parses your code, `better-sqlite3` stores the graph, and the refactor prompt contains just the target entity + dependency signatures.

## Stack

- **Shell:** Tauri 2 (Rust) + React 18 + Tailwind CSS
- **Engine (Node sidecar):** Express HTTP API on `127.0.0.1:43917`, `ts-morph` AST parsing, `better-sqlite3` graph storage (`~/.codegraph/codegraph.db`)
- **LLM:** unified `LLMService` — Ollama (`/api/generate`, NDJSON stream) or OpenRouter (OpenAI-compatible SSE), with optional cross-provider fallback

## Prerequisites

- Node.js ≥ 20
- Rust toolchain (for Tauri): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- macOS: `xcode-select --install`
- Optional: [Ollama](https://ollama.com) with a model pulled, e.g. `ollama pull gemma2:9b`

## Setup

```bash
npm install
npm run dev        # Node sidecar (tsx watch) + Tauri dev window
# or, browser-only (no Rust needed):
npm run dev:web    # sidecar + Vite on http://localhost:1420
```

## Usage

1. **Scan project** → pick a TypeScript repo. First scan parses everything; re-scans skip unchanged files via content hashes.
2. **Search** for a function/component/class in the left panel.
3. Inspect its code, **Depends on**, and **Used by** lists (click to navigate the graph).
4. **⚙ Settings** → choose Ollama or OpenRouter, then **Test connection**.
5. Type an instruction ("convert to async/await…") → **Refactor** → tokens stream in, then a diff view + copy button.

## Production build

```bash
npm run build:sidecar   # bundles sidecar to sidecar/dist/index.cjs
npm run tauri build     # .app / .dmg
```

Note: the packaged app currently expects the sidecar to be started with it (`node sidecar/dist/index.cjs`). To embed it as a true Tauri sidecar binary, compile it (e.g. `pkg` or Node SEA) to `src-tauri/binaries/codegraph-sidecar-aarch64-apple-darwin` and add it under `bundle.externalBin` in `tauri.conf.json`.

## API (sidecar)

| Route | Purpose |
|---|---|
| `GET /api/health` | liveness + graph stats |
| `POST /api/scan` `{rootPath}` | start incremental scan (202) |
| `GET /api/scan/status` | poll progress |
| `GET /api/search?q=` | find entities by name |
| `GET /api/entity/:id` | entity + dependencies + dependents |
| `GET/PUT /api/settings` | LLM provider config |
| `POST /api/llm/test` | round-trip provider test |
| `POST /api/refactor` `{entityId, instruction}` | SSE stream: `prompt_meta`, `token`…, `done`/`error` |

## Architecture rules honored

- **No massive context dumps** — prompts contain the target entity's code + dependency *signatures* only (`sidecar/src/prompt.ts`).
- **Provider agnostic** — `LLMService.generate(prompt)` routes by settings; errors are typed (`connection`, `auth`, `model`) with actionable messages ("Ollama not running — `ollama serve`", "invalid OpenRouter key").
- **Scan once** — SHA-1 file hashing makes re-scans near-instant; deleted files are pruned from the graph.
