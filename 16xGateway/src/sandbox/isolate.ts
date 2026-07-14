/* ============================================================================
 * 16xGateway — src/sandbox/isolate.ts
 * Single-isolate SandboxInstance: hard memory ceiling, two-layer timeout,
 * fresh V8 context per invocation, copy-only boundary.
 * ==========================================================================*/

import ivm from "isolated-vm";
import type {
  JsonObject,
  PluginId,
  RequestId,
  SandboxErrorCode,
  SandboxInstance,
  SandboxOptions,
  SandboxRunOutcome,
  SemVer,
} from "../types/index.js";
import {
  INVOKER_SCRIPT,
  buildWrappedScript,
  isShapeError,
  makeFetchReference,
  makeLogReference,
  metaFor,
} from "./bridge.js";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `isolate-${Date.now().toString(36)}-${counter}`;
}

function looksLikeOom(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("memory limit") ||
    m.includes("out of memory") ||
    m.includes("array buffer allocation failed") ||
    (m.includes("memory") && m.includes("isolate")) ||
    m.includes("reached heap limit")
  );
}

/** Ensures the returned value is a plain JSON object (round-trips, no functions). */
function coerceJsonObject(raw: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

export class IsolateSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly pluginId: PluginId;
  readonly pluginVersion: SemVer;

  #isolate: ivm.Isolate;
  #compiledPlugin: ivm.Script;
  #compiledInvoker: ivm.Script;
  #options: SandboxOptions;
  #invocations = 0;
  #disposed = false;
  #running = false;

  private constructor(
    isolate: ivm.Isolate,
    compiledPlugin: ivm.Script,
    compiledInvoker: ivm.Script,
    pluginId: PluginId,
    pluginVersion: SemVer,
    options: SandboxOptions,
  ) {
    this.id = nextId();
    this.#isolate = isolate;
    this.#compiledPlugin = compiledPlugin;
    this.#compiledInvoker = compiledInvoker;
    this.pluginId = pluginId;
    this.pluginVersion = pluginVersion;
    this.#options = options;
  }

  get invocations(): number {
    return this.#invocations;
  }
  get disposed(): boolean {
    return this.#disposed;
  }

  static async create(
    pluginSource: string,
    pluginId: PluginId,
    pluginVersion: SemVer,
    options: SandboxOptions,
  ): Promise<IsolateSandboxInstance> {
    const isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb });
    // Compile ONCE per isolate; reuse the compiled scripts across contexts.
    const compiledPlugin = await isolate.compileScript(
      buildWrappedScript(pluginSource),
    );
    const compiledInvoker = await isolate.compileScript(INVOKER_SCRIPT);
    return new IsolateSandboxInstance(
      isolate,
      compiledPlugin,
      compiledInvoker,
      pluginId,
      pluginVersion,
      options,
    );
  }

  async run(payload: JsonObject, requestId: RequestId): Promise<SandboxRunOutcome> {
    const start = performance.now();
    if (this.#disposed || this.#isolate.isDisposed) {
      return {
        ok: false,
        kind: "error",
        errorCode: "SBX-INTERNAL",
        message: "sandbox disposed",
        durationMs: 0,
      };
    }
    if (this.#running) {
      return {
        ok: false,
        kind: "error",
        errorCode: "SBX-INTERNAL",
        message: "sandbox busy",
        durationMs: 0,
      };
    }
    this.#running = true;
    this.#invocations += 1;

    const { timeoutMs, capabilities } = this.#options;
    let context: ivm.Context | undefined;
    let wallTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const logRef = makeLogReference(capabilities);
    const fetchRef = makeFetchReference(capabilities);

    const dur = (): number => Math.round(performance.now() - start);

    try {
      context = await this.#isolate.createContext();
      const jail = context.global;
      jail.setSync("__16x_payloadJson", JSON.stringify(payload));
      jail.setSync(
        "__16x_metaJson",
        JSON.stringify(metaFor(requestId, this.pluginId, this.pluginVersion)),
      );
      jail.setSync("__16x_log", logRef);
      jail.setSync("__16x_fetch", fetchRef);

      // Layer 1: bound the synchronous evaluation of the plugin top level.
      this.#compiledPlugin.runSync(context, { timeout: timeoutMs });

      // Layer 2: external wall-clock racing the (possibly async) handler.
      const wall = new Promise<never>((_resolve, reject) => {
        wallTimer = setTimeout(() => {
          timedOut = true;
          try {
            this.#isolate.dispose();
          } catch {
            /* already gone */
          }
          reject(new Error("__16x_walltimeout"));
        }, timeoutMs);
        // Do not keep the event loop alive solely for this timer.
        if (typeof wallTimer.unref === "function") wallTimer.unref();
      });

      const evalPromise = this.#compiledInvoker.run(context, {
        timeout: timeoutMs,
        promise: true,
      }) as Promise<unknown>;

      const raw = (await Promise.race([evalPromise, wall])) as string;

      const data = coerceJsonObject(raw);
      if (data === null) {
        await this.dispose();
        return {
          ok: false,
          kind: "error",
          errorCode: "SBX-RESULT-INVALID",
          message: "plugin result is not a JSON object",
          durationMs: dur(),
        };
      }
      // Success: context is discarded; isolate may be reused by the pool.
      return { ok: true, data, durationMs: dur() };
    } catch (err) {
      const outcome = this.#classify(err, timedOut, dur());
      // Any not-ok outcome disposes the isolate — never reuse a poisoned isolate.
      await this.dispose();
      return outcome;
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
      try {
        logRef.release();
        fetchRef.release();
      } catch {
        /* ignore */
      }
      if (context && !timedOut) {
        try {
          context.release();
        } catch {
          /* ignore */
        }
      }
      this.#running = false;
    }
  }

  #classify(
    err: unknown,
    timedOut: boolean,
    durationMs: number,
  ): Exclude<SandboxRunOutcome, { ok: true }> {
    if (timedOut) {
      return { ok: false, kind: "timeout", durationMs };
    }
    if (isShapeError(err)) {
      return {
        ok: false,
        kind: "error",
        errorCode: "SBX-RESULT-INVALID",
        message: err.message,
        durationMs,
      };
    }
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "sandbox error";

    if (message === "__16x_walltimeout") {
      return { ok: false, kind: "timeout", durationMs };
    }
    let errorCode: SandboxErrorCode;
    if (this.#isolate.isDisposed || looksLikeOom(message)) {
      errorCode = "SBX-OOM";
    } else {
      errorCode = "SBX-THREW";
    }
    // Never leak stacks/paths — message only.
    return { ok: false, kind: "error", errorCode, message, durationMs };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      if (!this.#isolate.isDisposed) this.#isolate.dispose();
    } catch {
      /* idempotent */
    }
  }
}
