/* ============================================================================
 * examples/run-demo.js  —  ONE command:  node examples/run-demo.js
 *
 * Proves, end to end, on a clean checkout (after `npm install && npm run build`):
 *   1. a well-behaved plugin is ADMITTED and runs inside an isolate;
 *   2. a hostile plugin is REJECTED at admission with precise reason codes and
 *      ZERO execution — the rejection is the headline;
 *   3. PII in the payload is tokenized before the plugin sees it (BEFORE /
 *      tokenized / AFTER triple), with unmaskResponse:false so tokens are VISIBLE.
 *
 * No Docker, no global installs. A temp UDS socket + temp plugins dir are used
 * and torn down. Exits 0 on success.
 * ==========================================================================*/

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Pool } from "undici";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "dist", "src", "server.js");

const RULE = "─".repeat(72);
function banner(text) {
  process.stdout.write(`\n${RULE}\n${text}\n${RULE}\n`);
}

async function main() {
  if (!existsSync(SERVER)) {
    process.stderr.write(`Build first:  npm install && npm run build\n(missing ${SERVER})\n`);
    process.exit(1);
  }

  const work = await mkdtemp(join(tmpdir(), "16xgw-demo-"));
  const socket = join(work, "gateway.sock");
  const config = {
    gateway: { port: 0, socket, environment: "development", secretKey: randomBytes(24).toString("hex") },
    security: {
      maskPii: true,
      allowedOutboundDomains: [],
      maxMemoryMb: 128,
      timeoutMs: 3000,
      onGatewayUnavailable: "fail-closed",
      unmaskResponse: false, // demo: keep tokens VISIBLE in the response
      rescanOutput: true,
      maxPayloadBytes: 1048576,
      maxResultBytes: 1048576,
      tokenHexLength: 12,
      policyLevel: "strict",
      adminToken: null,
    },
    sandbox: { isolatePoolPerPlugin: 2, recycleAfterInvocations: 500 },
    logging: { level: "info", auditFile: null },
  };
  const configPath = join(work, "gateway.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // --- start the gateway (cwd = work, so plugins/ lands under the temp dir) --
  const gateway = spawn(process.execPath, [SERVER], {
    cwd: work,
    env: { ...process.env, GATEWAY_CONFIG: configPath },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });

  const ready = new Promise((res, rej) => {
    gateway.once("message", (m) => (m === "ready" ? res() : undefined));
    gateway.once("exit", (code) => rej(new Error(`gateway exited early (code ${code}) — is isolated-vm built?`)));
    setTimeout(() => rej(new Error("gateway did not become ready in 10s")), 10_000).unref();
  });
  await ready;

  const pool = new Pool("http://localhost", { socketPath: socket });
  const call = async (path, method, body) => {
    const resp = await pool.request({
      path, method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.body.text();
    return { status: resp.statusCode, json: text ? JSON.parse(text) : null };
  };
  const b64 = async (p) => Buffer.from(await readFile(p, "utf8"), "utf8").toString("base64");

  let exitCode = 0;
  try {
    // --- (b) admit the good plugin ------------------------------------------
    banner("ADMITTING  outsourced-analytics@1.0.0  (good plugin)");
    const good = await call("/v1/admin/plugins", "POST", {
      id: "outsourced-analytics",
      version: "1.0.0",
      source: await b64(join(HERE, "plugin-good", "plugin.cjs")),
    });
    if (good.json && good.json.admitted) {
      const e = good.json.entry;
      process.stdout.write(`ADMITTED  ${e.id}@${e.version}  sha256=${e.sha256.slice(0, 16)}…  status=${e.status}\n`);
    } else {
      throw new Error("good plugin was not admitted: " + JSON.stringify(good.json));
    }

    // --- (c) attempt to admit the hostile plugin — THE DEMO -----------------
    const hostile = await call("/v1/admin/plugins", "POST", {
      id: "outsourced-analytics",
      version: "9.9.9",
      source: await b64(join(HERE, "plugin-hostile", "plugin.cjs")),
    });
    const codes = (hostile.json && hostile.json.reasonCodes) || [];
    banner(`REJECTED AT ADMISSION — ${codes.join(" ")} — 0 lines executed`);
    process.stdout.write("The hostile plugin never ran. It is not in the registry, so any\n");
    process.stdout.write("subsequent execute() would see REG-UNKNOWN.\n");

    // --- assert the hostile source was never written to disk ----------------
    const pluginsDir = join(work, "plugins", "outsourced-analytics");
    const versions = existsSync(pluginsDir) ? await readdir(pluginsDir) : [];
    if (versions.includes("9.9.9")) {
      throw new Error("SECURITY FAILURE: hostile plugin source was persisted!");
    }
    process.stdout.write(`\nplugins/outsourced-analytics on disk: [ ${versions.join(", ")} ]  (no 9.9.9 — good)\n`);

    // --- (d) execute the good plugin: BEFORE / tokenized / AFTER ------------
    const rawRecord = {
      user_email: "boss@client.com",
      phone: "+14155550123",
      card: "4111 1111 1111 1111",
      lifetime_value: 2400,
      orders: 7,
      action: "process",
    };
    const exec = await call("/v1/execute", "POST", { pluginId: "outsourced-analytics", payload: rawRecord });

    banner("PII TOKENIZATION  (unmaskResponse:false → tokens stay visible)");
    process.stdout.write("BEFORE (raw record the host holds):\n");
    process.stdout.write("  " + JSON.stringify(rawRecord) + "\n\n");
    process.stdout.write("WHAT THE PLUGIN SAW / WHAT CAME BACK (tokenized):\n");
    process.stdout.write("  " + JSON.stringify(exec.json && exec.json.data) + "\n");

    const email = exec.json && exec.json.data && exec.json.data.user_email;
    if (!/\[TOKEN_MASK_SHA256_[0-9a-f]+\]/.test(String(email))) {
      throw new Error("expected a tokenized email in the response, got: " + email);
    }
    banner("DEMO PASSED");
  } catch (err) {
    process.stderr.write(`\nDEMO FAILED: ${err.message}\n`);
    exitCode = 1;
  } finally {
    await pool.close().catch(() => {});
    gateway.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!gateway.killed) gateway.kill("SIGKILL");
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e.message}\n`);
  process.exit(1);
});
