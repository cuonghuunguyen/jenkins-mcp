# Verification record

What has actually been checked, what has not, and the procedure for closing the
gap.

Two things stated plainly, because everything below depends on them:

1. **Live verification against a real Jenkins has NOT been run.** No
   credentials and no reachable instance were available at any point while v2
   was built. Every row in section 3 is unrun. Nothing in section 1 demonstrates
   that this server works against any Jenkins instance.
2. **The CLI does not stream a wait.** `jenkins build wait` and
   `jenkins build trigger --wait` return stage transitions and new log lines
   **when the wait ends** — on completion, on the timeout, on Ctrl-C, or when a
   pipeline pauses on an `input` step. Nothing is printed while the wait is in
   progress. Live progress is a polling loop over `--since-cursor` /
   `--log-cursor`, not a stream.

Do not mark anything here as done from reading the code. Only a run against a
real instance closes a row in section 3.

## 1. Verified without a live Jenkins

Run from the repo root. Counts are the ones observed on this tree, not carried
over from an earlier pass:

| Check | Command | Observed | What it proves |
|-------|---------|----------|----------------|
| Build | `pnpm build` | 3 packages, exit 0 | Every package type-checks and emits. `core` compiles with no MCP/yargs/stdout dependency, which is the ARCH-01 boundary. |
| Tests | `pnpm test` | **478 passed across 35 files** — core 347/20, mcp 81/8, cli 50/7 | See the breakdown below. |
| Lint | `pnpm lint` | 92 files checked, no fixes applied | Includes biome's `noConsole` rule, which permits only `console.error` — the mechanical half of the stdout guarantee. |

What specific tests prove, beyond "code runs":

- **stdout purity** (`packages/mcp/src/__tests__/stdio-hygiene.test.ts`). Spawns
  the real server as a child process, drives it, and asserts every non-empty
  stdout line is a well-formed JSON-RPC frame. This is the only check that
  covers the whole process, including a stray `console.log` in a dependency.
  It proves the transport cannot be corrupted by our own diagnostics; it does
  not prove anything about Jenkins.
- **Tool surface in both modes** (`packages/mcp/src/__tests__/safety.test.ts`).
  Drives the real registrars against a throwaway server, with `readonly` false
  and true, and asserts the exact 11-tool and 9-tool lists, that the two lists
  differ by exactly `jenkins_trigger_build` and `jenkins_abort_build`, that no
  tool name implies create/update/delete, and that the removed VFS shell tool
  is gone. Because the list comes from the same code path the server uses
  (`toolNames()` in `server.ts` is derived from the registrars), it cannot
  drift from what is really registered.
- **"Only trigger and abort issue a non-GET request" — asserted
  BEHAVIOURALLY.** This is the claim that was previously false and could not be
  caught. `jenkins_whoami` POSTed to `/me/api/json` to exercise the crumb
  round-trip, and it is registered in read-only mode, so a deployment that set
  `JENKINS_MCP_READONLY` because a proxy or an audit rule blocks non-GET verbs
  got a crumb-protected POST anyway. The old assertion compared the read-only
  tool NAMES against a hardcoded two-name array — a tautology given the list
  assertion above it: it never invoked a handler and never observed a request.
  `operations/whoami.ts` now GETs, and `safety.test.ts` now invokes **every**
  read-only tool's operation against a client whose `post` fails the test if it
  is called (`"INVOKES every read-only tool and observes zero POSTs"`, plus
  `"keeps jenkins_whoami on GET, since it is registered in read-only mode"`).
  The claim now holds without qualification, and a regression would fail a test
  rather than a code review.
- **Write-endpoint allowlist**. Walks the entire write surface with a recording
  client and asserts only `/build`, `/buildWithParameters` and `/<n>/stop` are
  ever POSTed, that a `ref`-addressed abort hits the branch job rather than the
  multibranch parent, and that an abort drops the job's cached entries. This
  proves the boundary as the code is written; it does not prove Jenkins accepts
  or rejects those endpoints.
