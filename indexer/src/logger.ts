import type { LogLevel } from "./config";
import { pushLog } from "./log-buffer";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function fmt(level: string, msg: string, meta?: object): string {
  const ts = new Date().toISOString();
  const suffix = meta ? " " + JSON.stringify(meta) : "";
  return `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
}

function emit(level: LogLevel, msg: string, meta?: object): void {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const line = fmt(level, msg, meta);
  switch (level) {
    case "debug": console.debug(line); break;
    case "info":  console.info(line);  break;
    case "warn":  console.warn(line);  break;
    case "error": console.error(line); break;
  }
  pushLog({ ts, level, msg, meta });
}

export const log = {
  debug: (msg: string, meta?: object) => emit("debug", msg, meta),
  info:  (msg: string, meta?: object) => emit("info",  msg, meta),
  warn:  (msg: string, meta?: object) => emit("warn",  msg, meta),
  error: (msg: string, meta?: object) => emit("error", msg, meta),
};
