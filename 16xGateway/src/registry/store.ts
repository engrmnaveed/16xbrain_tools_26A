/* ============================================================================
 * 16xGateway — src/registry/store.ts
 * Atomic JSON persistence for the plugin registry.
 * Writes go to a tmp file then fs.rename (atomic on POSIX) so a crash never
 * leaves a half-written registry.json.
 * ==========================================================================*/

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginRegistryEntry } from "../types/index.js";

export interface StoreShape {
  entries: PluginRegistryEntry[];
}

export class RegistryStore {
  #storePath: string;

  constructor(rootDir: string) {
    this.#storePath = join(rootDir, "registry.json");
  }

  get path(): string {
    return this.#storePath;
  }

  async load(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.#storePath, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
      return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
      throw e;
    }
  }

  async save(shape: StoreShape): Promise<void> {
    await fs.mkdir(dirname(this.#storePath), { recursive: true });
    const tmp = `${this.#storePath}.tmp-${process.pid}-${Date.now()}`;
    const data = JSON.stringify(shape, null, 2);
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, this.#storePath);
  }

  async mtimeMs(): Promise<number> {
    try {
      const st = await fs.stat(this.#storePath);
      return st.mtimeMs;
    } catch {
      return 0;
    }
  }
}

export async function writeSourceFile(
  rootDir: string,
  id: string,
  version: string,
  source: string,
): Promise<string> {
  const dir = join(rootDir, id, version);
  await fs.mkdir(dir, { recursive: true });
  const filePath = join(dir, "plugin.cjs");
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, source, "utf8");
  await fs.rename(tmp, filePath);
  return filePath;
}

export async function readSourceFile(sourcePath: string): Promise<string> {
  return fs.readFile(sourcePath, "utf8");
}
