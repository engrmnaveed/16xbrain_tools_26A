/* ============================================================================
 * @16xbrains/gateway-client — src/index.ts
 * Host SDK: lazy connect, exponential backoff + jitter, circuit breaker,
 * typed discriminated results. Operational failures NEVER throw — every
 * outcome is a GatewayResult. Only programmer misuse throws synchronously.
 * ==========================================================================*/

import { Pool } from "undici";
import type {
  ExecuteOptions,
  FailureMode,
  GatewayClientOptions,
  GatewayResult,
  HealthStatus,
  JsonObject,
  PluginId,
  UnavailableResult,
} from "./types.js";

export * from "./types.js";

const DEFAULTS = {
  requestTimeoutMs: 5000,
  connect: { retries: 5, baseDelayMs: 100, maxDelayMs: 5000 },
  breaker: { threshold: 5, cooldownMs: 10_000 },
} as const;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fullJitter(base: number, factor: number, attempt: number, cap: number): number {
  const exp = Math.min(cap, base * Math.pow(factor, attempt));
  return Math.floor(Math.random() * exp);
}

type BreakerState = "closed" | "open" | "half-open";

export class Gateway {
  #opts: Required<Pick<GatewayClientOptions, "failureMode" | "requestTimeoutMs">> & GatewayClientOptions;
  #pool: Pool | null = null;
  #origin: string;
  #poolOpts: Pool.Options;
  #failureMode: FailureMode;

  // Circuit breaker.
  #breaker: BreakerState = "closed";
  #consecutiveFailures = 0;
  #openedAt = 0;

  constructor(options: GatewayClientOptions) {
    const hasSocket = typeof options.socket === "string" && options.socket.length > 0;
    const hasHostPort = typeof options.host === "string" && typeof options.port === "number";
    if (hasSocket === hasHostPort) {
      throw new TypeError("Gateway: provide exactly one of { socket } or { host, port }");
    }
    this.#failureMode = options.failureMode ?? "fail-closed";
    this.#opts = {
      ...options,
      failureMode: this.#failureMode,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    };

    if (hasSocket) {
      this.#origin = "http://localhost";
      this.#poolOpts = { socketPath: options.socket, connections: 4, pipelining: 1 };
    } else {
      const scheme = options.mtls ? "https" : "http";
      this.#origin = `${scheme}://${options.host}:${options.port}`;
      this.#poolOpts = options.mtls
        ? { connections: 4, connect: { ca: options.mtls.ca, cert: options.mtls.cert, key: options.mtls.key } }
        : { connections: 4 };
    }
  }

  #ensurePool(): Pool {
    if (!this.#pool) this.#pool = new Pool(this.#origin, this.#poolOpts);
    return this.#pool;
  }

  #connectOpts(): { retries: number; baseDelayMs: number; maxDelayMs: number } {
    return this.#opts.connect ?? DEFAULTS.connect;
  }
  #breakerOpts(): { threshold: number; cooldownMs: number } {
    return this.#opts.breaker ?? DEFAULTS.breaker;
  }

  #unavailable(payload: JsonObject, message: string): UnavailableResult {
    const res: UnavailableResult = { status: "unavailable", mode: this.#failureMode, message };
    if (this.#failureMode === "fail-open") res.passthrough = payload;
    return res;
  }

  /** Returns true if the breaker is open (and cooldown not yet elapsed). */
  #breakerBlocks(): boolean {
    if (this.#breaker === "open") {
      if (Date.now() - this.#openedAt >= this.#breakerOpts().cooldownMs) {
        this.#breaker = "half-open"; // allow a single probe
        return false;
      }
      return true;
    }
    return false;
  }

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#breaker = "closed";
  }

  #onFailure(): void {
    this.#consecutiveFailures += 1;
    if (this.#breaker === "half-open" || this.#consecutiveFailures >= this.#breakerOpts().threshold) {
      this.#breaker = "open";
      this.#openedAt = Date.now();
    }
  }

  async execute<TIn extends JsonObject = JsonObject, TOut extends JsonObject = JsonObject>(
    pluginId: PluginId,
    payload: TIn,
    options?: ExecuteOptions,
  ): Promise<GatewayResult<TOut>> {
    if (typeof pluginId !== "string") throw new TypeError("execute: pluginId must be a string");
    if (!isPlainObject(payload)) throw new TypeError("execute: payload must be a plain object");

    if (this.#breakerBlocks()) {
      return this.#unavailable(payload, "circuit breaker open") as GatewayResult<TOut>;
    }

    const body = JSON.stringify({
      pluginId,
      payload,
      ...(options?.pluginVersion ? { pluginVersion: options.pluginVersion } : {}),
      ...(options?.requestId ? { requestId: options.requestId } : {}),
    });

    const deadline = Date.now() + this.#opts.requestTimeoutMs;
    const { retries, baseDelayMs, maxDelayMs } = this.#connectOpts();

    let lastMessage = "gateway unavailable";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const pool = this.#ensurePool();
        const resp = await pool.request({
          path: "/v1/execute",
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          headersTimeout: remaining,
          bodyTimeout: remaining,
        });
        const text = await resp.body.text();
        let parsed: GatewayResult<TOut>;
        try {
          parsed = JSON.parse(text) as GatewayResult<TOut>;
        } catch {
          this.#onFailure();
          lastMessage = "malformed gateway response";
          continue;
        }
        // A parsed envelope means the gateway is alive — close the breaker.
        this.#onSuccess();
        return parsed;
      } catch (e) {
        this.#onFailure();
        lastMessage = (e as Error).message || "connect failure";
        if (this.#breaker === "open") break; // stop early once tripped
        const wait = fullJitter(baseDelayMs, 2, attempt, maxDelayMs);
        const sleepFor = Math.max(0, Math.min(wait, deadline - Date.now()));
        if (sleepFor > 0) await delay(sleepFor);
      }
    }
    return this.#unavailable(payload, lastMessage) as GatewayResult<TOut>;
  }

  async health(): Promise<HealthStatus> {
    try {
      const pool = this.#ensurePool();
      const resp = await pool.request({
        path: "/healthz",
        method: "GET",
        headersTimeout: this.#opts.requestTimeoutMs,
        bodyTimeout: this.#opts.requestTimeoutMs,
      });
      const text = await resp.body.text();
      return JSON.parse(text) as HealthStatus;
    } catch (e) {
      return { ok: false, version: "unknown", contractVersion: "unknown", uptimeSec: 0, pluginsActive: 0, ...({ message: (e as Error).message } as object) } as HealthStatus;
    }
  }

  async close(): Promise<void> {
    if (this.#pool) {
      const pool = this.#pool;
      this.#pool = null;
      await pool.close();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
