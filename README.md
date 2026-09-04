# jenkins-mcp

An **MCP server** and a **`jenkins` CLI** over one shared core, pointed at a
single Jenkins instance. Both surfaces expose the same 11 capabilities — find
jobs, inspect a job/build/log/queue, diagnose a failure, trigger, wait, abort —
through the same operations and the same formatters, so a shell answer and a
tool answer are byte-identical apart from the `next:` vocabulary. It is built
for coding agents rather than for browsing Jenkins: output is compact, counted,
truncation-honest, and always ends with the next call worth making. The one
deliberate behavioural difference between the surfaces is the wait bound —
see [CLI](#cli).

- MCP entrypoint: `packages/mcp/dist/index.js` (stdio, or streamable HTTP)
- CLI entrypoint: `packages/cli/dist/index.js` (bin name `jenkins`)

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

## Requirements

- Node.js >= 20, pnpm 10
- A reachable Jenkins instance and an API token for the account to act as

## Installation

### From npm

```bash
npm install -g @cuonghuunguyen/jenkins-cli   # the `jenkins` CLI
npx -y @cuonghuunguyen/jenkins-mcp        # the MCP server (see client configuration below)
```

- [`@cuonghuunguyen/jenkins-cli`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-cli) — bin `jenkins`
- [`@cuonghuunguyen/jenkins-mcp`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-mcp) — bin `jenkins-mcp`
- [`@cuonghuunguyen/jenkins-core`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-core) — the shared library

With the CLI installed globally, skip the wrapper-script step below.

### From source

The git-`npx` path does not work for this repo: it is a pnpm workspace with no
`prepare` script. Clone and build.

```bash
git clone https://github.com/cuonghuunguyen/jenkins-mcp.git
cd jenkins-mcp
pnpm install
pnpm build
```

This produces `packages/mcp/dist/index.js` and `packages/cli/dist/index.js`.

To get `jenkins` on `PATH`, install a wrapper rather than a symlink — `tsc`
emits `dist/index.js` without the executable bit, so a symlink stops working
after every rebuild:

```bash
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$PWD/packages/cli/dist/index.js" > ~/.local/bin/jenkins
chmod +x ~/.local/bin/jenkins
jenkins --version    # 0.2.0
```

A step-by-step walkthrough — API token, client wiring, first call — is in
[SETUP.md](SETUP.md). Agents installing this into someone else's project should
follow [AGENT-SETUP.md](AGENT-SETUP.md).

### As an agent skill

[`skills/jenkins`](skills/jenkins/SKILL.md) teaches an agent to drive the CLI —
which command answers which question, how to diagnose a failure, how to read a
log without drowning. It installs with the
[skills](https://github.com/vercel-labs/skills) CLI and works with Claude Code,
Cursor, Copilot and ~15 other agents:

```bash
npx skills add cuonghuunguyen/jenkins-mcp
```

The skill drives the `jenkins` binary, so install `@cuonghuunguyen/jenkins-cli`
alongside it. If the MCP server is already configured in the session, the skill
tells the agent to prefer the tools over the subprocess.

## Client configuration (Claude Code / Claude Desktop)

Replace the placeholder values; never commit a real token.

```bash
# from npm
claude mcp add jenkins -- npx -y @cuonghuunguyen/jenkins-mcp

# from a source checkout
claude mcp add jenkins -- node /absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js
```

Equivalent JSON, for `.mcp.json` (Claude Code) or `claude_desktop_config.json`
(Claude Desktop):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "npx",
      "args": ["-y", "@cuonghuunguyen/jenkins-mcp"],
      "env": {
        "JENKINS_URL": "https://ci.example.com",
        "JENKINS_USER": "your-jenkins-username",
        "JENKINS_API_TOKEN": "your-jenkins-api-token"
      }
    }
  }
}
```

From a source checkout, use `"command": "node"` with the absolute path to
`packages/mcp/dist/index.js`. The path must be absolute: the host spawns the
server as a child process and does not resolve a relative path against this
repo.

## Tools

11 tools. **Exactly two write**: `jenkins_trigger_build` and
`jenkins_abort_build`. With `JENKINS_MCP_READONLY=1` those two are never
registered, leaving 9 — the tool does not exist rather than existing and
refusing, so an agent enumerating tools never sees a capability it cannot use.

Every job-addressed tool takes `job` (a Jenkins fullName, folders separated by
`/`) plus an optional `ref` and, where a build is involved, an optional
`build`. See [Addressing](#addressing).

The output blocks below are produced by the real formatters. The data behind
them is synthetic — no live Jenkins was available — so treat the values as
illustrative and the shape as exact.

### `jenkins_whoami`

No parameters. Confirms connectivity and which account the credentials resolve
to.

```
authenticated: svc-ci
fullName: CI Service Account
url: https://jenkins.example.com/user/svc-ci
next: jenkins_find_jobs to locate a job on this instance
```

### `jenkins_find_jobs`

| Parameter | Type | Notes |
|-----------|------|-------|
| `query` | string, optional | fullName substring, or a git remote URL. Omit to list the index. |
| `limit` | int, optional | Max rows, default 20. |

Pass the output of `git remote get-url origin` to find the job that builds the
current checkout.

`jenkins_find_jobs({ query: "api-service" })`:

```
jobs (4)
fullName                          type/status          lastBuild  age
team-a/api-service                multibranch/unknown  -          -
team-a/api-service/main           pipeline/success     #118       3h
team-a/api-service/PR-42          pipeline/failed      #7         1d
team-a/api-service/release%2F1.x  pipeline/success     #31        9d
next: jenkins_job to inspect one job's parameters and recent builds
next: jenkins_build to inspect a specific build
```

`lastBuild` and `age` are the pair that tells a live job from an abandoned one.
A folder, and a job that has never run, show `-` in both — no fabricated `#0`.

