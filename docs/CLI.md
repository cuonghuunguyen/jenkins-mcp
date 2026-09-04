# CLI reference

[← README](../README.md)


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
