import { useCallback, useEffect, useRef, useState } from "react";
import { api, pickDirectory } from "./api/client";
import EntityView from "./components/EntityView";
import SearchPanel from "./components/SearchPanel";
import SettingsModal from "./components/SettingsModal";
import { EntityDetail, ScanStatus } from "./types";

export default function App() {
  const [sidecarUp, setSidecarUp] = useState<boolean | null>(null);
  const [stats, setStats] = useState<{ files: number; entities: number } | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const pollRef = useRef<number | undefined>(undefined);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setSidecarUp(true);
      setStats({ files: h.stats.files, entities: h.stats.entities });
    } catch {
      setSidecarUp(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = window.setInterval(refreshHealth, 5000);
    return () => window.clearInterval(t);
  }, [refreshHealth]);

  const startScan = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      await api.startScan(dir);
    } catch (e) {
      setScan({
        state: "error", rootPath: dir, totalFiles: 0, scannedFiles: 0,
        entityCount: 0, skippedUnchanged: 0, error: (e as Error).message,
      });
      return;
    }
    window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const s = await api.scanStatus().catch(() => null);
      if (!s) return;
      setScan(s);
      if (s.state === "done" || s.state === "error") {
        window.clearInterval(pollRef.current);
        setRefreshKey((k) => k + 1);
        refreshHealth();
      }
    }, 400);
  };

  const selectEntity = async (id: number) => {
    try {
      setDetail(await api.entity(id));
    } catch {
      /* entity may have been re-scanned away */
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* header */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-ink-700 bg-ink-900">
        <span className="font-semibold text-slate-100">
          16x <span className="text-accent">CodeGraph</span>
        </span>
        <button
          onClick={startScan}
          disabled={scan?.state === "scanning"}
          className="text-sm px-3 py-1.5 rounded-md bg-accent-dim hover:bg-cyan-600 font-medium disabled:opacity-50"
        >
          {scan?.state === "scanning" ? "Scanning…" : "Scan project"}
        </button>
        {scan?.state === "scanning" && (
          <span className="text-xs text-slate-400 font-mono">
            {scan.scannedFiles}/{scan.totalFiles} files · {scan.entityCount} entities
          </span>
        )}
        {scan?.state === "done" && (
          <span className="text-xs text-emerald-400 font-mono">
            ✓ {scan.scannedFiles} files ({scan.skippedUnchanged} unchanged) · {scan.entityCount} new entities
          </span>
        )}
        {scan?.state === "error" && (
          <span className="text-xs text-rose-400">{scan.error}</span>
        )}
        <div className="flex-1" />
        {stats && (
          <span className="text-xs text-slate-500 font-mono">
            graph: {stats.files} files / {stats.entities} entities
          </span>
        )}
        <button
          onClick={() => setShowSettings(true)}
          className="text-sm px-3 py-1.5 rounded-md border border-ink-600 hover:border-accent-dim text-slate-300"
        >
          ⚙ Settings
        </button>
      </header>

      {/* sidecar down banner */}
      {sidecarUp === false && (
        <div className="px-4 py-2 bg-rose-500/10 border-b border-rose-500/40 text-rose-300 text-sm">
          Backend engine not reachable on port 43917. In dev, run <code className="font-mono">npm run dev</code>{" "}
          (it starts the sidecar automatically).
        </div>
      )}

      {/* body */}
      <div className="flex-1 flex min-h-0">
        <aside className="w-80 border-r border-ink-700 bg-ink-900/50 shrink-0">
          <SearchPanel
            onSelect={selectEntity}
            selectedId={detail?.entity.id ?? null}
            refreshKey={refreshKey}
          />
        </aside>
        <main className="flex-1 min-w-0">
          {detail ? (
            <EntityView detail={detail} onNavigate={selectEntity} />
          ) : (
            <EmptyState hasGraph={(stats?.entities ?? 0) > 0} onScan={startScan} />
          )}
        </main>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function EmptyState({ hasGraph, onScan }: { hasGraph: boolean; onScan: () => void }) {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center max-w-sm space-y-3">
        <div className="text-4xl">⌁</div>
        {hasGraph ? (
          <>
            <p className="text-slate-300">Search for a function, component, or class on the left.</p>
            <p className="text-xs text-slate-500">
              Select an entity to see its dependency graph and run a targeted refactor —
              only the code that matters gets sent to your LLM.
            </p>
          </>
        ) : (
          <>
            <p className="text-slate-300">No code graph yet.</p>
            <button
              onClick={onScan}
              className="text-sm px-4 py-2 rounded-md bg-accent-dim hover:bg-cyan-600 font-medium"
            >
              Scan a TypeScript project
            </button>
            <p className="text-xs text-slate-500">
              First scan parses every .ts/.tsx file; re-scans only touch changed files.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
