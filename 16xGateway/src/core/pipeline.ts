/* ============================================================================
 * 16xGateway — src/core/pipeline.ts
 * executePipeline(): the security-critical orchestration spine (§1.1).
 * Step order is NORMATIVE. Sanitization (c) precedes sandbox (d) on every path;
 * reverseMap.destroy() is a finally obligation on success, timeout, error, and
 * thrown-internal paths alike.
 * ==========================================================================*/

import { randomUUID } from "node:crypto";
import type {
  GatewayConfig,
  GatewayResult,
  HostCapabilities,
  JsonObject,
  JsonValue,
  PiiCategory,
  PluginRegistry,
  ReasonCode,
  RejectedResult,
  ResultMeta,
  Sanitizer,
  SandboxService,
} from "../types/index.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export interface PipelineDeps {
  config: GatewayConfig;
  sanitizer: Sanitizer;
  registry: PluginRegistry;
  sandbox: SandboxService;
  audit: (ev: Record<string, unknown>) => void;
  /** Builds request-scoped capabilities (host injects the real one; tests stub). */
  makeCapabilities: (requestId: string, pluginId: string) => HostCapabilities;
}

function meta(
  requestId: string,
  pluginId: string,
  pluginVersion: string | null,
  durationMs: number,
): ResultMeta {
  return {
    requestId,
    pluginId,
    pluginVersion,
    durationMs,
    sanitized: true,
    timestamp: new Date().toISOString(),
  };
}

function rejected(
  base: ResultMeta,
  codes: ReasonCode[],
  message: string,
): RejectedResult {
  return { ...base, status: "rejected", reasonCodes: codes, message };
}

/** Deep-scan every string in a JSON value; replace PII spans with [REDACTED]. */
function rescan(
  value: JsonValue,
  sanitizer: Sanitizer,
  onHit: (category: PiiCategory) => void,
): JsonValue {
  if (typeof value === "string") {
    const spans = sanitizer.scan(value);
    if (spans.length === 0) return value;
    // Replace right-to-left.
    let out = value;
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i]!;
      onHit(s.category);
      out = out.slice(0, s.start) + "[REDACTED]" + out.slice(s.end);
    }
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => rescan(v, sanitizer, onHit));
  const obj: JsonObject = {};
  for (const k of Object.keys(value)) obj[k] = rescan(value[k] as JsonValue, sanitizer, onHit);
  return obj;
}

function byteLen(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
}

