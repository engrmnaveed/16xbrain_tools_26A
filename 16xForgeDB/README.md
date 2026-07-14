# ForgeDB

**Offline relational mock data seeder for SQLite.** Design a schema, press Generate, get a fully-populated SQLite database with hundreds of thousands of rows and *guaranteed-intact* foreign keys — in seconds, fully offline. No LLMs, no cloud APIs, no network. Deterministic: the same schema + seed reproduces a byte-identical dataset on any machine.

Built with Tauri 2, React, and TypeScript. Runs on **macOS** (Intel + Apple Silicon) and **Windows** (x64).

## Features

The generation engine plans table order with a topological sort so parents always exist before children, resolves circular FK dependencies automatically (nullable/deferrable edges are patched in a second pass), and handles self-referencing hierarchies like `employees.manager_id`. Foreign keys are drawn directly from parent key pools, so broken references are impossible by construction — and the app still runs SQLite's `foreign_key_check` audit at the end to prove it.

Data comes from bundled procedural dictionaries (names, emails, phones, addresses, companies, dates) plus user-defined pattern masks (`SKU-####-AA`), weighted enums, and `{slot}` templates. FK distributions are configurable: uniform, zipf hotspots, round-robin (every parent gets children), or one-to-one. Throughput is ~2.7M rows/sec in-engine; a 217k-row schema generates and commits to disk in well under a second.

## Quick start (development)

Prerequisites: [Node.js 18+](https://nodejs.org), [Rust](https://rustup.rs), and Tauri's platform dependencies — on Windows the "Desktop development with C++" workload + WebView2 (preinstalled on Win 10/11); on macOS just Xcode Command Line Tools (`xcode-select --install`).

```sh
npm install
npm run app:dev        # launches the desktop app with hot reload
```

Engine-only checks (no Rust needed):

```sh
npm run typecheck      # strict TS
npm run demo           # 217k-row verification: plan, integrity, determinism, perf
```

## Building installers

### Local build (produces installers for the OS you're on)

```sh
npm install
npm run app:build
```

Output in `src-tauri/target/release/bundle/`:

| Platform | Artifacts |
|----------|-----------|
| macOS    | `ForgeDB.app`, `ForgeDB_x.y.z_aarch64.dmg` (or `_x64.dmg` on Intel) |
| Windows  | `ForgeDB_x.y.z_x64_en-US.msi`, `ForgeDB_x.y.z_x64-setup.exe` (NSIS) |

Cross-arch on an Apple Silicon Mac:

```sh
rustup target add x86_64-apple-darwin
npm run app:build -- --target x86_64-apple-darwin     # Intel build
npm run app:build -- --target universal-apple-darwin  # single universal binary
```

Windows installers must be built on Windows (or via CI below) — Tauri does not cross-compile mac↔windows.

### CI release (both platforms at once)

Push a version tag and GitHub Actions builds macOS (aarch64 + x86_64) and Windows (x64) installers and attaches them to a **draft GitHub Release**:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Review the draft under Releases and publish it to distribute. See `.github/workflows/release.yml`.

### Signing (recommended for distribution)

Unsigned builds work but trigger OS warnings (macOS Gatekeeper, Windows SmartScreen). To sign in CI: on macOS add the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` repo secrets (tauri-action picks them up automatically and notarizes); on Windows use a code-signing certificate via the `windows.certificateThumbprint` option in `tauri.conf.json`. Details: [Tauri distribution docs](https://tauri.app/distribute/).

## Using the app

1. Edit the schema JSON in the left panel (a full example loads on first launch).
2. **Validate & Plan** — shows the generation order and how any FK cycles were resolved.
3. **Generate SQLite…** — pick a save location; watch progress; get per-table stats and the FK audit result.

### Schema format

```jsonc
{
  "seed": "any-string",            // same seed => identical dataset, everywhere
  "tables": [
    {
      "name": "users",
      "rows": 10000,
      "columns": [
        { "name": "id", "kind": "increment", "primaryKey": true },
        { "name": "email", "kind": "email", "unique": true },
        { "name": "team_id", "kind": "fk",
          "ref": { "table": "teams", "column": "id", "distribution": "roundRobin" } }
      ]
    }
  ]
}
```

Column kinds: `increment`, `uuid`, `fk`, `firstName`, `lastName`, `fullName`, `username`, `email`, `phone`, `street`, `city`, `country`, `company`, `word`, `sentence`, `int`, `float`, `bool`, `date`, `datetime`, `enum`, `pattern`, `template`. Common options: `unique`, `nullRatio`, `min`/`max`/`precision`, `from`/`to`, `values`/`weights`, `pattern` (`#`=digit `A`=upper `@`=lower `?`=alnum), `template` (`{firstName}.{lastName}@{domain}`). FK `ref` options: `distribution` (`uniform` | `zipf` | `roundRobin` | `oneToOne`), `skew`, `nullRatio`, `deferrable` (allows cycle-breaking).

## Project layout

```
src/engine/        Generation engine (planner, seeder, PRNG, dictionaries, SQLite writer)
src/               React GUI (App.tsx, styles)
src-tauri/         Rust backend: windowing + high-throughput rusqlite bridge
scripts/           Verification harnesses (demo.ts, sqlite-e2e.mjs)
.github/workflows/ CI (typecheck + engine tests) and Release (mac + windows installers)
```

Engine internals — DAG planning, cycle resolution, key pools, distribution math, SQLite tuning — are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

## License

Proprietary — © 16xBrains. All rights reserved.