No match is an explicit empty state, not an error:

```
No jobs matched 'nope'
next: jenkins_find_jobs with a shorter query (6 jobs indexed)
```

### `jenkins_job`

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` | string, required | Job fullName. |
| `ref` | string, optional | Branch, tag or `PR-<n>`. |

Called on a multibranch parent or a folder with no `ref`, it lists that
container's children so you can pick one:

```
team-a/api-service  multibranch (3)
name         status   type
main         success  pipeline
PR-42        failed   pipeline
release/1.x  success  pipeline
next: jenkins_job with ref=<name> for one branch
next: jenkins_build with ref=<name> for its last build
```

Called on a job, it returns the build parameters and the last 10 builds:

```
team-a/api-service/main  pipeline  buildable
params (2)
name        type     default
DEPLOY_ENV  choice   staging (staging|prod)
SKIP_TESTS  boolean  false
builds (showing 3 of 118)
#    result   age  duration
118  SUCCESS  3h   6m52s
117  FAILURE  1d   6m17s
116  SUCCESS  3d   6m41s
next: jenkins_build to inspect a build
next: jenkins_log to read a build log
next: jenkins_trigger_build to start a build
```

### `jenkins_build`

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` | string, required | |
| `ref` | string, optional | |
| `build` | number or string, optional | Number, `-1`, or a permalink alias. Defaults to `lastBuild`. |

One call for status, cause, parameters, changeset commits, pipeline stages,
failed steps and failed tests. Stage and test data are omitted explicitly when
the build is not a pipeline or published no test report.

`jenkins_build({ job: "team-a/api-service", ref: "main", build: 117 })`:

```
team-a/api-service @ main #117  FAILURE  6m17s  438d ago
cause: Started by GitHub push by alice
params (2)
name          value
DEPLOY_ENV    staging
DEPLOY_TOKEN  [redacted]
commits (2)
commit   author    message
9f2c1ab  Alice Ng  Tighten retry budget on the upstream call
41ba77c  Bob Ray   Add regression test for the 502 path
stages (3)
stage     status   duration
Checkout  SUCCESS  4.2s
Build     SUCCESS  2m01s
Test      FAILED   4m00s
failed steps (1)
Test — see jenkins_log with mode=step step=Test
failed tests (2)
class                      test                detail
com.example.api.RetryTest  retriesOn502        expected:<2> but was:<0>
com.example.api.RetryTest  givesUpAfterBudget  expected:<true> but was:<false>
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/117/
next: jenkins_log with mode=failed for the failure context
next: jenkins_diagnose_build for a root-cause summary
```

A parameter whose Jenkins class matches `Password|Secret|Credentials` is
redacted in the returned data, not just in the text.

