/* ============================================================================
 * 16xGateway — src/sandbox/index.ts
 * SandboxProvider + pooled SandboxService.
 *
 * The service keeps up to `isolatePoolPerPlugin` warm instances per
 * (pluginId, version, source-hash), lazily replaces disposed ones, recycles an
 * instance after `recycleAfterInvocations` runs, and serializes access so a
 * single instance never runs two invocations concurrently.
 *
 * Capabilities are request-scoped but the compiled isolate is warm and shared.
 * Each pooled instance is constructed with a capability object that forwards to
 * a per-member mutable holder; the holder is set to this request's capabilities
 * immediately before run() and cleared afterward. Since the service serializes
 * access to each instance, there is never capability cross-talk.
 * ==========================================================================*/

import { createHash } from "node:crypto";
import type {
  CapabilityFetchRequest,
  CapabilityFetchResponse,
  HostCapabilities,
  JsonObject,
  LogLevel,
  PluginId,
  RequestId,
  SandboxInstance,
  SandboxOptions,
  SandboxProvider,
  SandboxRunOutcome,
  SandboxService,
  SemVer,
} from "../types/index.js";
import { IsolateSandboxInstance } from "./isolate.js";

export function createSandboxProvider(): SandboxProvider {
  return {
    create(
      pluginSource: string,
      pluginId: PluginId,
      pluginVersion: SemVer,
      options: SandboxOptions,
    ): Promise<SandboxInstance> {
      return IsolateSandboxInstance.create(
        pluginSource,
        pluginId,
        pluginVersion,
        options,
      );
    },
  };
}

export interface SandboxServiceOptions {
  memoryLimitMb: number;
  timeoutMs: number;
  isolatePoolPerPlugin: number;
  recycleAfterInvocations: number;
}

/** Mutable per-member capability holder; swapped in right before each run. */
class CapabilityHolder implements HostCapabilities {
  current: HostCapabilities | null = null;
  async fetch(req: CapabilityFetchRequest): Promise<CapabilityFetchResponse> {
    if (!this.current) throw new Error("EGRESS_DENIED: no active capabilities");
    return this.current.fetch(req);
  }
  log(level: LogLevel, message: string): void {
    if (this.current) this.current.log(level, message);
  }
}

interface PooledInstance {
  instance: SandboxInstance;
  holder: CapabilityHolder;
  busy: boolean;
}

interface Pool {
  key: string;
  pluginId: PluginId;
  pluginVersion: SemVer;
  source: string;
  members: PooledInstance[];
  waiters: Array<() => void>;
}

function hashSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);
}

export function createSandboxService(
  opts: SandboxServiceOptions,
  provider: SandboxProvider = createSandboxProvider(),
): SandboxService {
  const pools = new Map<string, Pool>();
  let closed = false;

  function getPool(id: PluginId, version: SemVer, source: string): Pool {
    const key = `${id}@${version}#${hashSource(source)}`;
    let pool = pools.get(key);
    if (!pool) {
      pool = {
        key,
        pluginId: id,
        pluginVersion: version,
        source,
        members: [],
        waiters: [],
      };
      pools.set(key, pool);
    }
    return pool;
  }

  async function makeInstance(pool: Pool): Promise<PooledInstance> {
    const holder = new CapabilityHolder();
    const options: SandboxOptions = {
      memoryLimitMb: opts.memoryLimitMb,
      timeoutMs: opts.timeoutMs,
      capabilities: holder,
    };
    const instance = await provider.create(
      pool.source,
      pool.pluginId,
      pool.pluginVersion,
      options,
    );
    const member: PooledInstance = { instance, holder, busy: false };
    pool.members.push(member);
    return member;
  }

  function pruneDisposed(pool: Pool): void {
    pool.members = pool.members.filter((m) => !m.instance.disposed);
  }

  async function acquire(pool: Pool): Promise<PooledInstance> {
    // Serialize: loop until a member is free.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      pruneDisposed(pool);
      const free = pool.members.find((m) => !m.busy);
      if (free) {
        free.busy = true;
        return free;
      }
      if (pool.members.length < opts.isolatePoolPerPlugin) {
        const member = await makeInstance(pool);
        member.busy = true;
        return member;
      }
      await new Promise<void>((resolve) => pool.waiters.push(resolve));
    }
  }

  function release(pool: Pool, member: PooledInstance): void {
    member.busy = false;
    member.holder.current = null;
    if (
      member.instance.disposed ||
      member.instance.invocations >= opts.recycleAfterInvocations
    ) {
      void member.instance.dispose();
      pool.members = pool.members.filter((m) => m !== member);
    }
    const waiter = pool.waiters.shift();
    if (waiter) waiter();
  }

  return {
    async run(
      pluginSource: string,
      pluginId: PluginId,
      pluginVersion: SemVer,
      payload: JsonObject,
      requestId: RequestId,
      capabilities: HostCapabilities,
    ): Promise<SandboxRunOutcome> {
      if (closed) {
        return {
          ok: false,
          kind: "error",
          errorCode: "SBX-INTERNAL",
          message: "sandbox service closed",
          durationMs: 0,
        };
      }
      const pool = getPool(pluginId, pluginVersion, pluginSource);
      const member = await acquire(pool);
      member.holder.current = capabilities;
      try {
        return await member.instance.run(payload, requestId);
      } finally {
        release(pool, member);
      }
    },

    async disposeAll(): Promise<void> {
      closed = true;
      const all: Promise<void>[] = [];
      for (const pool of pools.values()) {
        for (const m of pool.members) all.push(m.instance.dispose());
        pool.members = [];
        pool.waiters = [];
      }
      pools.clear();
      await Promise.all(all);
    },
  };
}