- **`save_to` containment and layout**
  (`packages/core/src/__tests__/log.test.ts`). Rejects an absolute path, a `..`
  traversal, a symlinked directory whose real target is outside the cwd, a
  pre-existing dangling symlink, and a hardlink to a file outside the cwd
  (without truncating it first). Real files and symlinks on disk, not string
  matching. It also asserts the default destination is
  `.jenkins-mcp/cli/<job>/<ref>/<build>.log` with the **job path as real nested
  directories** (`team-a/svc` is two directories, not `team-a-svc`), that a
  component decoding to `..`/absolute/empty is rejected rather than sanitized,
  that the summary carries `firstFailureLine`, and that `cursor` with `save_to`
  is rejected instead of overwriting the full log with one chunk.
- **`jenkins_api_get` validation** (`packages/core/src/__tests__/api.test.ts`).
  Rejects an absolute URL (the SSRF case — the client carries an
  `Authorization` header), a protocol-relative `//host`, a `.`/`..` segment in
  any encoding, and an embedded query string; requires `tree` for `api/json`,
  `api/xml` and `api/python`, applied to the path a servlet container would
  actually route (`/queue/api//json`, `/queue/api/json;x=y`).
- **Wait semantics** (`packages/core/src/__tests__/wait.test.ts`). Asserts the
  wfapi/describe poll with its api/json fallback, the stage cursor and log-byte
  cursor deltas, the distinct `input`-paused return, the transient-poll-error
  tolerance (`MAX_TRANSIENT_POLL_ERRORS = 3`), and that a non-numeric bound
  falls back to `DEFAULT_WAIT_TIMEOUT_MS` (120s) rather than removing the
  elapsed-time exit — yargs' `type: "number"` yields `NaN` for `--timeout abc`,
  and every comparison against `NaN` is false, so the loop would have run
  forever. `Number.POSITIVE_INFINITY` is still accepted: that is how the
  unbounded CLI wait is expressed.
- **Error redaction** (`packages/core/src/__tests__/errors.test.ts`). Messages
  are built from a status plus an operation label only; the header allowlist
  redacts anything not known-safe.

Everything above is offline. **None of it demonstrates that this server works
against any Jenkins instance.**

## 2. NOT verified — every live-instance behaviour

Each row is an assumption the code relies on, where it is relied on, and the
consequence if it is wrong. Re-derived from the `UNVERIFIED` / `Assumption`
comments actually present in the source, not carried over.

