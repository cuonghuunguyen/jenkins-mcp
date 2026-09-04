---
name: jenkins
license: MIT
metadata:
  version: 0.2.0
  repository: https://github.com/cuonghuunguyen/jenkins-mcp
description: "Inspect and control Jenkins from the shell with the `jenkins` CLI: find the job that builds the current checkout, read a build's status/stages/failed tests, read or save a console log, diagnose a failure, trigger/abort/wait for a build. Use whenever the user asks why a build failed, what a job's last builds were, to start or stop a build, to watch a build to completion, or to read a Jenkins log — and whenever a CI failure needs to be traced from inside a git checkout."
---

# jenkins

One question, one command. Output is compact text by default and raw JSON with `--json`.

## Before anything

This skill drives the `jenkins` binary. If `jenkins --version` is not on `PATH`:

```bash
npm install -g @cuonghuunguyen/jenkins-cli
```

Requires `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` in the environment (or
`--url/--user/--token`). Check with `jenkins whoami` — it prints `authenticated: <id>` or
one structured error line and exits 1.

## The job is usually inferred

`--job` → `JENKINS_JOB` → the git `origin` remote of the cwd, matched against the job
index's SCM URLs. So from inside a checkout, omit `--job`. Pass `--job team-a/svc` when
outside one or when the remote matches several jobs (the error says so and lists them).

`--ref` addresses a multibranch child: `main`, `feature/foo`, `PR-42`, or `42` (a bare
integer means `PR-42`). Omit for a plain job. A build is a number, `-1`, or a permalink
alias (`lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild`, …); it defaults to `lastBuild`.

## Commands

| Command | Use it for |
|---|---|
| `jenkins whoami` | Confirm connectivity and identity |
| `jenkins jobs find [query]` | Find a job by name substring or git remote URL; no query resolves the current checkout |
| `jenkins job [ref]` | A job's parameters + last 10 builds; on a multibranch parent, its branches/PRs/tags |
| `jenkins build [build]` | One build: status, cause, params, commits, stage table, failed steps, failed tests |
| `jenkins build diagnose [build]` | Why it failed: failed stage/step, failed tests, the failed step's own log |
| `jenkins log [build]` | A bounded window of the console log |
| `jenkins build wait [build]` | Block until a build finishes |
| `jenkins build trigger` | Start a build (parameters validated first) |
| `jenkins build abort [build]` | Gracefully abort a running build |
| `jenkins queue` | What the queue holds and why |
| `jenkins api get <path>` | Any read-only Jenkins path the typed commands do not cover |

## Diagnosing a failure — start here

```bash
jenkins build diagnose            # failed stage, failed step, failed tests, that step's log
jenkins build                     # full build summary if diagnose was not enough
jenkins log --mode failed         # the log window around the failure
```

`diagnose` is the right first call. Reach for `jenkins log` only when it points you
somewhere specific.

## Reading logs without drowning

```bash
jenkins log                                   # last 100 lines (mode=tail)
jenkins log --mode grep --pattern 'ERROR|FAIL' --context 3
jenkins log --mode range --from -200 --to -1  # negatives are end-relative
jenkins log --mode step --step 'Unit tests'   # one pipeline stage's log
jenkins log --save-to ''                      # full raw log to .jenkins-mcp/cli/<job>/<ref>/<build>.log
```

Every truncated result ends with the exact call that returns the rest — follow it rather
than guessing. `--save-to` returns a summary (path, lines, bytes, first failure line), not
the log body; use it when the log is large and you want to grep it locally.

## Starting and watching a build

```bash
jenkins build trigger --param BRANCH=main --param DEPLOY=false
jenkins build trigger --wait          # trigger, then block until it finishes
jenkins build wait                    # blocks with no timeout; Ctrl-C to stop
jenkins build wait --timeout 300      # give up after 5 minutes and report as still running
jenkins build abort
```

Parameters are validated against the job's declared parameters **before** anything is
submitted, so an unknown name or a bad choice fails fast and lists the valid ones.
`--rebuild-from <n>` reuses build `<n>`'s parameters. A wait that times out reports the
build as still running — that is a result, not an error.

## Reading the output

- A list always states its counts: `jobs (12)` complete, `jobs (showing 20 of 137)` not.
- `No X found` / `No X matched <q>` is a real answer, not a failure.
- `next: <call>` lines name concrete follow-ups. They are usually the right next command.
- An error is one line: `error: <code> — <message> — try: <call>`, exit 1.
- `--json` emits the operation's raw structured result and skips formatting entirely — use
  it when you need to extract a field, not to read.

## Escape hatch

```bash
jenkins api get /queue/api/json --tree 'items[id,why,task[fullName]]'
jenkins api get /job/team-a/job/svc/config.xml
```

GET only. `--tree` is **required** for any path ending in `api/json` — without a projection
Jenkins returns megabytes.

## Also available as an MCP server

The same operations are exposed as 11 MCP tools (`jenkins_find_jobs`, `jenkins_job`,
`jenkins_build`, `jenkins_log`, `jenkins_queue`, `jenkins_api_get`, `jenkins_wait_build`,
`jenkins_diagnose_build`, `jenkins_trigger_build`, `jenkins_abort_build`,
`jenkins_whoami`). If those tools are present in the session, prefer them — they avoid a
subprocess. `JENKINS_MCP_READONLY=1` unregisters the two writing tools (trigger, abort).

Install it with `npx -y @cuonghuunguyen/jenkins-mcp`. Repo:
https://github.com/cuonghuunguyen/jenkins-mcp — `README.md` documents every tool and
parameter; `VERIFICATION.md` records what has and has not been verified against a live
instance.
