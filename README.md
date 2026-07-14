# 16xBrains Tools Monorepo

This repo bundles the 16xBrains internal tools as npm workspaces so they can all be installed and run from one place.

## Apps

| App | Path | Type |
|---|---|---|
| RAG Explorer | `16x-RAG-Explorer` | Vite + Electron |
| Swarm | `16x-Swarm` | Vite + Electron |
| CodeGraph | `16xCodeGraph` | Vite + Tauri |
| DataFlux | `16xDataFlux` | Vite + Electron |
| ForgeDB | `16xForgeDB` | Vite + Tauri |
| Gateway | `16xGateway` | Node service (own sub-workspaces in `packages/`) |
| MediaDigest | `16xMediaDigest` | Tauri (no npm package yet) |
| SelfHeal | `16xSelfHeal` | Electron |
| SchemaMind | `16xShemaMind/schemamind` | Vite + Electron |

## Setup

```bash
npm install
```

This installs dependencies for every workspace at once (hoisted into the root `node_modules`).

> Note: `16xGateway` depends on `isolated-vm`, which requires a native build via `node-gyp`. If your local Xcode/clang toolchain doesn't support the C++20 features it needs, that one package will fail to build while everything else installs fine. Fix your toolchain (or build `16xGateway` on a machine with a compatible compiler) to use that app.

## Running an app

Each app is reachable from the root via `npm run <app>:<script>`:

```bash
npm run rag-explorer:dev
npm run swarm:dev
npm run codegraph:dev       # Tauri desktop shell
npm run codegraph:dev:web   # browser-only, no Tauri
npm run dataflux:dev
npm run forgedb:dev
npm run forgedb:app:dev     # Tauri desktop shell
npm run gateway:start
npm run selfheal:start
npm run schemamind:dev
```

Build/test scripts follow the same pattern, e.g. `npm run dataflux:test`, `npm run gateway:build`, `npm run schemamind:test`.

You can also target a workspace directly:

```bash
npm run <script> --workspace=<app-path>
```

e.g. `npm run build --workspace=16xCodeGraph`.

## Notes

- `16xMediaDigest` doesn't have a `package.json`/npm scripts yet, so it isn't part of the workspaces list.
- Each app keeps its own `.gitignore`; the root `.gitignore` covers repo-wide excludes (`node_modules/`, build output, Rust/Tauri targets, env files, OS/IDE files).