| # | Assumption | Relied on in | If it is wrong |
|---|-----------|--------------|----------------|
| 1 | `logText/progressiveText?start=<n>` answers with the bytes from that offset plus `X-Text-Size` (next offset) and `X-More-Data` (`"true"` while writing). Header names come from the Jenkins docs, not an observed response. | `core/src/operations/log.ts` (`cursor` mode; also the source of `jenkins_wait_build`'s `log_cursor`) | `nextCursor` is `undefined` and `hasMore` is always false, so polling a running build silently stops advancing and re-reads or drops output. A wait's `log_cursor` then never advances either. |
| 2 | A pipeline step log is reachable at `execution/node/<id>/wfapi/log` and carries the text under a JSON `text` field. | `core/src/operations/log.ts` (`mode=step`, `readWfapiNodeLog`) | Falls back to grepping the whole console for the stage name. The result labels which route produced the text (`stepRoute`), so the caller is not misled — only less precise. |
| 3 | The wfapi node-log body is either a `{"text": …}` JSON envelope or plain text, and `readWfapiNodeLog` handles both. **The previous inconsistency is resolved**: `diagnose.ts` imports the same reader `log.ts` uses, so the two can no longer disagree, and the shape actually seen is recorded on the result as `wfapiShape`. | `core/src/operations/log.ts` (`readWfapiNodeLog`, exported) and `core/src/operations/diagnose.ts` (`fetchRegion`) | A third body shape neither branch recognises yields an empty region, which degrades to "no log region for this build" rather than printing an escaped JSON line. Read `wfapiShape` on the first live run to record which shape this instance really sends. |
| 4 | `PAUSED_PENDING_INPUT` (or any status containing `PAUSED`) is what wfapi reports for a stage blocked on an `input` step. The value comes from the Pipeline Stage View API's documented status enum, not an observed response, which is why the check is a set plus a substring test rather than an equality. | `core/src/operations/wait.ts` (`PAUSED_STATUSES`, `isPaused`) | The pause is not detected, so `jenkins_wait_build` reports "still BUILDING — wait timed out" on a build that will never finish on its own. The agent then waits again, indefinitely, instead of telling the user a human must act. **This is the highest-value single check in section 3 (row 26).** |
| 5 | `parameterDefinitions[].type` is the definition's simple class name, e.g. `StringParameterDefinition`. | `core/src/operations/job-detail.ts` (`simpleParameterType`) | The `type` column shows the raw value instead of `string`/`choice`/`boolean`. Degrades, does not break. |
| 6 | Jenkins accepts a fully percent-encoded `tree=` value (`%5B`, `%2C`). The value is `encodeURIComponent`-encoded so a `&` cannot append parameters of the caller's choosing. | `core/src/operations/api.ts` | `jenkins_api_get` with `tree` returns a 400 or an unprojected body. The typed tools interpolate their `tree=` unencoded and are unaffected. |
| 7 | For a queue item whose job the account cannot read, Jenkins returns the item with a task that has no name, rather than omitting the item. | `core/src/operations/queue-list.ts` (`jobFullName` optional) | Either the row renders with a blank job, or such items are absent entirely and the queue count under-reports. |
| 8 | The CSRF crumb + session round-trip works as implemented: fetch the crumb, attach the crumb header **and** the session cookie to the POST, retry exactly once on a crumb-specific 403. Never exercised against a real CSRF-enabled instance, and proxies are the usual failure. | `core/src/client.ts`, `core/src/auth.ts`; reached **only** by `jenkins_trigger_build` and `jenkins_abort_build` | Every write fails with `error: forbidden`. Note the change: `jenkins_whoami` no longer POSTs, so it no longer exercises this path and a passing `whoami` says **nothing** about the crumb. Row 22 is the first check that does. |
| 9 | `/stop` answers a successful abort with a 2xx **or** a 302 back to the build page (RESEARCH.md assumption A1). | `core/src/operations/abort.ts` | A 200 carrying an error page would be reported as a successful abort. Confirm against the build's real state, not the tool's output. |
| 10 | `wfapi/describe` and `testReport/api/json` return **404** when the data does not exist (not a pipeline, no Pipeline REST plugin, no JUnit publisher), and any other non-ok status means a transport problem. Only the 404 is treated as permanent. | `core/src/operations/build-detail.ts` (`fetchStages`, `fetchTests`), `core/src/operations/diagnose.ts`, `core/src/operations/wait.ts` (`wfapiUnavailable`) | A 200-with-error-body renders as "no stages"/"no tests". A 500 for "no report" is treated as degraded, which is the safe direction. In a wait it flips to the api/json fallback, which loses stage transitions but still returns a correct final result. |
| 11 | A pipeline build exposes `changeSets`, a freestyle build exposes `changeSet`. Both spellings are requested and whichever is present is read. | `core/src/operations/build-detail.ts` (`BUILD_DETAIL_TREE_FIELDS`) | Commits render as none for whichever build type spells it a third way. |
| 12 | A `PasswordParameterValue`'s `value` may or may not be exported by Jenkins; it is redacted either way, matched on the parameter's `_class`. | `core/src/operations/build-detail.ts` (`parametersOf`) | Only a class name outside `Password\|Secret\|Credentials` would leak — verify against a job that actually has a password parameter. |
| 13 | A multibranch child whose branch contains `/` is reported by Jenkins with `%2F` in its name, so the displayed child name is percent-decoded before being shown as a `ref`. | `core/src/format/job-detail.ts` (`childName`) | The listed child name is not one that can be passed back as `ref` — it 404s, or re-encodes to `%252F`. The same decoding drives `save_to`'s ref directory, so a wrong assumption also mislocates a saved log. |
| 14 | `/me/api/json` returns the identity fields the formatter reads, and may omit some of them (RESEARCH.md A3). | `core/src/types.ts` (`WhoAmI`), `core/src/operations/whoami.ts` | `jenkins_whoami` prints fewer lines. Cosmetic. |
| 15 | The anchored failure signals (`Finished: FAILURE`, `Build step … marked build as`, a line-start `[ERROR]`/`ERROR:`/`FATAL:`, `BUILD FAILED`, a non-zero `exit code`/`exit status`) actually appear in this instance's console output. Deliberately narrow: the loose `/error\|fail/i` scan this replaced matched compiler warnings and dependency names. | `core/src/operations/log.ts` (`ANCHORED_FAILURE_RES`, `findFirstFailureLine`, `mode=failed`, `save_to`'s `firstFailureLine`) | `firstFailureLine` is absent and `mode=failed` returns nothing. Both say so explicitly ("no anchored failure line found") rather than guessing, so the failure mode is a missing answer, not a wrong one. |

