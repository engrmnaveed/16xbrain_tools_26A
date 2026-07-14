import cors from "cors";
import express, { Request, Response } from "express";
import fs from "fs";
import * as store from "./db";
import { LLMError, LLMService } from "./llm/LLMService";
import { buildRefactorPrompt } from "./prompt";
import { scanProject } from "./scanner";
import { ScanStatus } from "./types";

const PORT = Number(process.env.CODEGRAPH_PORT || 43917);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// Health & stats
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, version: "0.1.0", stats: store.getStats() });
});

// ---------------------------------------------------------------------------
// Scanning (async job + polled status)
// ---------------------------------------------------------------------------
const scanStatus: ScanStatus = {
  state: "idle",
  rootPath: null,
  totalFiles: 0,
  scannedFiles: 0,
  entityCount: 0,
  skippedUnchanged: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
};

app.post("/api/scan", (req: Request, res: Response) => {
  const { rootPath } = req.body as { rootPath?: string };
  if (!rootPath) return res.status(400).json({ error: "rootPath is required" });
  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory())
    return res.status(400).json({ error: `Not a directory: ${rootPath}` });
  if (scanStatus.state === "scanning")
    return res.status(409).json({ error: "A scan is already running" });

  Object.assign(scanStatus, {
    state: "scanning", rootPath, totalFiles: 0, scannedFiles: 0,
    entityCount: 0, skippedUnchanged: 0, error: null,
    startedAt: Date.now(), finishedAt: null,
  });

  scanProject(rootPath, (p) => Object.assign(scanStatus, p))
    .then((p) => {
      Object.assign(scanStatus, p, { state: "done", finishedAt: Date.now() });
    })
    .catch((err) => {
      scanStatus.state = "error";
      scanStatus.error = (err as Error).message;
      scanStatus.finishedAt = Date.now();
    });

  return res.status(202).json({ started: true });
});

app.get("/api/scan/status", (_req, res) => res.json(scanStatus));

// ---------------------------------------------------------------------------
// Search & entity detail
// ---------------------------------------------------------------------------
app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  return res.json(store.searchEntities(q));
});

app.get("/api/entity/:id", (req, res) => {
  const detail = store.getEntityDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: "Entity not found" });
  return res.json(detail);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
app.get("/api/settings", (_req, res) => res.json(store.getSettings()));

app.put("/api/settings", (req, res) => {
  store.saveSettings({ ...store.getSettings(), ...req.body });
  res.json(store.getSettings());
});

app.post("/api/llm/test", async (_req, res) => {
  const result = await new LLMService(store.getSettings()).testConnection();
  res.json(result);
});

// ---------------------------------------------------------------------------
// Refactor — streams tokens back over SSE
// ---------------------------------------------------------------------------
app.post("/api/refactor", async (req: Request, res: Response) => {
  const { entityId, instruction } = req.body as { entityId?: number; instruction?: string };
  if (!entityId || !instruction?.trim())
    return res.status(400).json({ error: "entityId and instruction are required" });

  const detail = store.getEntityDetail(Number(entityId));
  if (!detail) return res.status(404).json({ error: "Entity not found" });

  const prompt = buildRefactorPrompt(detail, instruction);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "prompt_meta", chars: prompt.length, deps: detail.dependencies.length });

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort(); // client disconnected mid-stream
  });

  try {
    const llm = new LLMService(store.getSettings());
    const full = await llm.generate(prompt, {
      signal: abort.signal,
      onToken: (token) => send({ type: "token", token }),
    });
    send({ type: "done", text: full });
  } catch (err) {
    const e = err as LLMError;
    send({ type: "error", message: e.message, kind: e.kind ?? "unknown", provider: e.provider });
  } finally {
    res.end();
  }
  return undefined;
});

// ---------------------------------------------------------------------------
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[codegraph-sidecar] listening on http://127.0.0.1:${PORT}`);
});