export async function executePipeline(
  deps: PipelineDeps,
  envelope: unknown,
): Promise<GatewayResult> {
  const { config, sanitizer, registry, sandbox, audit } = deps;
  const start = performance.now();
  const dur = (): number => Math.round(performance.now() - start);

  // ---- a. validate envelope ----------------------------------------------
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    const rid = randomUUID();
    audit({ type: "execute", requestId: rid, pluginId: "?", status: "rejected", durationMs: dur() });
    return rejected(meta(rid, "?", null, dur()), ["GW-BADREQ"], "envelope must be an object");
  }
  const env = envelope as Record<string, unknown>;
  const pluginId = env["pluginId"];
  const requestId = typeof env["requestId"] === "string" ? (env["requestId"] as string) : randomUUID();

  if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
    audit({ type: "execute", requestId, pluginId: "?", status: "rejected", durationMs: dur() });
    return rejected(meta(requestId, "?", null, dur()), ["GW-BADREQ"], "invalid pluginId");
  }
  const payload = env["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    audit({ type: "execute", requestId, pluginId, status: "rejected", durationMs: dur() });
    return rejected(meta(requestId, pluginId, null, dur()), ["GW-BADREQ"], "payload must be an object");
  }
  const payloadObj = payload as JsonObject;
  if (byteLen(payloadObj) > config.security.maxPayloadBytes) {
    audit({ type: "execute", requestId, pluginId, status: "rejected", durationMs: dur() });
    return rejected(meta(requestId, pluginId, null, dur()), ["GW-PAYLOAD-TOO-LARGE"], "payload too large");
  }
  const pinnedVersion = typeof env["pluginVersion"] === "string" ? (env["pluginVersion"] as string) : undefined;

  // ---- b. resolve plugin --------------------------------------------------
  const entry = await registry.resolve(pluginId, pinnedVersion);
  if (!entry) {
    // Distinguish revoked from unknown by scanning the full list.
    let code: ReasonCode = "REG-UNKNOWN";
    try {
      const all = await registry.list();
      const revoked = all.find(
        (e) => e.id === pluginId && (pinnedVersion ? e.version === pinnedVersion : true) && e.status === "revoked",
      );
      const anyActive = all.some((e) => e.id === pluginId && e.status === "active");
      if (revoked && !anyActive) code = "REG-REVOKED";
    } catch {
      /* keep REG-UNKNOWN */
    }
    audit({ type: "execute", requestId, pluginId, status: "rejected", durationMs: dur() });
    return rejected(meta(requestId, pluginId, null, dur()), [code], code === "REG-REVOKED" ? "plugin revoked" : "plugin unknown");
  }

  let source: string;
  try {
    source = await registry.loadVerifiedSource(entry);
  } catch (e) {
    const code = (e as { code?: string }).code === "REG-HASH-MISMATCH" ? "REG-HASH-MISMATCH" : "REG-HASH-MISMATCH";
    audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "rejected", durationMs: dur() });
    return rejected(meta(requestId, pluginId, entry.version, dur()), [code as ReasonCode], "stored source failed hash verification");
  }

  // ---- c. sanitize (ALWAYS) ----------------------------------------------
  const pass = sanitizer.sanitize(payloadObj, requestId);
  let destroyed = false;
  const destroy = (): void => {
    if (!destroyed) {
      destroyed = true;
      try {
        pass.reverseMap.destroy();
      } catch {
        /* idempotent */
      }
    }
  };

  try {
    // ---- d. sandbox run ---------------------------------------------------
    const capabilities = deps.makeCapabilities(requestId, pluginId);
    const outcome = await sandbox.run(
      source,
      entry.id,
      entry.version,
      pass.sanitizedPayload,
      requestId,
      capabilities,
    );

    // ---- e. map outcome ---------------------------------------------------
    if (!outcome.ok) {
      if (outcome.kind === "timeout") {
        audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "timeout", durationMs: outcome.durationMs, tokenCount: pass.matches.length });
        return { ...meta(requestId, pluginId, entry.version, outcome.durationMs), status: "timeout", timeoutMs: config.security.timeoutMs };
      }
      audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "plugin_error", errorCode: outcome.errorCode, durationMs: outcome.durationMs, tokenCount: pass.matches.length });
      return { ...meta(requestId, pluginId, entry.version, outcome.durationMs), status: "plugin_error", errorCode: outcome.errorCode, message: outcome.message };
    }

    // ---- f. result validation + rescan -----------------------------------
    let data = outcome.data;
    let roundTripped: JsonObject;
    try {
      roundTripped = JSON.parse(JSON.stringify(data)) as JsonObject;
    } catch {
      audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "plugin_error", errorCode: "SBX-RESULT-INVALID", durationMs: outcome.durationMs });
      return { ...meta(requestId, pluginId, entry.version, outcome.durationMs), status: "plugin_error", errorCode: "SBX-RESULT-INVALID", message: "result not JSON-serializable" };
    }
    if (byteLen(roundTripped) > config.security.maxResultBytes) {
      audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "plugin_error", errorCode: "SBX-RESULT-INVALID", durationMs: outcome.durationMs });
      return { ...meta(requestId, pluginId, entry.version, outcome.durationMs), status: "plugin_error", errorCode: "SBX-RESULT-INVALID", message: "result exceeds maxResultBytes" };
    }
    data = roundTripped;

    if (config.security.rescanOutput) {
      data = rescan(data, sanitizer, (category) => {
        audit({ type: "output_pii_redacted", requestId, pluginId, pluginVersion: entry.version, category });
      }) as JsonObject;
    }

    // ---- g. unmask --------------------------------------------------------
    let unmasked = false;
    if (config.security.unmaskResponse) {
      data = pass.reverseMap.restore(data);
      unmasked = true;
    }

    audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "success", durationMs: outcome.durationMs, tokenCount: pass.matches.length });
    return { ...meta(requestId, pluginId, entry.version, outcome.durationMs), status: "success", data, unmasked };
  } catch (e) {
    // ---- h. internal error -----------------------------------------------
    audit({ type: "execute", requestId, pluginId, pluginVersion: entry.version, status: "plugin_error", errorCode: "SBX-INTERNAL", durationMs: dur(), message: (e as Error).message });
    return { ...meta(requestId, pluginId, entry.version, dur()), status: "plugin_error", errorCode: "SBX-INTERNAL", message: "internal error" };
  } finally {
    // ---- i. finally: destroy reverse map on EVERY path -------------------
    destroy();
  }
}