### Closed since the previous pass — do not re-open from the old text

- **The wfapi node-log double-read** (previously row 3, "both cannot be right")
  is fixed: one exported reader, used by both callers, recording the shape it
  saw.
- **`jenkins_whoami` POSTing** is fixed: it GETs, and the fix is held by a
  behavioural test rather than a name list.
- **The CTRL-06 gap** (previously "Known gap, not an assumption") is closed in
  code: `jenkins_wait_build` now polls wfapi/describe with an api/json
  fallback, accepts a stage cursor and a log byte cursor, returns stage
  transitions and new log lines, and returns a distinct `PAUSED` state on an
  `input` step. What remains open is only assumption 4 above — whether the
  status value it matches on is the one a real instance sends — and the
  non-streaming CLI limitation stated at the top of this file, which is a
  deliberate design choice, not a defect.
- **The trigger losing its build number** on a post-POST error is fixed: the
  resolved number is reported with a `warning:` and a "do NOT re-trigger" hint.
- **`save_to` flattening the job path** is fixed: real nested directories.

## 3. Live verification procedure

Run top to bottom against a real instance. You need:

- credentials for an account with Job/Build and Job/Cancel on a scratch job,
- a **multibranch** job with at least one branch and at least one **PR** build,
- a **failed pipeline build** with a failed stage, and ideally a JUnit report,
- one **freestyle** job (for the degradation paths),
- one pipeline with an **`input` step**, for row 26. If you have none, write a
  three-line scratch pipeline: that row covers the single most consequential
  unverified assumption in section 2.

Set up once:

```bash
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=...
export JENKINS_API_TOKEN=...
export JOB=team-a/api-service     # your multibranch job's fullName
export REF=main
export FAILED=117                 # a build number that failed
```

The CLI is used for the checklist because it is scriptable; each row's MCP tool
runs the identical core operation, so a CLI pass is an MCP pass for everything
except tool registration (row 2) and the two documented surface differences:
the wait bound (unbounded on the CLI, 120s on MCP) and read-only mode, which
gates the MCP server only.

