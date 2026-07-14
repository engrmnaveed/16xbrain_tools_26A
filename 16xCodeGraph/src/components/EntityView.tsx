import { EntityDetail } from "../types";
import KindBadge from "./KindBadge";
import RefactorPanel from "./RefactorPanel";

interface Props {
  detail: EntityDetail;
  onNavigate: (id: number) => void;
}

export default function EntityView({ detail, onNavigate }: Props) {
  const { entity, dependencies, dependents } = detail;
  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-mono text-lg text-slate-100">{entity.name}</h2>
          <KindBadge kind={entity.kind} />
          <span className="text-xs text-slate-500">
            {entity.file_path} · L{entity.start_line}–{entity.end_line}
          </span>
        </div>
      </div>

      <pre className="bg-ink-900 border border-ink-700 rounded-lg p-3 text-xs font-mono overflow-auto max-h-72 text-slate-300">
        {entity.code}
      </pre>

      <div className="grid grid-cols-2 gap-4">
        <DepList
          title={`Depends on (${dependencies.length})`}
          items={dependencies}
          onNavigate={onNavigate}
          empty="No graph dependencies — self-contained."
        />
        <DepList
          title={`Used by (${dependents.length})`}
          items={dependents}
          onNavigate={onNavigate}
          empty="Nothing in the graph references this yet."
        />
      </div>

      <div className="border-t border-ink-700 pt-4">
        <h3 className="text-sm font-medium text-slate-300 mb-2">
          Targeted refactor
          <span className="text-xs text-slate-500 ml-2">
            only this {entity.kind} + {dependencies.length} dependency signature
            {dependencies.length === 1 ? "" : "s"} will be sent to the LLM
          </span>
        </h3>
        <RefactorPanel key={entity.id} detail={detail} />
      </div>
    </div>
  );
}

function DepList({
  title,
  items,
  onNavigate,
  empty,
}: {
  title: string;
  items: EntityDetail["dependencies"];
  onNavigate: (id: number) => void;
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-300 mb-1.5">{title}</h3>
      {items.length === 0 && <p className="text-xs text-slate-500">{empty}</p>}
      <ul className="space-y-1 max-h-40 overflow-auto pr-1">
        {items.map((d, i) => (
          <li key={`${d.name}-${i}`}>
            <button
              disabled={d.id == null}
              onClick={() => d.id != null && onNavigate(d.id)}
              className="w-full text-left flex items-center gap-2 px-2 py-1 rounded
                         hover:bg-ink-850 disabled:cursor-default"
            >
              <span className="font-mono text-xs text-slate-200">{d.name}</span>
              <KindBadge kind={d.kind} />
              {d.file_path && (
                <span className="text-[10px] text-slate-500 truncate">
                  {d.file_path.split("/").pop()}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
