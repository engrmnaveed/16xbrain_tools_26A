/* ============================================================================
 * 16xGateway — src/sandbox/bridge.ts
 * Builds the wrapped plugin script and injects host capabilities into an
 * isolate context. The isolate has ZERO ambient capabilities — everything the
 * plugin can reach is placed here, explicitly, per invocation.
 * ==========================================================================*/

import ivm from "isolated-vm";
import type {
  CapabilityFetchRequest,
  CapabilityFetchResponse,
  HostCapabilities,
  JsonObject,
  LogLevel,
  PluginMeta,
} from "../types/index.js";

/**
 * The prelude defines a minimal CommonJS environment plus the sdk shim, then
 * the plugin source is appended verbatim. `definePlugin` is the identity
 * function — the definition object is what ends up on module.exports.
 */
export function buildWrappedScript(pluginSource: string): string {
  return `
"use strict";
const module = { exports: {} };
const exports = module.exports;
function require(name) {
  if (name === "@16xbrains/plugin-sdk") {
    return { definePlugin: function (d) { return d; } };
  }
  throw new Error("require blocked: " + name);
}
${pluginSource}
;
globalThis.__16x_module = module;
`;
}

/**
 * The invoker script runs INSIDE the isolate. It reads the injected payload,
 * meta and the host references, builds ctx, calls the handler, awaits a
 * possible Promise, and returns a JSON string of the result. Returning a
 * string (not an object reference) keeps the boundary copy-only.
 */
export const INVOKER_SCRIPT = `
(async function () {
  const mod = globalThis.__16x_module;
  if (!mod || typeof mod.exports !== "object" || mod.exports === null) {
    throw { __16x: "shape", message: "plugin did not assign module.exports" };
  }
  const def = mod.exports;
  if (typeof def.handler !== "function" || typeof def.id !== "string" || typeof def.version !== "string") {
    throw { __16x: "shape", message: "plugin shape: need {id, version, handler}" };
  }
  const payload = JSON.parse(globalThis.__16x_payloadJson);
  const meta = JSON.parse(globalThis.__16x_metaJson);

  const ctx = {
    meta: meta,
    log: function (level, message) {
      // __16x_log is an ivm.Reference to a host function.
      globalThis.__16x_log.applySync(undefined, [String(level), String(message)]);
    },
    fetch: function (req) {
      // __16x_fetch is an ivm.Reference to a host async function; applySyncPromise
      // bridges the host Promise back into the isolate as a resolved copy.
      const resultJson = globalThis.__16x_fetch.applySyncPromise(undefined, [JSON.stringify(req)]);
      return Promise.resolve(JSON.parse(resultJson));
    },
  };

  const out = await def.handler(payload, ctx);
  return JSON.stringify(out === undefined ? null : out);
})();
`;

/** Host-side log bridge, rate-limited by the caller if desired. */
export function makeLogReference(caps: HostCapabilities): ivm.Reference<
  (level: string, message: string) => void
> {
  return new ivm.Reference((level: string, message: string) => {
    caps.log(level as LogLevel, message);
  });
}

/**
 * Host-side fetch bridge. Receives a JSON string (the CapabilityFetchRequest),
 * executes host-side against the allowlist inside caps.fetch, and returns a
 * JSON string of the response. Throwing here surfaces inside the plugin.
 */
export function makeFetchReference(
  caps: HostCapabilities,
): ivm.Reference<(reqJson: string) => Promise<string>> {
  return new ivm.Reference(async (reqJson: string): Promise<string> => {
    const req = JSON.parse(reqJson) as CapabilityFetchRequest;
    const res: CapabilityFetchResponse = await caps.fetch(req);
    return JSON.stringify(res);
  });
}

/** Meta object copied into the isolate for ctx.meta. */
export function metaFor(
  requestId: string,
  pluginId: string,
  pluginVersion: string,
): PluginMeta {
  return {
    requestId,
    pluginId,
    pluginVersion,
    invokedAt: new Date().toISOString(),
  };
}

/** Type guard for the shape-error object thrown by the invoker. */
export function isShapeError(e: unknown): e is { __16x: "shape"; message: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { __16x?: unknown }).__16x === "shape"
  );
}

export type { JsonObject };
