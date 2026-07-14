# 16x Media Digest

Bilingual (Urdu/English) local media digest pipeline. A Mac desktop utility (Tauri 2 + React/TypeScript) that ingests audio/video, transcribes it locally with whisper.cpp, and turns it into a structured English Markdown digest using a small local LLM (Ollama) or a cheap cloud model (OpenRouter).

## Pipeline

```
 ┌──────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐   ┌────────────┐   ┌───────────┐
 │ Drop file│ → │ FFmpeg       │ → │ whisper.cpp  │ → │ Smart     │ → │ LLM digest │ → │ Markdown  │
 │ (mp4/mp3)│   │ 16kHz mono   │   │ transcribe   │   │ Chunker   │   │ per chunk  │   │ compiler  │
 │          │   │ WAV (Rust)   │   │ + timestamps │   │ (TS, pure)│   │ (sequential)│  │ + copy    │
 └──────────┘   └──────────────┘   └──────────────┘   └───────────┘   └────────────┘   └───────────┘
                  extract://          transcribe://                     digest://
                  progress events     progress events                   progress events
```

## Why the app orchestrates, not the LLM

Small models (4k–8k context) fail on long transcripts and multi-step instructions. So the app owns all control flow deterministically, and the LLM only ever sees one bite-sized task: "translate this excerpt if Urdu, summarize its technical points."

**Context budget per chunk request (4k window):**

| Item | Tokens (approx) |
|---|---|
| System prompt | ~120 |
| Chunk (500 words, EN) | ~650–900 |
| Chunk (500 words, UR) | ~900–1300 (Urdu tokenizes worse) |
| Output budget (`max_tokens`) | 700 |
| **Total worst case** | **~2.2k — comfortable headroom** |

## Architecture split (Tauri)

| Layer | Where | Why |
|---|---|---|
| FFmpeg extraction | Rust (`src-tauri/src/audio.rs`) | child process + async stdout parsing; UI never blocks |
| whisper.cpp | Rust (spawn `whisper-cli`) | same pattern as ffmpeg; progress via stderr `progress = NN%` lines (`--print-progress`) |
| Smart chunker | TS (`src/lib/chunker.ts`) | pure function, unit-testable, no I/O |
| LLMService | TS (`src/lib/llm/LLMService.ts`) | `fetch` from webview: Ollama whitelists `tauri://*` origins by default; OpenRouter has open CORS |
| Pipeline loop + UI | React | sequential async loop with AbortController; progress state drives the bar |

Non-blocking guarantee: heavy work is child processes managed by Rust (`tokio::process`), streamed to the UI as Tauri events (`extract://progress`, `transcribe://progress`). LLM calls are network-bound `fetch`es — inherently async in the webview. Nothing CPU-heavy runs on the UI thread.

## Key files

```
src/lib/chunker.ts            Smart Chunking Algorithm (deterministic, Urdu/English)
src/lib/llm/LLMService.ts     Provider abstraction: Ollama + OpenRouter, retry, timeout, digest prompt
src/lib/tauri.ts              Typed wrapper around the extract/transcribe Tauri commands + events
src/pipeline/runDigest.ts     Orchestrates extract → transcribe (cached) → chunk → digest → compile
src/pipeline/compileMarkdown.ts   Stitches per-chunk digests into the final timestamped Markdown
src/App.tsx                   Drop zone, language toggle, provider settings, progress bar, digest viewer
src-tauri/src/audio.rs        FFmpeg 16kHz WAV extraction with progress events
src-tauri/src/transcribe.rs   whisper-cli transcription, JSON parsing, progress events
site/media-digest.html        Tools page for 16xbrains.com with built-in docs
```

## Smart Chunking Algorithm

Contract: deterministic pure function `chunkTranscript(segments, options) → TranscriptChunk[]`.

1. **Sentence assembly.** Whisper segments are time-sliced, not sentence-sliced. Segments are split on sentence terminators — English `. ! ?` and Urdu `۔ ؟` — and fragments without a terminator are merged forward into the next segment, so chunk boundaries never fall mid-sentence. Timestamps are interpolated per sentence by character offset.
2. **Greedy packing.** Whole sentences accumulate into a chunk until adding the next one would exceed `maxWords` (default 500). Word counting is whitespace tokenization, which is valid for Urdu (space-delimited script).
3. **Escape hatches.** A pathological run-on sentence longer than `hardMaxWords` (650) is force-split on word boundaries. A tiny trailing chunk (< `minTailWords`, 120) merges into the previous chunk rather than wasting an LLM round-trip.
4. **Overlap.** Chunk N+1 repeats the last `overlapSentences` (default 1) of chunk N so the model keeps thread across boundaries. Overlap text is included in the prompt but the chunk's timestamp range covers only its own sentences.

