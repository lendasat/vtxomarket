/**
 * Typed configuration loaded from environment variables.
 * All values validated at startup — fail fast rather than silently misconfiguring.
 */

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function optionalEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  return n;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function parseLogLevel(raw: string): LogLevel {
  if (LOG_LEVELS.includes(raw as LogLevel)) return raw as LogLevel;
  throw new Error(`Invalid LOG_LEVEL "${raw}". Must be one of: ${LOG_LEVELS.join(", ")}`);
}

export interface Config {
  arkServerUrl: string;
  network: string;
  port: number;
  logLevel: LogLevel;
  databasePath: string;
  sseReconnectDelayMs: number;
  outpointBatchSize: number;
}

export const config: Config = {
  arkServerUrl: requireEnv("ARK_SERVER_URL").replace(/\/$/, ""), // strip trailing slash
  network: optionalEnv("NETWORK", "unknown"),
  port: optionalEnvInt("PORT", 3001),
  logLevel: parseLogLevel(optionalEnv("LOG_LEVEL", "info")),
  databasePath: optionalEnv("DATABASE_PATH", "./data/indexer.db"),
  sseReconnectDelayMs: optionalEnvInt("SSE_RECONNECT_DELAY_MS", 3000),
  outpointBatchSize: optionalEnvInt("OUTPOINT_BATCH_SIZE", 50),
};
