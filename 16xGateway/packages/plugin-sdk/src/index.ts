/* ============================================================================
 * @16xbrains/plugin-sdk — src/index.ts
 * definePlugin(): validates the definition and freezes it. This is the ONLY
 * symbol a plugin author imports at runtime.
 * ==========================================================================*/

import type { JsonObject, PluginDefinition } from "./types.js";

export * from "./types.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function definePlugin<TIn extends JsonObject = JsonObject, TOut extends JsonObject = JsonObject>(
  def: PluginDefinition<TIn, TOut>,
): PluginDefinition<TIn, TOut> {
  if (typeof def !== "object" || def === null) {
    throw new TypeError("definePlugin: definition must be an object");
  }
  if (typeof def.id !== "string" || !ID_RE.test(def.id)) {
    throw new TypeError(`definePlugin: 'id' must match ${ID_RE} (got ${JSON.stringify(def.id)})`);
  }
  if (typeof def.version !== "string" || !SEMVER_RE.test(def.version)) {
    throw new TypeError(`definePlugin: 'version' must be strict numeric semver x.y.z (got ${JSON.stringify(def.version)})`);
  }
  if (typeof def.handler !== "function") {
    throw new TypeError("definePlugin: 'handler' must be a function");
  }
  return Object.freeze(def);
}