Determinism: single forward pass, no randomness, no I/O — same transcript in, same chunks out, every time.

## LLMService

One interface (`complete`, `digestChunk`, `healthCheck`), two providers behind it:

- **Ollama** — `POST {baseUrl}/api/generate` with `stream:false`, `num_ctx`, `num_predict`. Health check hits `/api/tags` and verifies the model is pulled.
- **OpenRouter** — `POST /api/v1/chat/completions` with Bearer key. Health check hits `/models` to validate the key.

Shared plumbing: 3-attempt exponential backoff (retries network errors, 429, 5xx; not 4xx), per-request hard timeout via AbortController (also chains user cancellation), and strict payload validation. The digest prompt pins the model to: translate Urdu → English, bullet-point technical facts only, no invention, no preamble.

Provider switching is `service.updateSettings(newSettings)` — the pipeline code never changes.

## FFmpeg extraction (audio.rs)

`invoke("extract_audio", { inputPath, jobId })`:

1. `ffprobe` reads duration (needed to compute percent).
2. Spawns `ffmpeg -i in -vn -ac 1 -ar 16000 -c:a pcm_s16le -progress pipe:1 -y out.wav` — the exact input format whisper.cpp requires.
3. Parses `out_time_us=` lines from stdout, emits `extract://progress` `{ jobId, percent }` events.
4. Output lands in the app cache dir; returns `{ wavPath, durationSecs }`.

Binary resolution prefers a bundled sidecar (`src-tauri/binaries/ffmpeg-<triple>`) and falls back to PATH (`brew install ffmpeg`).

## whisper.cpp transcription (transcribe.rs)

`invoke("transcribe_audio", { wavPath, jobId, modelPath, language })`:

1. Spawns `whisper-cli -m <modelPath> -f <wavPath> -l <auto|ur|en> -oj -of <cache>/<jobId> --print-progress -nt`.
2. Parses `progress = NN%` lines from stderr, emits `transcribe://progress` `{ jobId, percent }` events.
3. Reads the `-oj` JSON sidecar (`<jobId>.json`) and maps `transcription[].offsets` (ms) + `text` into `WhisperSegment[]`.
4. Returns `{ segments, detectedLanguage }`.

## Pipeline orchestration (runDigest.ts)

`runDigest()` ties the whole thing together for the React UI:

1. If the source file path isn't already in the in-memory transcript cache: `extract_audio` → `transcribe_audio`, cache the result. This is what makes "rerun cheaply" (switch provider/model without re-transcribing) work.
2. `chunkTranscript()` on the cached segments.
3. Sequential `llm.digestChunk()` per chunk, reporting `{ kind: "digesting", index, total }` — this drives the `Processing chunk i/N` status line.
4. `compileMarkdown()` stitches the per-chunk digests under `## [start–end]` headings with a title/metadata header.

The React UI (`src/App.tsx`) wires this to a drop zone (native Tauri drag-drop, real filesystem paths — not the browser File API), a language toggle, provider settings persisted to `localStorage`, a progress bar, and a copy-to-clipboard digest viewer.

## Setup (dev)

```bash
brew install ffmpeg
brew install whisper-cpp                 # provides whisper-cli
# model with good Urdu: small or medium multilingual
curl -L -o ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
ollama pull gemma2:9b                    # or qwen2.5:7b for stronger Urdu

npm install
npm run app:dev     # tauri dev — requires Rust (rustc/cargo) and the Tauri system deps
```

Frontend-only checks (no Rust toolchain required):

```bash
npm run typecheck   # tsc --noEmit
npm run test        # chunker unit tests (tsx src/lib/chunker.test.ts)
npm run build        # tsc --noEmit && vite build
```

## Status

- **Frontend (TS/React):** builds, type-checks, and the chunker's 21 unit tests pass. The UI was smoke-tested standalone in a browser (`vite build && vite preview`) — outside a real Tauri shell, `invoke()` calls to the Rust commands will reject, which the UI surfaces as an error rather than crashing.
- **Rust/Tauri backend:** written to compile against Tauri 2 conventions (mirrors this monorepo's `16xForgeDB` app, which uses the same stack), but **not compiled** — this environment has no `rustc`/`cargo` installed, so `cargo check` / `npm run app:dev` / `npm run app:build` are unverified. Run `npm run app:dev` on a machine with the Rust toolchain and Tauri's system dependencies installed to confirm the desktop shell builds and to exercise the real ffmpeg → whisper.cpp → LLM pipeline end-to-end.
- API key storage currently uses `localStorage`, not the macOS Keychain the tools page describes — a real Keychain integration (e.g. `tauri-plugin-stronghold` or the `keyring` crate) is a follow-up.
