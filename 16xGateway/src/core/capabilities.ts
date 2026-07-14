/* ============================================================================
 * 16xGateway — src/core/capabilities.ts
 * makeCapabilities(): the host-side capability bridge injected per request.
 *   - fetch: https-only, allowlisted hostnames, manual redirect re-checks,
 *     1 MiB body cap, 2 s per-call timeout. Deny-by-absence.
 *   - log: forwarded to the gateway logger, rate-limited to 100 lines/invocation.
 * ==========================================================================*/

import type {
  CapabilityFetchRequest,
  CapabilityFetchResponse,
  GatewayConfig,
  HostCapabilities,
  LogLevel,
  RequestId,
} from "../types/index.js";

const MAX_BODY = 1024 * 1024;
const FETCH_TIMEOUT_MS = 2000;
const MAX_REDIRECTS = 3;
const MAX_LOG_LINES = 100;

export interface CapabilityDeps {
  log: (level: LogLevel, message: string) => void;
  audit: (event: Record<string, unknown>) => void;
}

/** Hostname allowlist check. "*.d.com" matches subdomains but not "d.com". */
export function hostAllowed(hostname: string, allow: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const raw of allow) {
    const entry = raw.toLowerCase();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".d.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

export function makeCapabilities(
  config: GatewayConfig,
  requestId: RequestId,
  pluginId: string,
  deps: CapabilityDeps,
): HostCapabilities {
  const allow = config.security.allowedOutboundDomains;
  let logCount = 0;
  let logWarned = false;

  async function guardedFetch(req: CapabilityFetchRequest): Promise<CapabilityFetchResponse> {
    if (req.method !== "GET" && req.method !== "POST") {
      throw new Error(`EGRESS_DENIED: method ${req.method}`);
    }

    let currentUrl = req.url;
    let redirects = 0;

    while (true) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new Error(`EGRESS_DENIED: bad url`);
      }
      if (parsed.protocol !== "https:") {
        deps.audit({ type: "egress_denied", requestId, pluginId, hostname: parsed.hostname });
        throw new Error(`EGRESS_DENIED: ${parsed.hostname}`);
      }
      if (!hostAllowed(parsed.hostname, allow)) {
        deps.audit({ type: "egress_denied", requestId, pluginId, hostname: parsed.hostname });
        throw new Error(`EGRESS_DENIED: ${parsed.hostname}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(currentUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method === "POST" ? req.body : undefined,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (e) {
        throw new Error(`EGRESS_ERROR: ${(e as Error).name}`);
      } finally {
        clearTimeout(timer);
      }

      // Manual redirect handling with per-hop allowlist re-check.
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) throw new Error("EGRESS_ERROR: redirect without location");
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new Error("EGRESS_ERROR: too many redirects");
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }

      const buf = await readCapped(resp);
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: resp.status, headers, body: buf };
    }
  }

  return {
    fetch: guardedFetch,
    log(level: LogLevel, message: string): void {
      if (logCount >= MAX_LOG_LINES) {
        if (!logWarned) {
          logWarned = true;
          deps.log("warn", `[${pluginId}/${requestId}] log rate limit reached (100 lines)`);
        }
        return;
      }
      logCount += 1;
      deps.log(level, `[${pluginId}/${requestId}] ${message}`);
    },
  };
}

async function readCapped(resp: Response): Promise<string> {
  if (!resp.body) {
    const t = await resp.text();
    return t.length > MAX_BODY ? t.slice(0, MAX_BODY) : t;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        const merged = concat(chunks, MAX_BODY);
        return new TextDecoder().decode(merged);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], cap: number): Uint8Array {
  const out = new Uint8Array(Math.min(cap, chunks.reduce((a, c) => a + c.byteLength, 0)));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const room = out.length - off;
    const slice = c.byteLength > room ? c.subarray(0, room) : c;
    out.set(slice, off);
    off += slice.byteLength;
  }
  return out;
}
