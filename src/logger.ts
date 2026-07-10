// Single sanctioned logging surface for this project.
//
// Every log line is written to process.stderr and nowhere else. stdout is
// reserved exclusively for MCP JSON-RPC frames (MCP-01) — writing to stdout
// here (or anywhere else in src/) would corrupt the stdio transport.
//
// [ASSUMED] plain leveled JSON-lines writer, env-driven LOG_LEVEL (default
// "info") — sensible default per 01-CONTEXT.md "Claude's Discretion" (log
// format/level not separately discussed by the user).

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Level[] = ["debug", "info", "warn", "error"];

function currentLevel(): Level {
  const envLevel = process.env.LOG_LEVEL as Level | undefined;
  return envLevel && LEVEL_ORDER.includes(envLevel) ? envLevel : "info";
}

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(currentLevel())) {
    return;
  }
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  });
  // NEVER process.stdout.write / console.log here — stdout is reserved for
  // JSON-RPC frames (MCP-01).
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};
