import { useRef, useState } from "react";
import { api } from "../api/client";
import { EntityDetail } from "../types";
import DiffView from "./DiffView";

/** Pull the last ```…``` code block out of an LLM response. */
function extractCode(text: string): string | null {
  const matches = [...text.matchAll(/```(?:typescript|tsx?|javascript)?\n([\s\S]*?)```/g)];
  return matches.length ? matches[matches.length - 1][1].trimEnd() : null;
}

export default function RefactorPanel({ detail }: { detail: EntityDetail }) {
  const [instruction, setInstruction] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const outRef = useRef<HTMLPreElement>(null);

  const run = async () => {
    if (!instruction.trim() || streaming) return;
    setStreaming(true);
    setOutput("");
    setError(null);
    setDone(false);
    setMeta(null);
    abortRef.current = new AbortController();
    try {
      for await (const ev of api.refactor(detail.entity.id, instruction, abortRef.current.signal)) {
        if (ev.type === "prompt_meta")
          setMeta(`prompt: ${(ev.chars / 1000).toFixed(1)}k chars · ${ev.deps} deps included`);
        else if (ev.type === "token") {
          setOutput((o) => o + ev.token);
          outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
        } else if (ev.type === "error") setError(ev.message);
        else if (ev.type === "done") setDone(true);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
    }
  };

  const stop = () => abortRef.current?.abort();
  const refactoredCode = done ? extractCode(output) : null;

  const copy = async () => {
    if (!refactoredCode) return;
    await navigator.clipboard.writeText(refactoredCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder='e.g. "Convert to async/await and add error handling"'
          className="flex-1 bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm
                     placeholder:text-slate-500 focus:outline-none focus:border-accent-dim"
        />
        {streaming ? (
          <button onClick={stop} className="px-4 py-2 rounded-md bg-rose-600/80 hover:bg-rose-600 text-sm font-medium">
            Stop
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!instruction.trim()}
            className="px-4 py-2 rounded-md bg-accent-dim hover:bg-cyan-600 text-sm font-medium
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Refactor
          </button>
        )}
      </div>

      {meta && <p className="text-xs text-slate-500 font-mono">{meta}</p>}
      {error && (
        <div className="border border-rose-500/40 bg-rose-500/10 text-rose-300 text-sm rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {output && (
        <pre
          ref={outRef}
          className="bg-ink-900 border border-ink-700 rounded-lg p-3 text-xs font-mono
                     whitespace-pre-wrap max-h-64 overflow-auto text-slate-300"
        >
          {output}
          {streaming && <span className="animate-pulse text-accent">▋</span>}
        </pre>
      )}

      {refactoredCode && (
        <>
          <div className="flex justify-end">
            <button
              onClick={copy}
              className="text-xs px-3 py-1.5 rounded-md border border-ink-600 hover:border-accent-dim text-slate-300"
            >
              {copied ? "Copied ✓" : "Copy refactored code"}
            </button>
          </div>
          <DiffView original={detail.entity.code} refactored={refactoredCode} />
        </>
      )}
      {done && !refactoredCode && (
        <p className="text-xs text-amber-400">
          The model did not return a fenced code block — see raw output above.
        </p>
      )}
    </div>
  );
}
