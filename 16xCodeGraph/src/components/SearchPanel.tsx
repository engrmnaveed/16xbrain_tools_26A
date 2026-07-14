import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Entity } from "../types";
import KindBadge from "./KindBadge";

interface Props {
  onSelect: (id: number) => void;
  selectedId: number | null;
  refreshKey: number; // bump after a scan so counts refresh
}

export default function SearchPanel({ onSelect, selectedId, refreshKey }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    if (!query.trim()) {
      setResults([]);
      return;
    }
    debounce.current = window.setTimeout(async () => {
      try {
        setResults(await api.search(query.trim()));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 200);
    return () => window.clearTimeout(debounce.current);
  }, [query, refreshKey]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-ink-700">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search functions, components, classes…"
          className="w-full bg-ink-850 border border-ink-700 rounded-md px-3 py-2 text-sm
                     placeholder:text-slate-500 focus:outline-none focus:border-accent-dim"
          autoFocus
        />
      </div>
      <div className="flex-1 overflow-auto">
        {error && <p className="p-3 text-xs text-rose-400">{error}</p>}
        {!error && query && results.length === 0 && (
          <p className="p-3 text-xs text-slate-500">No matches. Scan a project first?</p>
        )}
        {results.map((e) => (
          <button
            key={e.id}
            onClick={() => onSelect(e.id)}
            className={`w-full text-left px-3 py-2 border-b border-ink-800 hover:bg-ink-850
                        ${selectedId === e.id ? "bg-ink-800" : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-slate-100 truncate">{e.name}</span>
              <KindBadge kind={e.kind} />
              {e.exported ? <span className="text-[10px] text-accent">exported</span> : null}
            </div>
            <div className="text-xs text-slate-500 truncate mt-0.5">
              {e.file_path.split("/").slice(-2).join("/")}:{e.start_line}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