| # | Command | A correct result looks like | Closes | Result |
|---|---------|-----------------------------|--------|--------|
| 1 | `jenkins whoami` | `authenticated: <your user>` plus `fullName`/`url`. Not an `error:` line. | Connectivity, credentials, Basic auth, and assumption 14. This is a **GET** — it proves nothing about the crumb (see row 22). | not yet run |
| 2 | Start the MCP server in your client, then in a second config with `JENKINS_MCP_READONLY=1` | 11 tools, then 9; `jenkins_trigger_build` and `jenkins_abort_build` present only in the first. | SAFE-03 end to end, through a real host rather than the registrar test. | not yet run |
| 3 | `jenkins jobs find` from inside a checkout Jenkins builds | One job, matched by SCM URL, not by name. | Job resolution from the git `origin` remote, and the SCM-URL field of the index. | not yet run |
| 4 | `jenkins jobs find "$JOB"` | The multibranch parent and its children, columns `fullName / type/status / lastBuild / age`, with a `jobs (N)` count. The parent shows `-` for both `lastBuild` and `age`; a branch shows a real number and age. If it reports dropped folders, raise `JENKINS_INDEX_DEPTH`. | AGNT-02: one-request index, depth cap reported honestly, and that `lastBuild`/`age` are populated from the same single request. | not yet run |
| 5 | `jenkins job --job "$JOB"` | The container listing: children with `status` and `type`. A branch with a `/` in its name must display **decoded** (`release/1.x`, not `release%2F1.x`). | REF-02 and assumption 13. | not yet run |
| 6 | `jenkins job --job "$JOB" "$REF"` | Parameters with resolved types (`string`/`choice`/`boolean`, not `StringParameterDefinition`) and the last builds with `showing N of M`. | READ-08 and assumption 5. | not yet run |
| 7 | `jenkins job --job "$JOB" 42` (a real PR number) | The same view as `PR-42`. Then repeat the bare integer against `jenkins build`, `jenkins log`, `jenkins build wait`, `jenkins build diagnose`, `jenkins build trigger` and `jenkins build abort` — all seven ref-taking commands normalize it, so it must work in all seven or the normalization is not uniform. | REF-01 across the whole surface. | not yet run |
| 8 | `jenkins build --job "$JOB" --ref "$REF" "$FAILED"` | Status, cause, params, commits, stages, failed steps, failed tests. A password parameter shows `[redacted]`. | READ-09, assumptions 10, 11, 12. | not yet run |
| 9 | `jenkins build --job "$JOB" --ref "$REF" lastFailedBuild` | The same build as row 8, addressed by permalink. | REF-01 permalink aliases. | not yet run |
| 10 | `jenkins log --job "$JOB" --ref "$REF" "$FAILED" --lines 20` | 20 numbered lines, numbered as in the full log, with a `lines X-Y of Z` header. | READ-10 tail. | not yet run |
| 11 | `jenkins log … --mode range --from 100 --to 120` | Exactly the lines numbered 100–120 from row 10's numbering. | That the numbering is addressable, which is the point of numbering it. | not yet run |
| 12 | `jenkins log … --mode range --from -20 --to -1` | The last 20 lines, with the same numbers `jenkins log … --lines 20` gave them in row 10. | End-relative negative range bounds. | not yet run |
| 13 | `jenkins log … --mode grep --pattern ERROR --max-matches 5` | At most 5 hits plus context, and a header saying the scan **stopped early** at `max_matches=5` after N of M lines. Re-run without `--max-matches`: the header must then report the real total, not `200+`, unless the log genuinely has 200+ hits. | READ-10 grep, `max_matches` early stop, and that "stopped early" is distinguished from "that many matches exist". | not yet run |
| 14 | `jenkins log … --mode failed` and `jenkins log … --mode failed --context 10` | A window around the failure anchor; the second is visibly narrower (10 lines each side rather than 60 before / 20 after). If both are empty, assumption 15 is wrong for this instance's log format. | `mode=failed` and its `context` parameter, plus assumption 15. | not yet run |
| 15 | `jenkins log … --mode step --step "<a real stage name>"` | The stage's own log — **not** a `{"text":"…"}` JSON line, and not a console grep. The output says which route produced it. Record the `wfapiShape` from `--json`. | Assumptions 2 and 3. | not yet run |
| 16 | `jenkins build diagnose --job "$JOB" --ref "$REF" "$FAILED"` | Failed stage and step named, failed tests listed, and a readable failed-step log — **not** a raw JSON envelope. The `log (…, from line N)` header must be present. | DIAG-03 and assumption 3. Compare its log body against row 15's; they read through the same reader now, so a mismatch is a real defect. | not yet run |
| 17 | `jenkins build diagnose --job <a freestyle job>` on a build with a **long** console | No stage attribution, but a `log (console tail, … from line N)` region where N is near the END of the log, and whose last line is the end of the build (`Finished: FAILURE`). If the region ends mid-build, the tail was capped from the wrong end. | The `log-only` degradation path and the end-anchored console-tail cap. | not yet run |
| 18 | `jenkins log … --save-to ''` | A one-line summary naming the path, byte count, line count and either `firstFailureLine: N` or `no anchored failure line found`. The file must exist at `.jenkins-mcp/cli/<job as nested dirs>/<ref>/<build>.log` — for `team-a/api-service` that is `.jenkins-mcp/cli/team-a/api-service/main/117.log`, **not** a flattened `team-a-api-service` — and hold the RAW log. Then run the `mode=range` call the summary suggested and check the failure is in the window. | READ-11: nested job path, `firstFailureLine`, and that the suggested follow-up call is correct. | not yet run |
| 19 | `jenkins log … --save-to /tmp/x.log` and `--save-to ../x.log` | Both rejected with `error: invalid_input`. Nothing written. | `save_to` containment against a real filesystem. | not yet run |
| 20 | `jenkins queue` while something is queued | The item, its derived state, its wait time and Jenkins' own reason. Re-run with an account that cannot read the queued job. | READ-12 and assumption 7. | not yet run |
| 21 | `jenkins api get "/job/…/config.xml"`, then `jenkins api get /api/json` then `jenkins api get /api/json --tree 'jobs[fullName,color]'` | The XML with a byte count; the bare `api/json` rejected naming the rule; the projected one returning only those fields. | READ-12 escape hatch, the mandatory-projection rule, and assumption 6. | not yet run |
| 22 | `jenkins build trigger --job "$JOB" --ref "$REF" --param NOPE=1`, then with a valid `--param` | First: `error: invalid_input` naming the declared parameters, and **no new build** — check the job. Second: a real **build number**, never a queue id, plus the build URL, and `next:` lines naming that number. | CTRL-07 pre-POST validation, and **assumption 8** — this is the first non-GET request in the checklist, so it is the first thing that proves the crumb + session round-trip. | not yet run |
| 23 | `jenkins build trigger … --rebuild-from "$FAILED"` | The past build's parameters reused, with any `--param` overriding individual keys; the inherited ones named on an `inherited:` line. | CTRL-07 `rebuild_from`. | not yet run |
| 24 | `jenkins build wait --job "$JOB" --ref "$REF" <the build from row 22>` | Blocks (unbounded — Ctrl-C is your exit), then reports the final result, duration, poll count, a `stages (N)` table with ids, and a `since_cursor:` / `log_cursor:` pair. On a freestyle job instead: `stages: none (no Pipeline REST API for this build)`, not an empty table. | CTRL-06 stage transitions and the api/json fallback (assumption 10). | not yet run |
| 25 | Row 24 again with `--since-cursor <the id it printed> --log-cursor <the number it printed>`, against a **running** build | Only the stages after that id, and only the log bytes after that offset. Both cursors advance. If `log_cursor` never advances, assumption 1 is wrong. | The delta contract, and assumption 1 from the wait side. | not yet run |
| 26 | `jenkins build wait --timeout 60` against a pipeline **parked on an `input` step** | `status: PAUSED — waiting for input at stage '<name>'`, returning as soon as the pause is seen rather than at the 60s bound, with hints naming the human action and `jenkins build abort`. **If it instead reports "still BUILDING — wait timed out", assumption 4 is wrong** — record the actual `status` string from `--json` and fix `PAUSED_STATUSES`. | **Assumption 4 — the highest-value row here.** | not yet run |
| 27 | `jenkins build wait --timeout abc` on a running build | Falls back to the 120s default and returns. It must not hang. | The `NaN`-bound guard (`resolveTimeoutMs`). | not yet run |
| 28 | `jenkins log … --cursor <n>` against a **running** build, twice | The second call returns only what was written since, and `nextCursor` advances. If `nextCursor` is absent, assumption 1 is wrong. | Assumption 1 from the log side. | not yet run |
| 29 | `jenkins build abort --job "$JOB" --ref "$REF" <a running build>` | Reports the abort; then `jenkins build <n>` shows `ABORTED`. **Check the second command, not the first** — a false success is exactly what assumption 9 risks. | CTRL-08 and assumption 9. | not yet run |
| 30 | Immediately after row 29, `jenkins build --job "$JOB" --ref "$REF" <n>` | The post-abort state, not the pre-abort cached one. | AGNT-01 invalidation on write. | not yet run |
| 31 | Kill a trigger's follow-up (e.g. `jenkins build trigger --wait` against a job you then make unreadable mid-run), or otherwise force the chained wait to fail | The output still names the resolved build number, with `warning: the build was started but could not be followed` and a `do NOT re-trigger` hint. | That a post-POST failure cannot lose the build number. Hard to force; skip rather than fake it. | not yet run |
| 32 | With `JENKINS_MCP_READONLY=1`, ask the agent to trigger a build | The tool is not offered at all. | SAFE-03 from the agent's side. | not yet run |
| 33 | Throughout: watch stderr with `LOG_LEVEL=debug` | No raw token, crumb or cookie **value** anywhere. | CONN-03 redaction against real headers. | not yet run |

When a row passes, replace `not yet run` with the date and the Jenkins version
you ran it against. When a row fails, record the actual output — an assumption
in section 2 is then closed as *wrong*, which is worth more than a pass.

Do not fill in a verification date or a Jenkins version anywhere in this file
until a row has actually been run.
