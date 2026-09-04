# jenkins-mcp

Ask why your build broke. Get an answer, not a 40,000-line log.

An **MCP server** and a **`jenkins` CLI** over one shared core. Same 11
capabilities on both, built for coding agents: compact output, honest counts,
and every result ends with the next command worth running.

```
$ jenkins build diagnose

team-a/api-service @ main #117  FAILURE
failedStage: Test
failedStep: sh mvn verify
failed tests (2)
class                      test                detail
com.example.api.RetryTest  retriesOn502        expected:<2> but was:<0>
com.example.api.RetryTest  givesUpAfterBudget  expected:<true> but was:<false>
log (failed step log, 152 bytes, from line 1):
1  + mvn -B verify
2  [ERROR] Tests run: 184, Failures: 2
3  [ERROR] com.example.api.RetryTest.retriesOn502: expected:<2> but was:<0>
4  script returned exit code 1
next: jenkins log with mode=step step=Test
next: jenkins build trigger to re-run once the cause is fixed
```

No job argument, no build number, no log spelunking. That is one command.

## Install

```bash
npm install -g @cuonghuunguyen/jenkins-cli    # the `jenkins` command
```

Then point it at your instance:

```bash
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=your-username
export JENKINS_API_TOKEN=your-api-token      # an API token, never your password

jenkins whoami                                # works? you're done
```

## Use it from an agent

**As an MCP server** — 11 tools:

```bash
claude mcp add jenkins \
  -e JENKINS_URL=https://ci.example.com \
  -e JENKINS_USER=your-username \
  -e JENKINS_API_TOKEN=your-api-token \
  -- npx -y @cuonghuunguyen/jenkins-mcp
```

For Claude Desktop or any other client, the equivalent JSON is in
[Configuration](docs/CONFIGURATION.md#mcp-client-configuration).

**As a skill** — teaches an agent to drive the CLI, works with Claude Code,
Cursor, Copilot and ~15 others:

```bash
npx skills add cuonghuunguyen/jenkins-mcp
```

Both is fine. The skill tells the agent to prefer the MCP tools when they are
already in the session.

## What it does

| | |
|---|---|
| `jenkins whoami` | Am I connected? |
| `jenkins jobs find [q]` | Which job builds this checkout? |
| `jenkins job` | Its parameters and last 10 builds |
| `jenkins build` | One build: status, cause, commits, stages, failed tests |
| `jenkins build diagnose` | **Why it failed.** Start here. |
| `jenkins log` | A bounded log window — tail, grep, range, step, or failed |
| `jenkins build trigger` | Start one (parameters validated first) |
| `jenkins build wait` | Block until it finishes |
| `jenkins build abort` | Stop one |
| `jenkins queue` | What is queued, and why it is stuck |
| `jenkins api get <path>` | Anything else, read-only |

Add `--json` to any of them for the raw structured result.

You usually do not pass a job. It is inferred from your git `origin` remote.

## Two things worth knowing

**It will not wreck anything.** Exactly two operations write — trigger and
abort. Everything else is GET-only, and a test asserts that rather than a
comment claiming it. `JENKINS_MCP_READONLY=1` removes the two write *tools*
from the MCP server entirely. No create, update or delete exists anywhere in
the codebase. → [Safety](docs/SAFETY.md)

**Logs will not blow up your context.** Every log read is a bounded window, and
a truncated result prints the exact call that returns the rest. `--save-to`
writes the full log to disk and hands back a summary instead of the body.

## Reference

- [Tools](docs/TOOLS.md) — all 11 MCP tools, parameters, real output
- [CLI](docs/CLI.md) — every command and flag
- [Configuration](docs/CONFIGURATION.md) — all environment variables
- [Safety](docs/SAFETY.md) — the full write surface and what guards it
- [Development](docs/DEVELOPMENT.md) — architecture, building from source
- [SETUP.md](SETUP.md) — step-by-step first run
- [AGENT-SETUP.md](AGENT-SETUP.md) — for an agent installing this for someone else

## Packages

| Package | What |
|---|---|
| [`@cuonghuunguyen/jenkins-cli`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-cli) | the `jenkins` command |
| [`@cuonghuunguyen/jenkins-mcp`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-mcp) | the MCP server |
| [`@cuonghuunguyen/jenkins-core`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-core) | the shared library |

Node 20+. MIT.
