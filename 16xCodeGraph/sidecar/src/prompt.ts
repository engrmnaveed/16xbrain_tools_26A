import path from "path";
import { EntityDetail } from "./types";

/**
 * Builds a *targeted* refactor prompt: the selected entity's code plus only
 * the signatures of its direct dependencies. Never whole files.
 * Small models get a small, focused context.
 */
export function buildRefactorPrompt(detail: EntityDetail, instruction: string): string {
  const { entity, dependencies } = detail;
  const fileName = path.basename(entity.file_path);

  const depBlock =
    dependencies.length === 0
      ? "(none — this entity is self-contained)"
      : dependencies
          .map((d) => {
            const loc = d.file_path ? path.basename(d.file_path) : "external";
            const sig = d.signature ?? d.name;
            return `// from ${loc}\n${sig}`;
          })
          .join("\n\n");

  return `You are an expert TypeScript refactoring assistant.

TASK: ${instruction.trim()}

Refactor ONLY the target code below. Its dependencies are listed for reference — do NOT rewrite them, do NOT invent new APIs for them; call them exactly as their signatures describe.

=== TARGET (${entity.kind} \`${entity.name}\` in ${fileName}, lines ${entity.start_line}-${entity.end_line}) ===
\`\`\`typescript
${entity.code}
\`\`\`

=== DEPENDENCY SIGNATURES (reference only) ===
${depBlock}

RULES:
1. Return the COMPLETE refactored ${entity.kind} — a drop-in replacement.
2. Keep the exact same exported name and public signature unless the task requires changing it.
3. Do not add imports for things that are not in the dependency list.
4. Output exactly one \`\`\`typescript code block with the refactored code, then a short bullet list of what changed. No other prose.`;
}
