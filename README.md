# jenkins-mcp

An MCP (Model Context Protocol) server, written in TypeScript/Node and speaking
stdio, that lets Claude Code and Claude Desktop connect to and query a single
Jenkins instance. Phase 1 delivers the foundation: config loading, a CSRF
crumb/session-aware Jenkins HTTP client, a job-path resolver, and one
proof-of-life tool, `jenkins_whoami`.

## Requirements

- Node.js >= 20
- A reachable Jenkins instance and an API token for the account you want the
  server to authenticate as

## Installation

```bash
npm install
npm run build
```

This produces `dist/index.js`, the server's stdio entrypoint.

## Configuration

The server reads exactly three environment variables at boot (env-only,
zod-validated, fail-fast — no config file or dotenv source in v1):

| Variable | Required | Description |
|----------|----------|-------------|
| `JENKINS_URL` | yes | Base URL of the target Jenkins instance, e.g. `https://ci.example.com` (no trailing slash) |
| `JENKINS_USER` | yes | Jenkins username the API token belongs to |
| `JENKINS_API_TOKEN` | yes | An API token for that user — Jenkins -> user -> Configure -> API Token -> Add new Token (never use the account password) |

On missing/malformed config the server prints an actionable message naming
the offending variable(s) to stderr (never echoing the token value) and exits
non-zero. It will not start with invalid config.

Optional:

| Variable | Default | Description |
|----------|---------|--------------|
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. Set to `debug` to see crumb-fetch/cookie-reuse detail on stderr while diagnosing connectivity. |

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

For Claude Code, this block goes in the project or user MCP config (`claude
mcp add` or the equivalent config file); for Claude Desktop, in
`claude_desktop_config.json`'s `mcpServers` section. Use an absolute path to
`dist/index.js` — the host spawns the server as a child process and does not
resolve relative paths against this repo.

## Tools

### `jenkins_whoami`

Returns the identity and permissions the server is currently authenticated as
against the connected Jenkins instance. Takes no input. Use it first, after
wiring the client config above, to confirm connectivity and that the
configured credentials resolve to the expected account.

Internally this issues a crumb-protected, session-persisted **POST** (not an
anonymous GET) to `/me/api/json` — this doubles as the connectivity check and
as the project's proof that write-shaped requests correctly attach a CSRF
crumb over a persisted session (CONN-02). `/me/api/json` returns only
already-public, read-only identity data for the authenticated user, so this
POST never creates, updates, or deletes anything.

## Live smoke test (crumb + session round-trip)

Jenkins CSRF crumbs are bound to the session that issued them since Jenkins
2.176.2, and native `fetch` has no built-in cookie jar — so the mocked unit
tests in this repo cannot prove the real round-trip end to end. This
procedure is the authoritative, human-run verification of that behavior
against your **real** target Jenkins instance. Run it once whenever you point
this server at a new/upgraded Jenkins instance.

**Prerequisites:** a real `JENKINS_URL`, `JENKINS_USER`, and
`JENKINS_API_TOKEN` for an account with permission to view its own `/me`
page.

1. **Build the server:**
   ```bash
   npm run build
   ```

2. **(Optional but recommended) Enable debug logging** so you can see the
   crumb fetch and cookie reuse on stderr:
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
   - Configure Claude Code/Desktop with the client config snippet above
     (using these same env values) and invoke `jenkins_whoami` through the
     assistant, or
   - Drive it directly with the MCP Inspector:
     ```bash
     npx @modelcontextprotocol/inspector node dist/index.js
     ```
     then call `jenkins_whoami` with no arguments from the Inspector UI.

5. **Confirm the result is a real identity, not an error:** the response
   should read `Authenticated as: <your-jenkins-username>` (plus full name /
   authorities if Jenkins returns them) — not a 401/403/connection-error
   message.

6. **Confirm the round-trip was write-shaped (crumb + session), not an
   anonymous GET.** With `LOG_LEVEL=debug` you should see a crumb-issuer
   fetch followed by the `/me/api/json` POST reusing the same session cookie
   captured from that fetch. No `Authorization`, `Jenkins-Crumb`, or `Cookie`
   header **value** should ever appear in the log output — the logger
   redacts these; if you ever see a raw token/crumb/cookie value on stderr,
   that is a bug, not evidence of success.

7. **405 fallback — if `POST /me/api/json` returns `405 Method Not
   Allowed`:** do not fall back to a mutating endpoint. Hand-test one of
   these non-mutating candidates instead, live against your instance, and
   record which one worked here:
   - `POST /me/api/json` with an empty body (retry once — some Jenkins/proxy
     configurations reject an empty content-type but accept
     `Content-Type: application/x-www-form-urlencoded` with an empty body)
   - `POST /api/json` at the Jenkins root with a `tree=` query parameter
     (e.g. `tree=mode`) — read-only, requires a crumb, never mutates
     anything

   Never pick a create/update/delete/build-trigger endpoint to prove this
   (SAFE-01) — the goal is only to prove crumb+session plumbing, not to
   exercise a write.

8. **If the crumb/session behavior differs from the pattern above** (e.g.
   proxy/session-affinity quirks causing repeated 403s even after the
   retry-once), note the exact delta observed (response body, headers,
   Jenkins version from `/api/json`'s `X-Jenkins` response header) — this
   is exactly the signal needed to adjust `jenkins/auth.ts`/`client.ts`
   before relying on this server against that instance.

**Status of this proof in this repository:** the code path is implemented
and unit-tested with mocked `fetch` (`src/jenkins/auth.test.ts`,
`src/jenkins/client.test.ts`). The live round-trip against a real Jenkins
instance described above has **not yet been run** — it requires an operator
with real `JENKINS_URL`/`JENKINS_USER`/`JENKINS_API_TOKEN` values and a
reachable instance, which were not available in the environment that built
this server. Run the procedure above before relying on this server against
your Jenkins instance, and update this section with the verified endpoint
(`POST /me/api/json`, or the 405-fallback candidate that worked) once done.

## Development

```bash
npm run dev     # tsx watch src/index.ts
npm test        # vitest run
npm run lint    # biome check .
npm run format  # biome format --write .
```

## Safety

This server performs no destructive Jenkins operations. Every write-shaped
request proven or planned in this project is non-mutating (read-only
identity/status data) or, in later phases, an explicit trigger/abort the user
requests — never an unattended create/update/delete (see `PROJECT.md`'s
Out-of-Scope section).
