import { EntityKind } from "../types";

const STYLES: Record<EntityKind, string> = {
  function: "bg-sky-500/15 text-sky-300",
  component: "bg-violet-500/15 text-violet-300",
  class: "bg-amber-500/15 text-amber-300",
  interface: "bg-emerald-500/15 text-emerald-300",
  type: "bg-teal-500/15 text-teal-300",
  enum: "bg-rose-500/15 text-rose-300",
  variable: "bg-slate-500/15 text-slate-300",
};

export default function KindBadge({ kind }: { kind: EntityKind | null }) {
  if (!kind) return <span className="text-xs px-1.5 py-0.5 rounded bg-ink-700 text-slate-400">external</span>;
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${STYLES[kind]}`}>{kind}</span>
  );
}
