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

// Resolved once, on first use, and cached — NOT re-read from process.env on
// every write() call. just-bash's defenseInDepth guard (enabled by default
// on any Bash instance) blocks process.env reads that occur while
// bash.exec() is running; the Jenkins VFS (see jenkins/vfs.ts) legitimately
// logs progress from inside lazy file providers / directory hydration
// callbacks, which run during bash.exec(). The very first logger call in
// this process always happens outside any sandboxed execution (e.g.
// buildJenkinsVfs's own "prefetching skeleton" log, which runs before
// bash.exec() is ever invoked), so caching here is safe and avoids tripping
// that guard on every later log line emitted mid-command.
let cachedLevel: Level | undefined;

function currentLevel(): Level {
  if (cachedLevel === undefined) {
    const envLevel = process.env.LOG_LEVEL as Level | undefined;
    cachedLevel = envLevel && LEVEL_ORDER.includes(envLevel) ? envLevel : "info";
  }
  return cachedLevel;
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
