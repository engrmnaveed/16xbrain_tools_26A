import { ReactNode, useEffect, useState } from "react";
import { api } from "../api/client";
import { LLMSettings } from "../types";

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<LLMSettings | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getSettings().then(setS).catch(() => setS(null));
  }, []);

  if (!s)
    return (
      <Backdrop onClose={onClose}>
        <p className="text-sm text-slate-400 p-6">Loading settings…</p>
      </Backdrop>
    );

  const set = <K extends keyof LLMSettings>(k: K, v: LLMSettings[K]) =>
    setS({ ...s, [k]: v });

  const save = async () => {
    setBusy(true);
    try {
      await api.saveSettings(s);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      await api.saveSettings(s);
      setTestResult(await api.testLLM());
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Backdrop onClose={onClose}>
      <div className="p-5 space-y-4">
        <h2 className="text-base font-semibold text-slate-100">LLM Provider</h2>

        <div className="flex gap-2">
          {(["ollama", "openrouter"] as const).map((p) => (
            <button
              key={p}
              onClick={() => set("provider", p)}
              className={`flex-1 px-3 py-2 rounded-md border text-sm capitalize
                ${s.provider === p
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-ink-600 text-slate-400 hover:border-ink-600/50"}`}
            >
              {p === "ollama" ? "Ollama (local)" : "OpenRouter (cloud)"}
            </button>
          ))}
        </div>

        {s.provider === "ollama" ? (
          <div className="space-y-3">
            <Field label="Endpoint" value={s.ollamaEndpoint}
              onChange={(v) => set("ollamaEndpoint", v)} placeholder="http://localhost:11434/api/generate" />
            <Field label="Model" value={s.ollamaModel}
              onChange={(v) => set("ollamaModel", v)} placeholder="gemma2:9b" mono />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="API Key" value={s.openrouterApiKey} type="password"
              onChange={(v) => set("openrouterApiKey", v)} placeholder="sk-or-…" mono />
            <Field label="Model ID" value={s.openrouterModel}
              onChange={(v) => set("openrouterModel", v)} placeholder="google/gemma-2-9b-it" mono />
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={s.fallbackEnabled}
            onChange={(e) => set("fallbackEnabled", e.target.checked)}
            className="accent-cyan-500"
          />
          Fall back to the other provider if this one fails
        </label>

        {testResult && (
          <p className={`text-xs rounded-md px-3 py-2 border ${
            testResult.ok
              ? "text-emerald-300 border-emerald-500/40 bg-emerald-500/10"
              : "text-rose-300 border-rose-500/40 bg-rose-500/10"
          }`}>
            {testResult.message}
          </p>
        )}

        <div className="flex justify-between pt-1">
          <button onClick={test} disabled={busy}
            className="text-sm px-3 py-2 rounded-md border border-ink-600 hover:border-accent-dim disabled:opacity-40">
            {busy ? "Testing…" : "Test connection"}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm px-3 py-2 rounded-md text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button onClick={save} disabled={busy}
              className="text-sm px-4 py-2 rounded-md bg-accent-dim hover:bg-cyan-600 font-medium disabled:opacity-40">
              Save
            </button>
          </div>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-ink-900 border border-ink-700 rounded-xl w-[440px] max-w-[92vw] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, type = "text", mono = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm
                    placeholder:text-slate-600 focus:outline-none focus:border-accent-dim
                    ${mono ? "font-mono" : ""}`}
      />
    </label>
  );
}
