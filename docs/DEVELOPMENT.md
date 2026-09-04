# Development

[← README](../README.md)

## Layout

pnpm workspace, turbo pipeline, three packages:

| Package | Contents |
|---------|----------|
| `packages/core` | Client, auth, cache, paths, errors, config, operations, formatters. Knows nothing about MCP, yargs or stdout. |
| `packages/mcp` | MCP adapter: zod input schemas, tool registration, stdio/HTTP transport. |
| `packages/cli` | yargs adapter: the `jenkins` command surface. |

```bash
pnpm build     # turbo run build
pnpm test      # turbo run test  (vitest: 478 tests across 35 files)
pnpm lint      # biome check packages/*/src
pnpm format    # biome format --write packages/*/src
```

## Why it is shaped this way

**Agent-ergonomic output** ([axi.md](https://axi.md/)). Every list is a compact
text table with at most four columns and a `shown of total` count; an empty
result prints an explicit empty-state line instead of nothing; a truncated
result names the exact call that returns the rest; every result ends with one
to three `next:` lines. Errors are a single structured line —
`error: <code> — <message>` — built only from an HTTP status plus an operation
label, so a token, crumb or cookie cannot reach the text.

**One process-wide, volatility-tiered cache.** A finished numbered build is
cached permanently, the job index for 60s, and anything running or queued for
10s. Trigger and abort invalidate the job's entries immediately, which is the
case a plain TTL gets wrong. The MCP server holds one cache for its lifetime; a
CLI process holds one for the duration of the command.

**One-request job index.** Folders, multibranch children, PR and tag jobs, and
each job's SCM remote URLs come back from a single nested `tree=` call, and the
depth cap is reported rather than assumed complete. That is what makes "find
the job that builds this checkout" one request instead of a crawl.

## Building from source

```bash
git clone https://github.com/cuonghuunguyen/jenkins-mcp.git
cd jenkins-mcp
pnpm install
pnpm build
```

This produces `packages/mcp/dist/index.js` and `packages/cli/dist/index.js`.
Point an MCP client at the first with `"command": "node"` and an absolute path.

To get `jenkins` on `PATH` from a checkout, install a wrapper rather than a
symlink — `tsc` emits `dist/index.js` without the executable bit, so a symlink
stops working after every rebuild:

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$PWD/packages/cli/dist/index.js" > ~/.local/bin/jenkins
chmod +x ~/.local/bin/jenkins
jenkins --version
```

## Architecture

**ARCH-03**: one capability is exactly one core operation + one core formatter
+ one MCP tool + one `jenkins` command. A core operation is
`(client, cache, args) => Promise<Data>` — it returns typed data or throws
`JenkinsError`, never pre-formatted text. A core formatter is pure,
`data => string`, and is where all agent-facing prose lives. An adapter handler
is a one-liner over those two. A branch in an adapter is a bug: it belongs in
core, where the other adapter gets it too.

Core writes next-step advice with placeholders (`{build}`, `{log}`, …) and each
adapter resolves them to its own vocabulary — `jenkins_build` for MCP,
`jenkins build` for the shell. A literal tool name or shell command emitted
from core is a bug.

See [VERIFICATION.md](../VERIFICATION.md) for what is and is not verified, and for
the live-instance checklist.
