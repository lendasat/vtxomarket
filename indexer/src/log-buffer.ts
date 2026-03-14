/**
 * In-memory ring buffer of recent log entries.
 * Exposed via GET /logs so the debug UI can poll it.
 */

export interface LogEntry {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  meta?: object;
}

const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];

export function pushLog(entry: LogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Return the last N entries (newest last). */
export function getRecentLogs(limit = 100): LogEntry[] {
  return entries.slice(-limit);
}
