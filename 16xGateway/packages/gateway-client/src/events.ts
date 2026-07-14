/* ============================================================================
 * @16xbrains/gateway-client/events — pattern 3 adapter.
 * attachGatewayConsumer: host emits requests, a consumer executes the plugin
 * and emits results. Concurrency capped; overflow queued FIFO.
 * ==========================================================================*/

import type { Gateway } from "./index.js";
import type { GatewayResult, JsonObject } from "./types.js";

export interface EmitterLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off?(event: string, listener: (payload: unknown) => void): unknown;
  removeListener?(event: string, listener: (payload: unknown) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}

export interface ConsumerOptions {
  gateway: Gateway;
  pluginId: string;
  requestEvent?: string;
  replyEvent?: string;
  concurrency?: number;
}

export interface ConsumerHandle {
  detach(): void;
}

interface Job {
  requestId: unknown;
  payload: JsonObject;
}

export function attachGatewayConsumer(emitter: EmitterLike, opts: ConsumerOptions): ConsumerHandle {
  const requestEvent = opts.requestEvent ?? "gateway:execute";
  const replyEvent = opts.replyEvent ?? "gateway:result";
  const cap = opts.concurrency ?? 10;

  const queue: Job[] = [];
  let inFlight = 0;

  const pump = (): void => {
    while (inFlight < cap && queue.length > 0) {
      const job = queue.shift()!;
      inFlight += 1;
      void opts.gateway
        .execute(opts.pluginId, job.payload)
        .then((result: GatewayResult) => {
          emitter.emit(replyEvent, { requestId: job.requestId, result });
        })
        .catch((e: unknown) => {
          // execute() never throws for operational failures; guard anyway.
          emitter.emit(replyEvent, {
            requestId: job.requestId,
            result: { status: "unavailable", mode: "fail-closed", message: String(e) },
          });
        })
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    }
  };

  const listener = (payload: unknown): void => {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as { requestId?: unknown; payload?: unknown };
    if (typeof p.payload !== "object" || p.payload === null || Array.isArray(p.payload)) return;
    queue.push({ requestId: p.requestId, payload: p.payload as JsonObject });
    pump();
  };

  emitter.on(requestEvent, listener);

  return {
    detach(): void {
      const off = emitter.off ?? emitter.removeListener;
      if (off) off.call(emitter, requestEvent, listener);
    },
  };
}
