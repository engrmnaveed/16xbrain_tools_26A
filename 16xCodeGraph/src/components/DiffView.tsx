import { useMemo } from "react";

type Op = { type: "same" | "add" | "del"; text: string };

/** Simple LCS-based line diff — no dependencies, runs instantly on entity-sized code. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: "del", text: a[i] }); i++; }
    else { ops.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) ops.push({ type: "del", text: a[i++] });
  while (j < m) ops.push({ type: "add", text: b[j++] });
  return ops;
}

export default function DiffView({ original, refactored }: { original: string; refactored: string }) {
  const ops = useMemo(
    () => diffLines(original.split("\n"), refactored.split("\n")),
    [original, refactored]
  );
  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;

  return (
    <div className="border border-ink-700 rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 bg-ink-850 text-xs text-slate-400 flex gap-3 border-b border-ink-700">
        <span>Diff</span>
        <span className="text-emerald-400">+{added}</span>
        <span className="text-rose-400">-{removed}</span>
      </div>
      <pre className="text-xs font-mono overflow-auto max-h-96 leading-5">
        {ops.map((op, idx) => (
          <div
            key={idx}
            className={
              op.type === "add"
                ? "bg-emerald-500/10 text-emerald-300 px-3"
                : op.type === "del"
                ? "bg-rose-500/10 text-rose-300 px-3"
                : "text-slate-400 px-3"
            }
          >
            <span className="select-none inline-block w-4">
              {op.type === "add" ? "+" : op.type === "del" ? "-" : " "}
            </span>
            {op.text || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
