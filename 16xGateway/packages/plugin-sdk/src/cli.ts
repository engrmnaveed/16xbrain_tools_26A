#!/usr/bin/env node
/* ============================================================================
 * @16xbrains/plugin-sdk — src/cli.ts  (bin: 16xgateway)
 * Local dev harness. Runs the REAL policy gate and REAL sandbox (D12) so a
 * local `check`/`run` shares the production admission code path.
 *
 *   16xgateway check <file> [--policy=strict|standard]
 *   16xgateway run   <file> --payload=<fixture.json> [--policy=...]
 *                          [--timeout=3000] [--memory=128]
 *
 * Output is machine-parseable: no colors, no spinners.
 * ==========================================================================*/

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

type PolicyLevel = "strict" | "standard";

interface PolicyViolation { code: string; message: string; line: number | null; column: number | null; }
interface PolicyResult { ok: boolean; violations: PolicyViolation[]; }
interface PolicyScanner { scan(source: string, level: PolicyLevel): PolicyResult; }

interface SandboxService {
  run(source: string, id: string, version: string, payload: Record<string, unknown>, requestId: string, caps: unknown): Promise<unknown>;
  disposeAll(): Promise<void>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve a core subpath, preferring the published package, then the monorepo build. */
async function loadCore<T>(subpath: "policy" | "sandbox"): Promise<T> {
  const candidates = [
    `@16xbrains/gateway-core/${subpath}`,
    // Monorepo build fallback: root core compiles to <root>/dist/src/<subpath>/index.js.
    // From packages/plugin-sdk/dist/src/cli.js that is four levels up.
    pathResolve(HERE, `../../../../dist/src/${subpath}/index.js`),
    pathResolve(HERE, `../../../../../dist/src/${subpath}/index.js`),
  ];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      return (await import(c)) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`cannot load @16xbrains/gateway-core/${subpath}: ${(lastErr as Error)?.message ?? "not found"}`);
}

function parseArgs(argv: string[]): { cmd: string; file: string | undefined; flags: Record<string, string> } {
  const [cmd, file, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (const a of rest) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) flags[m[1]!] = m[2]!;
  }
  return { cmd: cmd ?? "", file, flags };
}

async function cmdCheck(file: string, level: PolicyLevel): Promise<number> {
  const source = await readFile(file, "utf8");
  const mod = await loadCore<{ createPolicyScanner(): PolicyScanner }>("policy");
  const result = mod.createPolicyScanner().scan(source, level);
  for (const v of result.violations) {
    const loc = v.line !== null ? `${v.line}:${v.column ?? 0}` : "0:0";
    process.stdout.write(`${v.code} ${loc} ${v.message}\n`);
  }
  return result.ok ? 0 : 1;
}

async function cmdRun(file: string, flags: Record<string, string>): Promise<number> {
  const level = (flags["policy"] as PolicyLevel) ?? "strict";
  const timeoutMs = flags["timeout"] ? parseInt(flags["timeout"], 10) : 3000;
  const memoryLimitMb = flags["memory"] ? parseInt(flags["memory"], 10) : 128;
  const fixture = flags["payload"];
  if (!fixture) {
    process.stderr.write("run: --payload=<fixture.json> is required\n");
    return 1;
  }

  const source = await readFile(file, "utf8");
  const policyMod = await loadCore<{ createPolicyScanner(): PolicyScanner }>("policy");
  const gate = policyMod.createPolicyScanner().scan(source, level);
  if (!gate.ok) {
    for (const v of gate.violations) {
      const loc = v.line !== null ? `${v.line}:${v.column ?? 0}` : "0:0";
      process.stdout.write(`${v.code} ${loc} ${v.message}\n`);
    }
    return 1;
  }

  const payload = JSON.parse(await readFile(fixture, "utf8")) as Record<string, unknown>;
  const sandboxMod = await loadCore<{ createSandboxService(o: {
    memoryLimitMb: number; timeoutMs: number; isolatePoolPerPlugin: number; recycleAfterInvocations: number;
  }): SandboxService }>("sandbox");
  const service = sandboxMod.createSandboxService({
    memoryLimitMb,
    timeoutMs,
    isolatePoolPerPlugin: 1,
    recycleAfterInvocations: 1,
  });

  const caps = {
    async fetch(): Promise<never> {
      throw new Error("EGRESS_DENIED (local harness)");
    },
    log(level: string, message: string): void {
      process.stderr.write(`[plugin:${level}] ${message}\n`);
    },
  };

  // The plugin declares its own id/version; the harness runs it under those.
  const idMatch = /id\s*:\s*["']([^"']+)["']/.exec(source);
  const verMatch = /version\s*:\s*["']([^"']+)["']/.exec(source);
  const id = idMatch?.[1] ?? "local-plugin";
  const version = verMatch?.[1] ?? "0.0.0";

  const outcome = await service.run(source, id, version, payload, "local-harness", caps);
  await service.disposeAll();
  process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
  return (outcome as { ok?: boolean }).ok === true ? 0 : 1;
}

async function main(): Promise<void> {
  const { cmd, file, flags } = parseArgs(process.argv.slice(2));
  const level = (flags["policy"] as PolicyLevel) ?? "strict";

  if ((cmd !== "check" && cmd !== "run") || !file) {
    process.stderr.write(
      "usage:\n" +
        "  16xgateway check <file> [--policy=strict|standard]\n" +
        "  16xgateway run   <file> --payload=<fixture.json> [--policy=...] [--timeout=3000] [--memory=128]\n",
    );
    process.exit(2);
  }

  const code = cmd === "check" ? await cmdCheck(file, level) : await cmdRun(file, flags);
  process.exit(code);
}

main().catch((e) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