### `jenkins_log`

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` / `ref` / `build` | | as above |
| `mode` | `tail` \| `grep` \| `range` \| `step` \| `failed` | Default `tail`. |
| `lines` | int | `mode=tail`: trailing lines, default 100. |
| `pattern` | string | `mode=grep`: regex. Required for that mode. |
| `context` | int | `mode=grep`: context lines each side, default 2. `mode=failed`: lines each side of the failure anchor, default 60 before / 20 after. |
| `max_matches` | int | `mode=grep`: stop scanning after this many matches, default 200. The result says whether the scan stopped early — not the same fact as the log having only that many matches. |
| `from` / `to` | int | `mode=range`: 1-based inclusive line range. Negative is end-relative: `from=-100 to=-1` is the last 100 lines. |
| `step` | string | `mode=step`: the pipeline stage name. |
| `clean` | boolean | Strip ANSI escapes and Jenkins timestamp prefixes. Default true. |
| `cursor` | int | Byte offset from a previous call — returns only what was written since. |
| `save_to` | string | Write the full RAW log to a file under the cwd and return a summary instead of the body. Empty string means `.jenkins-mcp/cli/<job>/<ref>/<build>.log`. Mutually exclusive with `cursor`. |

Lines are numbered as in the full log, so a follow-up `mode=range` addresses
the right lines.

`jenkins_log({ job, ref: "main", build: 117, mode: "tail", lines: 8 })`:

```
team-a/api-service/main #117 log  mode=tail  lines 417-424 of 424
417  line 417 of the build log
418  line 418 of the build log
419  line 419 of the build log
420  line 420 of the build log
421  [ERROR] Tests run: 184, Failures: 2
422  [ERROR] com.example.api.RetryTest.retriesOn502: expected:<2> but was:<0>
423  BUILD FAILURE
424  Finished: FAILURE
next: jenkins_log with mode=grep pattern=ERROR to search the whole log
next: jenkins_build for the failure summary
```

`mode=grep` states its own bound, and whether it hit it:

```
team-a/api-service/main #117 log  mode=grep  200+ match(es) — scan stopped at max_matches=200 after 3180 of 4200 lines, showing 3 of 4200 lines
4102  [ERROR] Tests run: 184, Failures: 2
4103  [ERROR] com.example.api.RetryTest.retriesOn502: expected:<2> but was:<0>
4104  BUILD FAILURE
next: jenkins_log with mode=range around a hit for its surrounding lines
next: jenkins_build for the failure summary
```

`save_to: ""` uses the default destination
`.jenkins-mcp/cli/<job>/<ref>/<build>.log`. The job path becomes **real nested
directories** — `team-a/api-service` is two of them, not `team-a-api-service`.
A component that decodes to `..`, to an absolute path, or to nothing is
rejected rather than sanitized. The summary carries `firstFailureLine`, the
first line matching an anchored failure signal, and the follow-up call is a
`mode=range` window around it:

```
team-a/api-service/main #117 log  saved: .jenkins-mcp/cli/team-a/api-service/main/117.log  225692 bytes  4200 lines  firstFailureLine: 4103
next: jenkins_log with mode=range from=4083 to=4143 for the failure
next: jenkins_log with mode=grep pattern=ERROR to search the build without re-reading it
next: jenkins_build for the failure summary
```

No anchored failure line found is stated explicitly rather than left blank —
a green build is a real answer, and the scan is deliberately too narrow to
guess.

`cursor` and `save_to` are mutually exclusive: saving one chunk over the full
log is rejected rather than silently truncating the file.

### `jenkins_queue`

No parameters. Instance-wide. The state column is derived by priority (a stuck
item is also buildable), so exactly one actionable state is shown.

```
queue (2)
job                      state      waiting  why
team-a/nightly-e2e       blocked    20.0s    Build #118 is already in progress
team-a/api-service/main  buildable  1m35s    Waiting for next available executor on 'linux-agent-3'
next: jenkins_build to inspect a running build
next: jenkins_abort_build to cancel a running build
```

Empty is explicit:

```
No queued items found
next: jenkins_find_jobs to locate a job, then jenkins_trigger_build to start a build
```

### `jenkins_api_get`

| Parameter | Type | Notes |
|-----------|------|-------|
| `path` | string, required | Must start with `/`. An absolute URL, a `//host` form, a `..` segment or an embedded query string is rejected. |
| `tree` | string, optional | Jenkins `tree=` projection. **Required** when the path ends in `api/json`, `api/xml` or `api/python`. |
| `max_bytes` | int, optional | Body budget, default 65536. |

