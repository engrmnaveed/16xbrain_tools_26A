/* ============================================================================
 * examples/host-app/server.js
 * A tiny "CRM" host app that shows TWO integration patterns against the SAME
 * gateway instance:
 *   • Endpoint A — Pattern 1 (direct call):  POST /customers/:idx/enrich
 *   • Endpoint B — Pattern 2 (middleware):   POST /analyze
 *
 * Run standalone with:  GATEWAY_SOCKET=/path/to.sock node server.js
 * (The demo orchestrator sets GATEWAY_SOCKET and PORT for you.)
 * ==========================================================================*/

import Fastify from "fastify";
import { Gateway } from "@16xbrains/gateway-client";
import { fastifyGatewayHook } from "@16xbrains/gateway-client/middleware";

const SOCKET = process.env.GATEWAY_SOCKET;
const PORT = Number(process.env.PORT || 3001);
const PLUGIN_ID = "outsourced-analytics";

// In-memory customer records — realistic-but-fake PII, incl. one card number.
const customers = [
  { id: 1, name: "Ada Lovelace", user_email: "ada@analytical-engine.example", phone: "+14155550101", lifetime_value: 2400, orders: 7 },
  { id: 2, name: "Grace Hopper", user_email: "grace@navy.example", phone: "(202) 555-0148", lifetime_value: 640, orders: 4, card: "4111 1111 1111 1111" },
  { id: 3, name: "Alan Turing", user_email: "alan@bletchley.example", phone: "555-123-4567", lifetime_value: 120, orders: 1 },
];

const gateway = new Gateway({
  socket: SOCKET,
  // Demo: proceed without enrichment if the gateway is down, rather than failing
  // the request. In production choose based on your data-sensitivity posture.
  failureMode: "fail-open",
});

const app = Fastify({ logger: false });

// ---- Endpoint A — Pattern 1: explicit, per-call-site direct call ----------
app.post("/customers/:idx/enrich", async (request, reply) => {
  const idx = Number(request.params.idx);
  const record = customers[idx];
  if (!record) {
    reply.code(404).send({ error: "no such customer" });
    return;
  }
  const result = await gateway.execute(PLUGIN_ID, record);
  if (result.status === "success") {
    reply.code(200).send({ pattern: "direct-call", status: result.status, data: result.data });
    return;
  }
  if (result.status === "unavailable" && result.passthrough) {
    reply.code(200).send({ pattern: "direct-call", status: result.status, data: result.passthrough });
    return;
  }
  reply.code(502).send({ pattern: "direct-call", status: result.status });
});

// ---- Endpoint B — Pattern 2: middleware/hook, zero per-handler edits -------
app.addHook("preHandler", async (request, reply) => {
  if (request.routeOptions && request.routeOptions.url === "/analyze") {
    const hook = fastifyGatewayHook({ gateway, pluginId: PLUGIN_ID });
    await hook(request, reply);
  }
});
app.post("/analyze", async (request, reply) => {
  // By the time we get here, the middleware has already transformed request.body
  // through the plugin (or left it unchanged on fail-open).
  reply.code(200).send({ pattern: "middleware", data: request.body });
});

app.get("/healthz", async (_req, reply) => reply.send({ ok: true }));

const start = async () => {
  await app.listen({ host: "127.0.0.1", port: PORT });
  process.stdout.write(`host-app listening on http://127.0.0.1:${PORT}\n`);
  if (process.send) process.send("host-ready");
};

const shutdown = async () => {
  try {
    await gateway.close();
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("message", (m) => { if (m === "shutdown") void shutdown(); });

start().catch((e) => {
  process.stderr.write(`host-app fatal: ${e.message}\n`);
  process.exit(1);
});

export { customers };
