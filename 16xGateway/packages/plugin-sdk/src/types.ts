/* ============================================================================
 * @16xbrains/plugin-sdk — types.ts
 * The plugin-facing slice of the 16xGateway contract. Agencies import ONLY
 * from this package; they never see the host repo.
 * ==========================================================================*/

export type PluginId = string;
export type SemVer = string;
export type RequestId = string;
export type LogLevel = "debug" | "info" | "warn" | "error";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export interface JsonObject { [key: string]: JsonValue; }

export interface CapabilityFetchRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}
export interface CapabilityFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface HostCapabilities {
  fetch(req: CapabilityFetchRequest): Promise<CapabilityFetchResponse>;
  log(level: LogLevel, message: string): void;
}

export interface PluginMeta {
  requestId: RequestId;
  pluginId: PluginId;
  pluginVersion: SemVer;
  invokedAt: string;
}

export interface PluginContext {
  fetch: HostCapabilities["fetch"];
  log: HostCapabilities["log"];
  meta: PluginMeta;
}

export type PluginHandler<TIn extends JsonObject = JsonObject, TOut extends JsonObject = JsonObject> =
  (payload: TIn, ctx: PluginContext) => TOut | Promise<TOut>;

export interface PluginDefinition<TIn extends JsonObject = JsonObject, TOut extends JsonObject = JsonObject> {
  id: PluginId;
  version: SemVer;
  description?: string;
  handler: PluginHandler<TIn, TOut>;
}