The escape hatch for endpoints the typed tools do not cover. GET only — it can
never write.

```
api: /job/team-a/job/api-service/job/main/config.xml (application/xml, 205 bytes)
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job@1400">
  <description>Pipeline for the API service</description>
  <keepDependencies>false</keepDependencies>
</flow-definition>
next: jenkins_find_jobs / jenkins_job / jenkins_build for a typed view of the same data
```

### `jenkins_wait_build`

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` / `ref` / `build` | | as above |
| `timeout_s` | number, optional | Seconds before giving up. **Default 120 on MCP**; the CLI's `jenkins build wait` is unbounded unless `--timeout` is given. A non-numeric value falls back to the default rather than removing the bound. |
| `since_cursor` | string, optional | Stage id from a previous wait's `since_cursor:` line. Stage transitions are reported from that stage onward instead of repeating the whole pipeline. |
| `log_cursor` | int, optional | Byte offset from a previous wait's `log_cursor:` line or from `jenkins_log`. The log lines written since it come back with the result. |

Polls `wfapi/describe` with exponential backoff (2s → 15s, ×1.5), falling back
to `api/json` for a freestyle build or an instance with no Pipeline REST API
plugin. It **always returns** — on completion, on the timeout, on the abort
signal, or as soon as a stage pauses on an `input` step, which never finishes
on its own because a human has to answer it. Read-only, so it stays registered
in read-only mode: watching is not controlling.

Both cursors are returned so the next call is a delta rather than a repeat:

```
build: team-a/api-service @ main #118
status: FAILURE
duration: 6m38s
waited: 3m34s (19 polls)
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/118/
since_cursor: 27
log_cursor: 225692
stages (3)
id  stage     status   duration
6   Checkout  SUCCESS  4.2s
12  Build     SUCCESS  2m01s
27  Test      FAILED   4m00s
new log lines (since the byte cursor) (3)
[ERROR] Tests run: 184, Failures: 2
BUILD FAILURE
Finished: FAILURE
next: jenkins_diagnose_build to isolate the failure
next: jenkins_log with mode=failed for the failing lines
```

A pipeline blocked on an `input` step is its own state, and the hints say what
actually unblocks it — waiting longer does not:

```
build: team-a/api-service @ main #119
status: PAUSED — waiting for input at stage 'Deploy to prod'
waited: 38.0s (6 polls)
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/119/
since_cursor: 31
stages (1)
id  stage           status                duration
31  Deploy to prod  PAUSED_PENDING_INPUT  -
next: a human must answer the input step in the Jenkins UI
next: jenkins_abort_build to stop the build instead
next: jenkins_wait_build again once the input has been given
```

"No stage data at all" and "a pipeline that has started no stage yet" are
different lines, so a freestyle build is never read as a pipeline that did
nothing:

```
build: team-a/nightly-e2e #512
status: SUCCESS
duration: 1m05s
waited: 1m02s (8 polls)
stages: none (no Pipeline REST API for this build)
next: jenkins_log to read the console log
```

### `jenkins_diagnose_build`

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` / `ref` / `build` | | as above |

Names the failed stage and step via `wfapi`, lists the failed JUnit tests, and
returns the failed step's own log — falling back to the console tail only when
neither is available. Works on freestyle builds (no stage attribution, but
still tests and a console tail). Read-only.

```
team-a/api-service @ main #117  FAILURE
failedStage: Test
failedStep: sh mvn verify
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/117/
failed tests (2)
class                      test                detail
com.example.api.RetryTest  retriesOn502        expected:<2> but was:<0>
com.example.api.RetryTest  givesUpAfterBudget  expected:<true> but was:<false>
log (failed step log, 152 bytes, from line 1):
1  + mvn -B verify
2  [ERROR] Tests run: 184, Failures: 2
3  [ERROR] com.example.api.RetryTest.retriesOn502: expected:<2> but was:<0>
4  script returned exit code 1
next: jenkins_log with mode=step step=Test
next: jenkins_trigger_build to re-run once the cause is fixed
```

A freestyle build has no stage attribution, so the region is a console tail —
and it is numbered from where it was actually cut, not from 1, so a line
number read out of a diagnosis addresses the right part of the log. The tail
is byte-capped from the **end**, because the failure is at the end:

