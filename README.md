# jenkins-mcp

An MCP (Model Context Protocol) server, written in TypeScript/Node and speaking
stdio, that lets Claude Code and Claude Desktop connect to, observe, and control
a single Jenkins instance. The agent can inspect jobs, builds, console logs,
pipeline stages, and the build queue through a read-only in-memory filesystem,
and can trigger and abort builds under an explicit no-create/update/delete
safety boundary.

## Features

- **`jenkins_whoami`** — confirm connectivity and the authenticated identity.
- **`jenkins_bash`** — explore the whole instance (jobs, builds, logs, pipeline
  stages, queue) with familiar read-only shell commands over a virtual
  filesystem that mirrors Jenkins.
- **`jenkins_trigger_build`** — start a freestyle or pipeline build, optionally
  with parameters, and resolve the queued request to a real build number.
- **`jenkins_abort_build`** — gracefully abort a running build.

Every request is either read-only or an explicit, user-requested
trigger/abort. The server never creates, updates, or deletes jobs,
credentials, or configuration. See [Safety](#safety).

## Requirements

- Node.js >= 20
- A reachable Jenkins instance and an API token for the account the server
  should authenticate as

## Installation

```bash
npm install
npm run build
```

This produces `dist/index.js`, the server's stdio entrypoint.

A step-by-step walkthrough — creating the API token, wiring the client, and
running the first tool — is in [SETUP.md](SETUP.md).

## Configuration

The server reads its connection settings from environment variables at boot
(env-only, zod-validated, fail-fast — there is **no** config file and **no**
dotenv auto-loading in v1). See [.env.example](.env.example) for a copyable
template.

| Variable | Required | Description |
|----------|----------|-------------|
| `JENKINS_URL` | yes | Base URL of the target Jenkins instance, e.g. `https://ci.example.com` (no trailing slash) |
| `JENKINS_USER` | yes | Jenkins username the API token belongs to |
| `JENKINS_API_TOKEN` | yes | An API token for that user — Jenkins → user → Configure → API Token → Add new Token (never use the account password) |

On missing/malformed config the server prints an actionable message naming the
offending variable(s) to stderr (never echoing the token value) and exits
non-zero. It will not start with invalid config.

Optional:

| Variable | Default | Description |
|----------|---------|--------------|
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. Set to `debug` to see crumb-fetch/cookie-reuse detail on stderr while diagnosing connectivity. Token/crumb/cookie values are always redacted. |

## Client configuration (Claude Code / Claude Desktop)

Add an entry to the MCP host's `mcpServers` config pointing at the built
`dist/index.js`, with credentials supplied via the `env` block (never on disk
elsewhere):

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/absolute/path/to/jenkins-mcp/dist/index.js"],
      "env": {
        "JENKINS_URL": "https://ci.example.com",
        "JENKINS_USER": "your-jenkins-username",
        "JENKINS_API_TOKEN": "your-jenkins-api-token"
      }
    }
  }
}
```

For Claude Code, this block goes in the project or user MCP config (`claude mcp
add` or the equivalent config file); for Claude Desktop, in
`claude_desktop_config.json`'s `mcpServers` section. Use an absolute path to
`dist/index.js` — the host spawns the server as a child process and does not
resolve relative paths against this repo.

## Tools

All tools that reference a job take a human-friendly **path string**:
folder-nesting is expressed with `/` (`folderA/folderB/my-job`). A `/` *inside*
a single multibranch branch name must be pre-encoded as `%2F` by the caller —
literal folder slashes are split, `%2F` is preserved.

### `jenkins_whoami`

Returns the identity and permissions the server is currently authenticated as.
Takes no input. Use it first, after wiring the client config above, to confirm
connectivity and that the configured credentials resolve to the expected
account.

Internally this issues a crumb-protected, session-persisted **POST** to
`/me/api/json` — this doubles as the connectivity check and as the project's
proof that write-shaped requests correctly attach a CSRF crumb over a persisted
session. `/me/api/json` returns only already-public, read-only identity data
for the authenticated user, so this POST never creates, updates, or deletes
anything.

### `jenkins_bash`

Runs a read-only bash command (`ls`, `find`, `cat`, `grep`, `tail`, `head`,
`jq`, …) over an in-memory filesystem that mirrors the connected Jenkins
instance. This is the entire read/observability surface — there is no separate
"list jobs" or "get build" tool; you navigate the layout instead.

Layout:

| Path | Contents |
|------|----------|
| `/jobs/<folder>/<job>/api.json` | Job details + recent builds |
| `/jobs/<folder>/<job>/builds/<n>/api.json` | Build status |
| `/jobs/<folder>/<job>/builds/<n>/log` | Full console log |
| `/jobs/<folder>/<job>/builds/<n>/wfapi.json` | Pipeline stage view (pipeline jobs only) |
| `/jobs/<folder>/<job>/builds/<alias>` | Permalink aliases: `lastBuild`, `lastSuccessfulBuild`, `lastFailedBuild`, `lastCompletedBuild` |
| `/queue.json` | The build queue (root) |

The filesystem is strictly read-only (no write/mkdir/rm/cp/mv) and has no
network access — attempts to write or reach the network fail inside the
sandbox. Command output is capped at ~50KB; use `grep`/`tail`/`head` to narrow
large results (e.g. console logs) rather than reading them whole.

Example commands the agent might run:

```bash
ls /jobs                                        # top-level jobs & folders
cat /jobs/my-job/builds/lastFailedBuild/api.json
tail -n 200 /jobs/my-job/builds/42/log
jq '.stages[] | select(.status=="FAILED")' /jobs/my-job/builds/42/wfapi.json
cat /queue.json
```

### `jenkins_trigger_build`

Triggers a build for a freestyle or pipeline job, optionally with build
parameters. Waits a short bounded time (default 15s, override with `timeout` in
seconds) for Jenkins to assign the queued request a real build number. If it
resolves in time, returns the build number to watch; otherwise returns the
queue id and the reason it hasn't started yet. Either way, use `jenkins_bash`
afterwards to monitor the build (`cat builds/<n>/api.json`, `tail
builds/<n>/log`) or the queue (`cat queue.json`).

Input:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Job path (`folderA/my-job`) |
| `params` | object (string→string) | no | Build parameters, passed through to `/buildWithParameters` with no client-side validation. Omit for a plain `/build`. |
| `timeout` | number | no | Seconds to wait for a build number (default 15) |

### `jenkins_abort_build`

Gracefully aborts a running build — the same effect as clicking the **Abort**
button in the Jenkins UI. Issues a single POST to
`/job/<path>/<buildNumber>/stop`. It intentionally never escalates to the
forceful `/term` or `/kill` endpoints (out of v1 scope).

Input:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | yes | Job path (`folderA/my-job`) |
| `buildNumber` | number | yes | The build number to abort |

## Live smoke test (crumb + session round-trip)

Jenkins CSRF crumbs are bound to the session that issued them since Jenkins
2.176.2, and native `fetch` has no built-in cookie jar — so the mocked unit
tests in this repo cannot prove the real round-trip end to end. This procedure
is the authoritative, human-run verification of that behavior against your
**real** target Jenkins instance. Run it once whenever you point this server at
a new/upgraded Jenkins instance.

**Prerequisites:** a real `JENKINS_URL`, `JENKINS_USER`, and
`JENKINS_API_TOKEN` for an account with permission to view its own `/me` page.

1. **Build the server:**
   ```bash
   npm run build
   ```

2. **(Optional but recommended) Enable debug logging** so you can see the crumb
   fetch and cookie reuse on stderr:
   ```bash
   export LOG_LEVEL=debug
   ```

3. **Export real credentials** for the target instance:
   ```bash
   export JENKINS_URL="https://ci.example.com"
   export JENKINS_USER="your-jenkins-username"
   export JENKINS_API_TOKEN="your-jenkins-api-token"
   ```

4. **Run the server and call `jenkins_whoami`.** Either:
   - Configure Claude Code/Desktop with the client config snippet above (using
     these same env values) and invoke `jenkins_whoami` through the assistant,
     or
   - Drive it directly with the MCP Inspector:
     ```bash
     npx @modelcontextprotocol/inspector node dist/index.js
     ```
     then call `jenkins_whoami` with no arguments from the Inspector UI.

5. **Confirm the result is a real identity, not an error:** the response should
   read `Authenticated as: <your-jenkins-username>` (plus full name /
   authorities if Jenkins returns them) — not a 401/403/connection-error
   message.

6. **Confirm the round-trip was write-shaped (crumb + session), not an
   anonymous GET.** With `LOG_LEVEL=debug` you should see a crumb-issuer fetch
   followed by the `/me/api/json` POST reusing the same session cookie captured
   from that fetch. No `Authorization`, `Jenkins-Crumb`, or `Cookie` header
   **value** should ever appear in the log output — the logger redacts these;
   if you ever see a raw token/crumb/cookie value on stderr, that is a bug, not
   evidence of success.

7. **405 fallback — if `POST /me/api/json` returns `405 Method Not Allowed`:**
   do not fall back to a mutating endpoint. Hand-test one of these non-mutating
   candidates instead, live against your instance, and record which one worked:
   - `POST /me/api/json` with an empty body (retry once — some Jenkins/proxy
     configurations reject an empty content-type but accept `Content-Type:
     application/x-www-form-urlencoded` with an empty body)
   - `POST /api/json` at the Jenkins root with a `tree=` query parameter (e.g.
     `tree=mode`) — read-only, requires a crumb, never mutates anything

   Never pick a create/update/delete/build-trigger endpoint to prove this — the
   goal is only to prove crumb+session plumbing, not to exercise a write.

8. **If the crumb/session behavior differs from the pattern above** (e.g.
   proxy/session-affinity quirks causing repeated 403s even after the
   retry-once), note the exact delta observed (response body, headers, Jenkins
   version from `/api/json`'s `X-Jenkins` response header) — this is exactly the
   signal needed to adjust `jenkins/auth.ts`/`client.ts` before relying on this
   server against that instance.

## Development

```bash
npm run dev     # tsx watch src/index.ts
npm test        # vitest run
npm run lint    # biome check .
npm run format  # biome format --write .
```

## Safety

This server performs no destructive Jenkins operations. Every request is either
read-only (identity, and everything under `jenkins_bash`'s virtual filesystem)
or an explicit, user-requested build trigger/abort — never an unattended
create, update, or delete of jobs, credentials, or configuration.

The tool surface is structurally locked to exactly these four tools: both the
registration path and the exported tool-name list derive from a single
registry array in [src/server.ts](src/server.ts), and a test asserts the set
cannot drift. `jenkins_abort_build` deliberately stops at `/stop` and never
constructs the forceful `/term` or `/kill` escalation endpoints. See
`PROJECT.md`'s Out-of-Scope section for the full boundary.
