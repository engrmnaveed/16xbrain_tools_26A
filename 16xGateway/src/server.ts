/* ============================================================================
 * 16xGateway — src/server.ts
 * Fastify entrypoint. buildServer(deps) is exported for tests (use app.inject);
 * main() loads config, builds real deps, dual-listens (UDS + optional TCP),
 * and shuts down gracefully.
 * ==========================================================================*/

import http from "node:http";
import net from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { CONTRACT_VERSION } from "./types/index.js";
import type {
  AdmissionResult,
  GatewayConfig,
  HealthStatus,
  PluginRegistry,
  SandboxService,
} from "./types/index.js";
import { loadConfig } from "./config/index.js";
import { createSanitizer } from "./sanitizer/index.js";
import { createPolicyScanner } from "./policy/index.js";
import { createPluginRegistry } from "./registry/index.js";
import { createSandboxService } from "./sandbox/index.js";
import { createAuditWriter, type AuditWriter } from "./core/audit.js";
import { makeCapabilities } from "./core/capabilities.js";
import { executePipeline, type PipelineDeps } from "./core/pipeline.js";

const BUILD_VERSION = "1.0.0";
const TRANSPORT_HEADER = "x-16x-transport";

export interface ServerDeps {
  config: GatewayConfig;
  registry: PluginRegistry;
  sandbox: SandboxService;
  audit: AuditWriter;
  pipelineDeps: PipelineDeps;
  startedAt: number;
}

function arrivedViaUds(req: FastifyRequest): boolean {
  return req.headers[TRANSPORT_HEADER] === "uds";
}

function adminAllowed(req: FastifyRequest, config: GatewayConfig): boolean {
  if (arrivedViaUds(req)) return true;
  const token = config.security.adminToken;
  if (token !== null && req.headers["x-admin-token"] === token) return true;
  return false;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: deps.config.security.maxPayloadBytes + 65536 });

  // Unparseable JSON → rejected/GW-BADREQ envelope (HTTP 400, per §2.5).
  app.setErrorHandler((err, req, reply) => {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    if (code === 400) {
      reply.code(400).send({
        status: "rejected",
        reasonCodes: ["GW-BADREQ"],
        message: "unparseable request body",
        requestId: "n/a",
        pluginId: "?",
        pluginVersion: null,
        durationMs: 0,
        sanitized: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    reply.code(500).send({ status: "plugin_error", errorCode: "SBX-INTERNAL", message: "internal error" });
  });

  // ---- POST /v1/execute --------------------------------------------------
  app.post("/v1/execute", async (req, reply) => {
    const result = await executePipeline(deps.pipelineDeps, req.body);
    reply.code(200).send(result);
  });

  // ---- GET /healthz ------------------------------------------------------
  app.get("/healthz", async (_req, reply) => {
    let pluginsActive = 0;
    try {
      const list = await deps.registry.list();
      pluginsActive = list.filter((e) => e.status === "active").length;
    } catch {
      /* report zero */
    }
    const health: HealthStatus = {
      ok: true,
      version: BUILD_VERSION,
      contractVersion: CONTRACT_VERSION,
      uptimeSec: Math.round((Date.now() - deps.startedAt) / 1000),
      pluginsActive,
    };
    reply.code(200).send(health);
  });

  // ---- Admin routes ------------------------------------------------------
  app.register(async (admin) => {
    admin.addHook("preHandler", async (req, reply) => {
      if (!adminAllowed(req, deps.config)) {
        reply.code(403).send({ error: "admin access denied" });
      }
    });

    admin.post("/v1/admin/plugins", async (req, reply) => {
      const body = req.body as { id?: unknown; version?: unknown; source?: unknown };
      if (typeof body?.id !== "string" || typeof body?.version !== "string" || typeof body?.source !== "string") {
        reply.code(400).send({ admitted: false, reasonCodes: ["GW-BADREQ"] });
        return;
      }
      let source: string;
      try {
        source = Buffer.from(body.source, "base64").toString("utf8");
      } catch {
        reply.code(400).send({ admitted: false, reasonCodes: ["GW-BADREQ"] });
        return;
      }
      const result: AdmissionResult = await deps.registry.admit(source, body.id, body.version, "admin-api");
      reply.code(200).send(result);
    });

    admin.post("/v1/admin/plugins/:id/:version/revoke", async (req, reply) => {
      const { id, version } = req.params as { id: string; version: string };
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason : "revoked via admin api";
      const revoked = await deps.registry.revoke(id, version, reason);
      reply.code(200).send({ revoked });
    });

    admin.get("/v1/admin/plugins", async (_req, reply) => {
      reply.code(200).send(await deps.registry.list());
    });
  });

  return app;
}

/* --------------------------- dual-listen helpers -------------------------- */

/** Probe a UDS: resolves true if something is already listening (live). */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ path });
    const done = (live: boolean): void => {
      sock.destroy();
      resolve(live);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref?.();
  });
}

