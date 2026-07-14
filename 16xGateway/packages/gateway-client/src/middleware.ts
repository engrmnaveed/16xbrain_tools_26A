/* ============================================================================
 * @16xbrains/gateway-client/middleware — pattern 2 adapters.
 * Route a whole class of requests through a plugin with zero per-callsite edits.
 * ==========================================================================*/

import type { Gateway } from "./index.js";
import type { GatewayResult, JsonObject } from "./types.js";

export interface MiddlewareOptions {
  gateway: Gateway;
  pluginId: string;
  /** When provided, it fully decides the response for non-success outcomes. */
  onResult?: (result: GatewayResult, req: unknown, res: unknown, next: (err?: unknown) => void) => void;
}

interface ExpressReq { body: unknown; }
interface ExpressRes {
  status(code: number): ExpressRes;
  json(payload: unknown): void;
}
type Next = (err?: unknown) => void;

/** Express-style middleware. */
export function gatewayMiddleware(opts: MiddlewareOptions) {
  return async (req: ExpressReq, res: ExpressRes, next: Next): Promise<void> => {
    const body = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      next();
      return;
    }
    const result = await opts.gateway.execute(opts.pluginId, body as JsonObject);
    if (result.status === "success") {
      req.body = result.data;
      next();
      return;
    }
    if (result.status === "unavailable" && result.passthrough) {
      // fail-open: leave body unchanged, proceed.
      next();
      return;
    }
    if (opts.onResult) {
      opts.onResult(result, req, res, next);
      return;
    }
    const payload: Record<string, unknown> = { status: result.status };
    if (result.status === "rejected") payload["reasonCodes"] = result.reasonCodes;
    res.status(502).json(payload);
  };
}

/* ------------------------------- Fastify ---------------------------------- */

interface FastifyRequest { body: unknown; }
interface FastifyReply {
  code(code: number): FastifyReply;
  send(payload: unknown): void;
}

/** Fastify preHandler hook with identical semantics. */
export function fastifyGatewayHook(opts: MiddlewareOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    const result = await opts.gateway.execute(opts.pluginId, body as JsonObject);
    if (result.status === "success") {
      request.body = result.data;
      return;
    }
    if (result.status === "unavailable" && result.passthrough) return;
    if (opts.onResult) {
      opts.onResult(result, request, reply, () => undefined);
      return;
    }
    const payload: Record<string, unknown> = { status: result.status };
    if (result.status === "rejected") payload["reasonCodes"] = result.reasonCodes;
    reply.code(502).send(payload);
  };
}
