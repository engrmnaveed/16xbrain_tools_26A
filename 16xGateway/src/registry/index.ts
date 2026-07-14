/* ============================================================================
 * 16xGateway — src/registry/index.ts
 * createPluginRegistry(): admit → gate → hash → persist → resolve → revoke.
 * The AST gate runs at ADMISSION; a rejected plugin never lands in the store,
 * so a later execute() sees REG-UNKNOWN — zero execution of hostile code.
 * ==========================================================================*/

import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  AdmissionResult,
  PluginId,
  PluginRegistry,
  PluginRegistryEntry,
  PolicyLevel,
  PolicyScanner,
  ReasonCode,
  SemVer,
} from "../types/index.js";
import { uniqueCodes } from "../policy/index.js";
import {
  RegistryStore,
  readSourceFile,
  writeSourceFile,
  type StoreShape,
} from "./store.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface RegistryOptions {
  rootDir: string;
  scanner: PolicyScanner;
  policyLevel: PolicyLevel;
}

function sha256Hex(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/** Numeric semver compare: 1 if a>b, -1 if a<b, 0 if equal. */
function semverCompare(a: SemVer, b: SemVer): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function createPluginRegistry(opts: RegistryOptions): PluginRegistry {
  const store = new RegistryStore(opts.rootDir);
  let cache: StoreShape = { entries: [] };
  let loaded = false;

  async function ensureLoaded(): Promise<void> {
    if (!loaded) {
      cache = await store.load();
      loaded = true;
    }
  }

  function find(id: PluginId, version: SemVer): PluginRegistryEntry | undefined {
    return cache.entries.find((e) => e.id === id && e.version === version);
  }

  return {
    async admit(
      source: string,
      id: PluginId,
      version: SemVer,
      admittedBy: string,
    ): Promise<AdmissionResult> {
      await ensureLoaded();

      if (!ID_RE.test(id)) {
        return { admitted: false, reasonCodes: ["REG-BAD-ID"] as ReasonCode[] };
      }
      if (!SEMVER_RE.test(version)) {
        return { admitted: false, reasonCodes: ["REG-BAD-VERSION"] as ReasonCode[] };
      }
      if (find(id, version)) {
        return { admitted: false, reasonCodes: ["REG-DUPLICATE"] as ReasonCode[] };
      }

      const policyReport = opts.scanner.scan(source, opts.policyLevel);
      if (!policyReport.ok) {
        return {
          admitted: false,
          reasonCodes: uniqueCodes(policyReport.violations) as ReasonCode[],
          policyReport,
        };
      }

      // Passed the gate: persist source + entry atomically.
      const sourcePath = await writeSourceFile(opts.rootDir, id, version, source);
      const entry: PluginRegistryEntry = {
        id,
        version,
        sha256: sha256Hex(source),
        sizeBytes: Buffer.byteLength(source, "utf8"),
        status: "active",
        admittedAt: new Date().toISOString(),
        admittedBy,
        policyReport,
        sourcePath,
      };
      cache.entries.push(entry);
      await store.save(cache);
      return { admitted: true, entry };
    },

    async resolve(id: PluginId, version?: SemVer): Promise<PluginRegistryEntry | null> {
      await ensureLoaded();
      if (version !== undefined) {
        const e = find(id, version);
        if (!e || e.status !== "active") return null;
        return e;
      }
      const active = cache.entries.filter((e) => e.id === id && e.status === "active");
      if (active.length === 0) return null;
      active.sort((a, b) => semverCompare(b.version, a.version));
      return active[0] ?? null;
    },

    async revoke(id: PluginId, version: SemVer, reason: string): Promise<boolean> {
      await ensureLoaded();
      const e = find(id, version);
      if (!e) return false;
      e.status = "revoked";
      e.revokedAt = new Date().toISOString();
      e.revokedReason = reason;
      await store.save(cache);
      return true;
    },

    async list(): Promise<PluginRegistryEntry[]> {
      await ensureLoaded();
      return cache.entries.map((e) => ({ ...e }));
    },

    async loadVerifiedSource(entry: PluginRegistryEntry): Promise<string> {
      const path = entry.sourcePath ?? join(opts.rootDir, entry.id, entry.version, "plugin.cjs");
      const source = await readSourceFile(path);
      const actual = sha256Hex(source);
      if (actual !== entry.sha256) {
        const err = new Error(
          `stored source hash mismatch for ${entry.id}@${entry.version}`,
        ) as Error & { code?: string };
        err.code = "REG-HASH-MISMATCH";
        throw err;
      }
      return source;
    },

    async reload(): Promise<void> {
      cache = await store.load();
      loaded = true;
    },
  };
}

export { RegistryStore } from "./store.js";