function transportHandler(app: FastifyInstance, transport: "uds" | "tcp"): http.RequestListener {
  return (req, res) => {
    // Strip any client-supplied transport header, then set it server-side so a
    // TCP client can never spoof UDS provenance for admin access.
    delete req.headers[TRANSPORT_HEADER];
    req.headers[TRANSPORT_HEADER] = transport;
    (app as unknown as { routing: http.RequestListener }).routing(req, res);
  };
}

export async function listen(app: FastifyInstance, config: GatewayConfig): Promise<() => Promise<void>> {
  await app.ready();

  const servers: http.Server[] = [];

  // UDS listener (always).
  if (existsSync(config.gateway.socket)) {
    if (await socketIsLive(config.gateway.socket)) {
      throw new Error(`another instance is already listening on ${config.gateway.socket}`);
    }
    await unlink(config.gateway.socket).catch(() => undefined);
  }
  const udsServer = http.createServer(transportHandler(app, "uds"));
  await new Promise<void>((resolve, reject) => {
    udsServer.once("error", reject);
    udsServer.listen(config.gateway.socket, resolve);
  });
  servers.push(udsServer);

  // Optional TCP loopback listener.
  if (config.gateway.port > 0) {
    const tcpServer = http.createServer(transportHandler(app, "tcp"));
    await new Promise<void>((resolve, reject) => {
      tcpServer.once("error", reject);
      tcpServer.listen(config.gateway.port, "127.0.0.1", resolve);
    });
    servers.push(tcpServer);
  }

  return async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    await unlink(config.gateway.socket).catch(() => undefined);
  };
}

/* ------------------------------- main ------------------------------------- */

export async function main(): Promise<void> {
  const config = loadConfig();
  const audit = createAuditWriter(config.logging.auditFile);
  const scanner = createPolicyScanner();
  const registry = createPluginRegistry({
    rootDir: "./plugins",
    scanner,
    policyLevel: config.security.policyLevel,
  });
  const sandbox = createSandboxService({
    memoryLimitMb: config.security.maxMemoryMb,
    timeoutMs: config.security.timeoutMs,
    isolatePoolPerPlugin: config.sandbox.isolatePoolPerPlugin,
    recycleAfterInvocations: config.sandbox.recycleAfterInvocations,
  });
  const sanitizer = createSanitizer(config.gateway.secretKey, config.security.tokenHexLength);

  const log = (level: string, message: string): void => {
    process.stdout.write(`[${level}] ${message}\n`);
  };

  const pipelineDeps: PipelineDeps = {
    config,
    sanitizer,
    registry,
    sandbox,
    audit: (ev) => audit.write(ev),
    makeCapabilities: (requestId, pluginId) =>
      makeCapabilities(config, requestId, pluginId, {
        log: (lvl, msg) => log(lvl, msg),
        audit: (ev) => audit.write(ev),
      }),
  };

  const deps: ServerDeps = { config, registry, sandbox, audit, pipelineDeps, startedAt: Date.now() };
  const app = buildServer(deps);
  const stop = await listen(app, config);

  log("info", `16xGateway listening on ${config.gateway.socket}` + (config.gateway.port > 0 ? ` and 127.0.0.1:${config.gateway.port}` : ""));
  // PM2 wait_ready handshake.
  process.send?.("ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `received ${signal}, draining…`);
    try {
      await stop();
      await app.close();
      await sandbox.disposeAll();
      await audit.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Run only when executed directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
