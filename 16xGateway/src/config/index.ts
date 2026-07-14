/* ============================================================================
 * 16xGateway — src/config/index.ts
 * loadConfig(path?): strict, hand-rolled validation of gateway.config.json.
 * Unknown keys anywhere and wrong types are errors; ALL problems aggregate
 * into one Error message so the operator fixes the file in one pass.
 * ==========================================================================*/

import { readFileSync } from "node:fs";
import type { FailureMode, GatewayConfig, LogLevel, PolicyLevel } from "../types/index.js";

type Problems = string[];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: string[], where: string, out: Problems): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) out.push(`${where}: unknown key "${k}"`);
  }
}

function reqString(obj: Record<string, unknown>, key: string, where: string, out: Problems): string | null {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    out.push(`${where}.${key}: required non-empty string`);
    return null;
  }
  return v;
}

function optNumber(obj: Record<string, unknown>, key: string, def: number, where: string, out: Problems): number {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    out.push(`${where}.${key}: must be a finite number`);
    return def;
  }
  return v;
}

function optBoolean(obj: Record<string, unknown>, key: string, def: boolean, where: string, out: Problems): boolean {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== "boolean") {
    out.push(`${where}.${key}: must be a boolean`);
    return def;
  }
  return v;
}

function optEnum<T extends string>(obj: Record<string, unknown>, key: string, values: readonly T[], def: T, where: string, out: Problems): T {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    out.push(`${where}.${key}: must be one of ${values.join(" | ")}`);
    return def;
  }
  return v as T;
}

export function parseConfig(raw: unknown): GatewayConfig {
  const problems: Problems = [];
  if (!isObject(raw)) throw new Error("config: root must be a JSON object");

  unknownKeys(raw, ["gateway", "security", "sandbox", "logging"], "config", problems);

  // gateway ----------------------------------------------------------------
  const gw = isObject(raw.gateway) ? raw.gateway : {};
  if (!isObject(raw.gateway)) problems.push("config.gateway: required object");
  unknownKeys(gw, ["port", "socket", "environment", "secretKey"], "config.gateway", problems);
  const socket = reqString(gw, "socket", "config.gateway", problems);
  const secretKey = reqString(gw, "secretKey", "config.gateway", problems);
  if (secretKey !== null && secretKey.length < 32) {
    problems.push("config.gateway.secretKey: must be at least 32 chars");
  }
  const environment = optEnum(gw, "environment", ["production", "staging", "development"] as const, "production", "config.gateway", problems);
  if (gw["environment"] === undefined) problems.push("config.gateway.environment: required");
  const port = optNumber(gw, "port", 0, "config.gateway", problems);

  // security ---------------------------------------------------------------
  const sec = isObject(raw.security) ? raw.security : {};
  if (!isObject(raw.security)) problems.push("config.security: required object");
  unknownKeys(
    sec,
    [
      "maskPii", "allowedOutboundDomains", "maxMemoryMb", "timeoutMs",
      "onGatewayUnavailable", "unmaskResponse", "rescanOutput", "maxPayloadBytes",
      "maxResultBytes", "tokenHexLength", "policyLevel", "adminToken",
    ],
    "config.security",
    problems,
  );
  if (sec["maskPii"] !== true) {
    problems.push("config.security.maskPii: must be exactly true (bypass is unrepresentable)");
  }
  let allowedOutboundDomains: string[] = [];
  if (sec["allowedOutboundDomains"] === undefined) {
    allowedOutboundDomains = [];
  } else if (
    Array.isArray(sec["allowedOutboundDomains"]) &&
    (sec["allowedOutboundDomains"] as unknown[]).every((d) => typeof d === "string")
  ) {
    allowedOutboundDomains = sec["allowedOutboundDomains"] as string[];
  } else {
    problems.push("config.security.allowedOutboundDomains: must be an array of strings");
  }
  const maxMemoryMb = optNumber(sec, "maxMemoryMb", 128, "config.security", problems);
  const timeoutMs = optNumber(sec, "timeoutMs", 3000, "config.security", problems);
  const onGatewayUnavailable = optEnum(sec, "onGatewayUnavailable", ["fail-closed", "fail-open"] as const, "fail-closed", "config.security", problems) as FailureMode;
  const unmaskResponse = optBoolean(sec, "unmaskResponse", true, "config.security", problems);
  const rescanOutput = optBoolean(sec, "rescanOutput", true, "config.security", problems);
  const maxPayloadBytes = optNumber(sec, "maxPayloadBytes", 1_048_576, "config.security", problems);
  const maxResultBytes = optNumber(sec, "maxResultBytes", 1_048_576, "config.security", problems);
  const tokenHexLength = optNumber(sec, "tokenHexLength", 12, "config.security", problems);
  if (tokenHexLength < 6 || tokenHexLength > 32) {
    problems.push("config.security.tokenHexLength: must be between 6 and 32");
  }
  const policyLevel = optEnum(sec, "policyLevel", ["strict", "standard"] as const, "strict", "config.security", problems) as PolicyLevel;
  let adminToken: string | null = null;
  if (sec["adminToken"] === undefined || sec["adminToken"] === null) {
    adminToken = null;
  } else if (typeof sec["adminToken"] === "string") {
    adminToken = sec["adminToken"] as string;
  } else {
    problems.push("config.security.adminToken: must be a string or null");
  }

  // sandbox ----------------------------------------------------------------
  const sb = isObject(raw.sandbox) ? raw.sandbox : {};
  if (raw.sandbox !== undefined && !isObject(raw.sandbox)) problems.push("config.sandbox: must be an object");
  unknownKeys(sb, ["isolatePoolPerPlugin", "recycleAfterInvocations"], "config.sandbox", problems);
  const isolatePoolPerPlugin = optNumber(sb, "isolatePoolPerPlugin", 2, "config.sandbox", problems);
  const recycleAfterInvocations = optNumber(sb, "recycleAfterInvocations", 500, "config.sandbox", problems);

  // logging ----------------------------------------------------------------
  const lg = isObject(raw.logging) ? raw.logging : {};
  if (raw.logging !== undefined && !isObject(raw.logging)) problems.push("config.logging: must be an object");
  unknownKeys(lg, ["level", "auditFile"], "config.logging", problems);
  const level = optEnum(lg, "level", ["debug", "info", "warn", "error"] as const, "info", "config.logging", problems) as LogLevel;
  let auditFile: string | null = null;
  if (lg["auditFile"] === undefined || lg["auditFile"] === null) {
    auditFile = null;
  } else if (typeof lg["auditFile"] === "string") {
    auditFile = lg["auditFile"] as string;
  } else {
    problems.push("config.logging.auditFile: must be a string or null");
  }

  if (problems.length > 0) {
    throw new Error("Invalid gateway.config.json:\n  - " + problems.join("\n  - "));
  }

  return {
    gateway: {
      port,
      socket: socket as string,
      environment,
      secretKey: secretKey as string,
    },
    security: {
      maskPii: true,
      allowedOutboundDomains,
      maxMemoryMb,
      timeoutMs,
      onGatewayUnavailable,
      unmaskResponse,
      rescanOutput,
      maxPayloadBytes,
      maxResultBytes,
      tokenHexLength,
      policyLevel,
      adminToken,
    },
    sandbox: { isolatePoolPerPlugin, recycleAfterInvocations },
    logging: { level, auditFile },
  };
}

export function loadConfig(path?: string): GatewayConfig {
  const resolved = path ?? process.env["GATEWAY_CONFIG"] ?? "./gateway.config.json";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (e) {
    throw new Error(`config: cannot read/parse ${resolved}: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