```
team-a/nightly-e2e #512  FAILURE
no stage data (not a pipeline build)
url: https://jenkins.example.com/job/team-a/job/nightly-e2e/512/
no test report
log (console tail, 132 bytes, from line 2871):
2871  + ./run-e2e.sh
2872  FAILED: checkout timed out after 600s
2873  Build step 'Execute shell' marked build as failure
2874  Finished: FAILURE
next: jenkins_log with mode=tail lines=500 for a wider window
next: jenkins_trigger_build to re-run once the cause is fixed
```

### `jenkins_trigger_build` — WRITES

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` | string, required | |
| `ref` | string, optional | |
| `params` | object of string→string, optional | Build parameters. |
| `timeout` | number, optional | Seconds to wait for a real build number, default 15. |
| `rebuild_from` | number or string, optional | Reuse that build's parameters as the base map; `params` overrides individual keys. |
| `wait` | boolean, optional | Block until the new build finishes; the wait result is appended. |
| `wait_timeout_s` | number, optional | Seconds to block when `wait` is true. **Default 120 on MCP**; the CLI's `--wait-timeout` is unbounded by default. |

Parameters are validated against the job's declared `parameterDefinitions`
*before* the POST, so a misspelled name is an error instead of the silent
ignore Jenkins would perform. The queue item is polled to a real build number;
the raw queue id is never returned as a build number, and the `next:` lines
name that resolved number so the caller never has to guess which build the
trigger produced.

```
started: team-a/api-service @ main #119
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/119/
params: DEPLOY_ENV=staging
next: jenkins_wait_build on #119 to follow this build to completion
next: jenkins_log on #119 to read the log as it runs
```

`rebuild_from` states what it inherited rather than silently reusing it:

```
started: team-a/api-service @ main #119
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/119/
params: DEPLOY_ENV=prod SKIP_TESTS=false
inherited: SKIP_TESTS
next: jenkins_wait_build on #119 to follow this build to completion
next: jenkins_log on #119 to read the log as it runs
```

If the POST succeeded but anything after it failed — the chained `wait`, a
follow-up read — the resolved build number is still reported, because an agent
told only "HTTP 404" would reasonably trigger a second, duplicate build:

```
started: team-a/api-service @ main #119
url: https://jenkins.example.com/job/team-a/job/api-service/job/main/119/
params: DEPLOY_ENV=staging
warning: the build was started but could not be followed — not_found — Jenkins returned 404 Not Found for "jenkins_wait_build"
next: jenkins_wait_build on #119 to try following it again
next: jenkins_build #119 to check its state
next: do NOT re-trigger: the build above is already running
```

If the bounded wait for a build number elapses first, the result is the queue
item — a `queueId`, explicitly not a build number:

```
queued: team-a/api-service @ main
queueId: 8823
why: Waiting for next available executor on 'linux-agent-3'
params: DEPLOY_ENV=staging
next: jenkins_queue to see what the queue is waiting on
next: jenkins_job to check whether it has started since
```

Validation failure:

```
error: invalid_input — Unknown build parameter 'DEPLOY_EVN'. This job declares: DEPLOY_ENV, SKIP_TESTS.
```

### `jenkins_abort_build` — WRITES

| Parameter | Type | Notes |
|-----------|------|-------|
| `job` / `ref` / `build` | | `build` defaults to `-1`. |

Graceful abort — the same effect as the Abort button. Never escalates to
`/term` or `/kill`. Drops the job's cached entries so the next read is not the
pre-abort state.

```
aborted: team-a/api-service @ main #119
next: jenkins_build to confirm the build reached ABORTED
```

## CLI

One command per tool. `jenkins --help` and `jenkins <command> --help` are the
authoritative reference.

| Command | Tool | Command-specific options |
|---------|------|--------------------------|
| `jenkins whoami` | `jenkins_whoami` | — |
| `jenkins jobs find [query]` | `jenkins_find_jobs` | `--limit` (20), `--all` |
| `jenkins job [ref]` | `jenkins_job` | — |
| `jenkins build [build]` | `jenkins_build` | `--ref` |
| `jenkins log [build]` | `jenkins_log` | `--ref --mode --lines --pattern --context --max-matches --from --to --step --clean/--no-clean --cursor --save-to` |
| `jenkins queue` | `jenkins_queue` | — |
| `jenkins api get <path>` | `jenkins_api_get` | `--tree`, `--max-bytes` |
| `jenkins build wait [build]` | `jenkins_wait_build` | `--ref --timeout --since-cursor --log-cursor` |
| `jenkins build diagnose [build]` | `jenkins_diagnose_build` | `--ref` |
| `jenkins build trigger` | `jenkins_trigger_build` | `--ref --param NAME=VALUE (repeatable) --rebuild-from --wait --timeout --wait-timeout` |
| `jenkins build abort [build]` | `jenkins_abort_build` | `--ref` |

`JENKINS_MCP_READONLY` gates the **MCP server only**. The CLI always has
`build trigger` and `build abort`; a shell already has a user behind it.

**Waits differ by surface on purpose.** `jenkins build wait` and
`jenkins build trigger --wait` are **unbounded** unless `--timeout` /
`--wait-timeout` is given, and Ctrl-C ends the wait and prints what it knows —
build number, elapsed time, stages so far — rather than killing the process
mid-poll. The MCP tools default to 120s, because an agent cannot press Ctrl-C.

**The CLI does not stream.** Stage transitions and new log lines are returned
when the wait **ends**, not printed as they happen. For live progress, poll:
`jenkins build wait --timeout 30 --since-cursor <id> --log-cursor <n>` in a
loop, feeding each call the cursors the previous one printed.

Known defect: `--help` on a nested subcommand (`jenkins build wait --help`)
prints the root help instead of that subcommand's. `jenkins build --help`
lists the subcommands; the option lists above come from the source.

### Global options

| Option | Effect |
|--------|--------|
| `-j, --job` | Job fullName. Overrides everything else. |
| `--json` | Emit the operation's raw structured result as JSON instead of formatted text. |
| `--url` | Overrides `JENKINS_URL`. |
| `--user` | Overrides `JENKINS_USER`. |
| `--token` | Overrides `JENKINS_API_TOKEN`. |

### Job resolution

`--job`, then `JENKINS_JOB`, then the git `origin` remote of the current
checkout matched against the job index's SCM remote URLs. Only a real SCM-URL
match counts for the remote path — a coincidental fullName match cannot
silently select the wrong job. Not a git repo, no `origin`, no match, or more
than one match each produce one actionable error naming `--job`.

### `--json`

Every command funnels through the same emitter, so `--json` is uniformly
available and returns the operation's own value — not a re-parse of the text.
`jenkins jobs find api-service --json`:

```json
{
  "query": "api-service",
  "matches": [
    {
      "fullName": "team-a/api-service",
      "type": "multibranch",
      "status": "unknown",
      "scmUrls": [
        "ssh://git@git.example.com/team-a/api-service.git"
      ],
      "depth": 2
    },
    {
      "fullName": "team-a/api-service/main",
      "type": "pipeline",
      "status": "success",
      "scmUrls": [],
      "depth": 3,
      "lastBuild": {
        "number": 118,
        "timestamp": 1756000000000,
        "result": "SUCCESS"
      }
    }
  ],
  "matched": 2,
  "total": 3,
  "depthCap": 6,
  "droppedFolders": []
}
```

Errors go to stderr as one line and the process exits non-zero:

```
error: auth_failed — Authentication failed calling Jenkins for "jenkins_whoami" (401 Unauthorized). Check that JENKINS_USER and JENKINS_API_TOKEN are set correctly and that the API token has not expired or been revoked.
```

## Addressing

| Field | Accepts | Notes |
|-------|---------|-------|
| `job` | Jenkins fullName, e.g. `team-a/api-service` | `/` separates folder levels. Discover it with `jenkins_find_jobs`, including by git remote URL. |
| `ref` | `main`, `feature/foo`, `release/1.x`, `PR-42`, `42` | A branch, tag or PR of a multibranch parent. Pass it raw — it is URL-encoded for you. A bare integer means `PR-<n>`, and only on a multibranch job; that normalization is the same in **all seven** ref-taking tools (`jenkins_job`, `jenkins_build`, `jenkins_log`, `jenkins_wait_build`, `jenkins_diagnose_build`, `jenkins_trigger_build`, `jenkins_abort_build`), so `ref="42"` addresses `PR-42` everywhere or nowhere. Omit for a plain job. |
| `build` | `117`, `-1`, `lastBuild` | Permalink aliases: `lastBuild`, `lastCompletedBuild`, `lastSuccessfulBuild`, `lastStableBuild`, `lastFailedBuild`, `lastUnsuccessfulBuild`. `-1` and an omitted value both mean `lastBuild`. |

## Configuration

Environment only. No config file, no dotenv auto-loading. On missing or
malformed required config the MCP server writes an actionable message naming
the offending field to stderr and exits non-zero; the CLI prints one
`error: invalid_input` line and exits 1.

| Variable | Required | Default | Effect |
|----------|----------|---------|--------|
| `JENKINS_URL` | yes | — | Instance base URL, e.g. `https://ci.example.com` (no trailing slash). |
| `JENKINS_USER` | yes | — | Username the API token belongs to. |
| `JENKINS_API_TOKEN` | yes | — | Per-user API token. Never the account password. |
| `JENKINS_INDEX_DEPTH` | no | `6` | Nesting depth of the one-request job index. Clamped to >= 1; junk falls back to the default. |
| `JENKINS_REQUEST_TIMEOUT_MS` | no | `60000` | Per-request timeout. Clamped to >= 1; junk falls back to the default. |
| `JENKINS_MCP_READONLY` | no | unset | `1` or `true` (case-insensitive) unregisters the two write tools. Anything else, including junk, is false — the flag is opt-in and a misspelling must not stop the server booting. **MCP server only.** |
| `JENKINS_JOB` | no | unset | CLI only: the job to use when `--job` is omitted. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. Logs go to stderr; token, crumb and cookie values are always redacted. |
| `MCP_HTTP_PORT` | no | unset | MCP server only: serve streamable HTTP on this port instead of stdio. `--http` alone means port 3000. |

