import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  LLMService,
  DEFAULT_SETTINGS,
  type LLMSettings,
  type ProviderKind,
} from "./lib/llm/LLMService";
import type { WhisperLanguage } from "./lib/tauri";
import { runDigest, type Stage, type TranscriptCache } from "./pipeline/runDigest";

const MEDIA_EXTENSIONS = [".mp4", ".mov", ".mp3", ".m4a", ".wav"];

interface AppSettings {
  llm: LLMSettings;
  whisperModelPath: string;
}

const SETTINGS_KEY = "media-digest:settings";

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { whisperModelPath: "", ...JSON.parse(raw) };
  } catch {
    // ignore corrupt storage, fall through to defaults
  }
  return { llm: DEFAULT_SETTINGS, whisperModelPath: "" };
}

function stageLabel(stage: Stage | null): string {
  if (!stage) return "Idle";
  switch (stage.kind) {
    case "extracting":
      return `Extracting audio… ${Math.round(stage.percent)}%`;
    case "transcribing":
      return `Transcribing… ${Math.round(stage.percent)}%`;
    case "digesting":
      return `Processing chunk ${stage.index}/${stage.total}`;
    case "done":
      return "Done";
  }
}

function stagePercent(stage: Stage | null): number {
  if (!stage) return 0;
  switch (stage.kind) {
    case "extracting":
      return stage.percent * 0.25; // 0-25%
    case "transcribing":
      return 25 + stage.percent * 0.45; // 25-70%
    case "digesting":
      return 70 + (stage.index / Math.max(1, stage.total)) * 30; // 70-100%
    case "done":
      return 100;
  }
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [language, setLanguage] = useState<WhisperLanguage>("auto");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [running, setRunning] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const cacheRef = useRef<TranscriptCache>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Real file paths are only available via Tauri's webview drag-drop event
  // (HTML5 DataTransfer in a webview does not expose filesystem paths).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      // Not running inside a Tauri webview (e.g. plain browser preview) —
      // drag-drop is unavailable there; the Browse button still degrades
      // gracefully since @tauri-apps/plugin-dialog also no-ops.
      return;
    }
    webview
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragActive(true);
        } else if (event.payload.type === "drop") {
          setDragActive(false);
          const paths = event.payload.paths;
          const match = paths.find((p) =>
            MEDIA_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
          );
          if (match) {
            setFilePath(match);
            setMarkdown("");
            setError(null);
          } else if (paths.length > 0) {
            setError(`Unsupported file type. Expected one of: ${MEDIA_EXTENSIONS.join(", ")}`);
          }
        } else {
          setDragActive(false);
        }
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {
        // Not running inside a Tauri webview (e.g. plain browser preview) —
        // drag-drop is unavailable; the Browse button still works there
        // once @tauri-apps/plugin-dialog's own Tauri check also fails.
      });
    return () => unlisten?.();
  }, []);

  async function browseFile() {
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "Media", extensions: MEDIA_EXTENSIONS.map((e) => e.slice(1)) }],
      });
      if (typeof selected === "string") {
        setFilePath(selected);
        setMarkdown("");
        setError(null);
      }
    } catch (err) {
      setError(`Could not open file dialog: ${String(err)}`);
    }
  }

  function updateLlm(patch: Partial<LLMSettings>) {
    setSettings((s) => ({ ...s, llm: { ...s.llm, ...patch } }));
  }

  async function start() {
    if (!filePath) return;
    setRunning(true);
    setError(null);
    setMarkdown("");
    setStage(null);

    const controller = new AbortController();
    abortRef.current = controller;
    const llm = new LLMService(settings.llm);
    const providerLabel =
      settings.llm.provider === "ollama"
        ? `${settings.llm.ollama.model} (local)`
        : `${settings.llm.openrouter.model} (cloud)`;

    try {
      const result = await runDigest({
        filePath,
        fileName: fileNameFromPath(filePath),
        whisperModelPath: settings.whisperModelPath,
        language,
        llm,
        providerLabel,
        cache: cacheRef.current,
        onStage: setStage,
        signal: controller.signal,
      });
      setMarkdown(result);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  async function copyToClipboard() {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const percent = stagePercent(stage);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">🎙️</span>
          <div>
            <h1>16x Media Digest</h1>
            <p>Bilingual local transcription &amp; digest</p>
          </div>
        </div>
        <span className="chip">اردو + English · local by default</span>
      </header>

      <main>
        <div className="panel settings-panel">
          <div>
            <h2>Language</h2>
            <div className="segmented" style={{ marginTop: 8 }}>
              {(["auto", "ur", "en"] as WhisperLanguage[]).map((l) => (
                <button
                  key={l}
                  className={language === l ? "active" : ""}
                  onClick={() => setLanguage(l)}
                >
                  {l === "auto" ? "Auto" : l === "ur" ? "اردو" : "English"}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Whisper model path</label>
            <input
              type="text"
              placeholder="~/whisper-models/ggml-small.bin"
              value={settings.whisperModelPath}
              onChange={(e) => setSettings((s) => ({ ...s, whisperModelPath: e.target.value }))}
            />
          </div>

          <div className="card">
            <h3>LLM provider</h3>
            <div className="field">
              <label>Provider</label>
              <select
                value={settings.llm.provider}
                onChange={(e) => updateLlm({ provider: e.target.value as ProviderKind })}
              >
                <option value="ollama">Ollama (local)</option>
                <option value="openrouter">OpenRouter (cloud)</option>
              </select>
            </div>

            {settings.llm.provider === "ollama" ? (
              <>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Base URL</label>
                  <input
                    type="text"
                    value={settings.llm.ollama.baseUrl}
                    onChange={(e) =>
                      updateLlm({ ollama: { ...settings.llm.ollama, baseUrl: e.target.value } })
                    }
                  />
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Model</label>
                  <input
                    type="text"
                    value={settings.llm.ollama.model}
                    onChange={(e) =>
                      updateLlm({ ollama: { ...settings.llm.ollama, model: e.target.value } })
                    }
                  />
                </div>
              </>
            ) : (
              <>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>API key</label>
                  <input
                    type="password"
                    value={settings.llm.openrouter.apiKey}
                    onChange={(e) =>
                      updateLlm({
                        openrouter: { ...settings.llm.openrouter, apiKey: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Model</label>
                  <input
                    type="text"
                    value={settings.llm.openrouter.model}
                    onChange={(e) =>
                      updateLlm({
                        openrouter: { ...settings.llm.openrouter, model: e.target.value },
                      })
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <div className="panel work-panel">
          <div
            className={`dropzone${dragActive ? " active" : ""}`}
            onClick={browseFile}
            style={{ cursor: "pointer" }}
          >
            {filePath ? (
              <>
                <div>Ready to digest</div>
                <div className="filename">{fileNameFromPath(filePath)}</div>
              </>
            ) : (
              <>
                <div>Drop a media file here, or click to browse</div>
                <div className="muted" style={{ marginTop: 4 }}>
                  {MEDIA_EXTENSIONS.join(" · ")}
                </div>
              </>
            )}
          </div>

          <div className="actions">
            <button className="primary" disabled={!filePath || running} onClick={start}>
              {running ? "Running…" : "Run digest"}
            </button>
            {running && (
              <button className="danger" onClick={cancel}>
                Cancel
              </button>
            )}
            {markdown && !running && (
              <button className="secondary" onClick={copyToClipboard}>
                {copied ? "Copied!" : "Copy to Clipboard"}
              </button>
            )}
          </div>

          {(running || stage) && (
            <div>
              <div className="bar">
                <div className="bar-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="stage-label">{stageLabel(stage)}</div>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          <div className="digest-panel">
            <div className="panel-title">
              <h2>Digest</h2>
            </div>
            <textarea
              readOnly
              value={markdown}
              placeholder="Your Markdown digest will appear here."
            />
          </div>
        </div>
      </main>
    </div>
  );
}