## Safety

- **The write surface is three endpoints.** `POST /job/<path>/build`,
  `POST /job/<path>/buildWithParameters`, and `POST /job/<path>/<n>/stop`.
  Nothing else in the codebase issues a mutating request, and a test walks the
  whole write surface to assert it.
- **Two tools write, and only those two issue a non-GET request at all.** No
  qualification. `jenkins_whoami` used to POST to `/me/api/json` to exercise
  the crumb round-trip, and it is registered in read-only mode, so the claim
  was false on the first call an agent makes; it now GETs. The assertion is
  **behavioural**, not a name comparison: the safety test invokes every
  read-only tool's operation against a client whose `post` fails the test if it
  is called. The name-list version of that assertion could not have caught the
  whoami POST, and did not.
- **`JENKINS_MCP_READONLY=1` unregisters both write tools**, leaving 9 that
  reach zero POST endpoints — asserted in both modes rather than documented and
  hoped for.
- **No create, update or delete.** The server cannot make, edit or remove a
  job, a credential, a view, a node or any configuration. `/term` and `/kill`
  are never constructed.
- **`jenkins_api_get` is GET-only and validated.** An absolute URL, a
  protocol-relative `//host`, a `..` segment in any encoding, and an embedded
  query string are all rejected — the client carries an `Authorization`
  header, so an absolute URL would be an SSRF that leaks credentials. `tree=`
  is mandatory for `api/json`, `api/xml` and `api/python`, checked against the
  path a servlet container would actually route, so `/queue/api//json` and
  `/queue/api/json;x=y` cannot smuggle an unprojected read past it.
- **`save_to` is contained to the cwd.** Absolute paths, `..` traversal, a
  symlinked directory whose real target is outside the cwd, and a hardlink to
  a file outside the cwd are all rejected before anything is written.
- **Errors carry no secrets by construction.** An error message is built only
  from an HTTP status plus an operation label. A `Response`, a `Headers`, a
  thrown error object, a token, a crumb and a cookie are never interpolated
  into one. Header logging uses an allowlist of known-safe names, so a new
  secret-bearing header is redacted by default.
- **Password-class build parameters are redacted** in the returned data, so
  `--json` and the permanent cache hold `[redacted]` too.
- **stdout is the JSON-RPC channel.** Only `console.error` is permitted in the
  codebase, enforced by biome, and a spawned-server test asserts that stdout
  carries nothing but well-formed JSON-RPC frames.

If you ever see a raw token, crumb or cookie **value** on stderr, that is a bug
worth reporting, not expected output.

## Development

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

See [VERIFICATION.md](VERIFICATION.md) for what is and is not verified, and for
the live-instance checklist.
