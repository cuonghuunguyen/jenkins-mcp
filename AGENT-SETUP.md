# Agent guide: install jenkins-mcp into any project

You are an AI coding agent. This file tells you how to wire the **jenkins-mcp**
server into whatever project you are currently working in, so the user's MCP
host (Claude Code / Claude Desktop) can call its tools. Follow the steps in
order. Do not skip verification. Never commit secrets.

## 0. What you're installing

`jenkins-mcp` is a stdio MCP server over a single Jenkins instance. The host
spawns it as a child process and it reads its configuration from the `env`
block it is given — nothing else.

**11 tools**, of which exactly two write:

| Tool | Writes |
|------|--------|
| `jenkins_whoami` | no |
| `jenkins_find_jobs` | no |
| `jenkins_job` | no |
| `jenkins_build` | no |
| `jenkins_log` | no |
| `jenkins_queue` | no |
| `jenkins_api_get` | no |
| `jenkins_wait_build` | no |
| `jenkins_diagnose_build` | no |
| `jenkins_trigger_build` | **yes** |
| `jenkins_abort_build` | **yes** |

With `JENKINS_MCP_READONLY=1` the last two are not registered at all and the
host sees 9 tools. The remaining 9 issue **no** non-GET request — that is
asserted behaviourally, by invoking every read-only tool against a client whose
`post` fails the test if it is called.

The same repo also ships a `jenkins` CLI (`packages/cli`). It is not part of
the MCP install; mention it to the user only if they want a shell surface. The
CLI has no read-only mode: a shell already has a user behind it.

Two things worth telling the user up front, because they surprise people:

- **`jenkins_wait_build` defaults to a 120s bound** and always returns — on
  completion, on the timeout, or as soon as a pipeline pauses on an `input`
  step, which never finishes on its own. Pass `since_cursor` and `log_cursor`
  from the previous call to get stage transitions and log lines as a delta.
- **Nothing streams.** Stage transitions and new log lines come back when the
  wait ends, not while it runs.

## 1. Gather the required inputs

Confirm you have all of these before touching config. Ask the user for any that
are missing — do **not** invent them:

| Value | What it is | Example |
|-------|-----------|---------|
| `JENKINS_URL` | Base URL of the Jenkins instance, **no trailing slash** | `https://ci.example.com` |
| `JENKINS_USER` | Username the API token belongs to | `alice` |
| `JENKINS_API_TOKEN` | Per-user API token — **never** the account password | `11a2…` |

Token creation (if the user doesn't have one): Jenkins → click username →
**Configure** → **API Token** → **Add new Token** → **Generate**. It is shown
once.

## 2. Get an entrypoint the host can spawn

This is a pnpm workspace. There is **no** registry package and **no** working
git-`npx` form (no `prepare` script), so a local checkout and build is the only
path.

```bash
cd /path/to/jenkins-mcp
node --version          # must be >= 20; stop and tell the user if not
pnpm --version          # 10.x; `corepack enable` if missing
pnpm install
pnpm build              # produces packages/mcp/dist/index.js
echo "$(pwd)/packages/mcp/dist/index.js"   # <-- ABSOLUTE path; copy it
```

- `command`: `node`
- `args`: `["<absolute path to packages/mcp/dist/index.js>"]`

The host will not resolve a relative path against the target project — use the
**absolute** path. If the user has no checkout, clone it first:
`git clone https://github.com/cuonghuunguyen/jenkins-mcp.git`.

## 3. Choose the scope

- **User scope** — private to this user across all projects. Use this for a
  personal token. This is the safe default when in doubt.
- **Project scope** (`.mcp.json` in the target project root) — shared with
  anyone who opens the project. Use it when the whole team should get the
  server. **Do not put the real token in a committed file** — reference an env
  var the user's shell provides.

Ask the user which they want if it isn't obvious. Default to **user scope** so
the token never lands in the repo.

For a shared/project scope, add `"JENKINS_MCP_READONLY": "1"` unless the user
explicitly wants the team to trigger and abort builds through the agent: it
removes the only two tools that can change Jenkins state, so a shared config
cannot start or kill someone else's build by accident.

## 4. Write the configuration

`jenkins-mcp` reads its values **only** from environment variables passed by
the host — it does not auto-load a `.env` file.

### Claude Code — CLI (preferred; picks the scope with a flag)

```bash
# user scope (private, default):
claude mcp add jenkins --scope user \
  node /absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js \
  --env JENKINS_URL=https://ci.example.com \
  --env JENKINS_USER=alice \
  --env JENKINS_API_TOKEN=THE_TOKEN

# project scope (shared, writes .mcp.json):
claude mcp add jenkins --scope project \
  node /absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js \
  --env JENKINS_URL=https://ci.example.com \
  --env JENKINS_USER=alice \
  --env JENKINS_MCP_READONLY=1
```

Flag syntax varies by Claude Code version. If `claude mcp add` rejects the
form, write the JSON block instead.

### Claude Code / Desktop — JSON block

Project scope goes in `.mcp.json` (project root). Claude Desktop goes in
`claude_desktop_config.json` (Settings → Developer → Edit Config). Merge this
under `mcpServers`, don't overwrite existing entries:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js"],
      "env": {
        "JENKINS_URL": "https://ci.example.com",
        "JENKINS_USER": "alice",
        "JENKINS_API_TOKEN": "${JENKINS_API_TOKEN}",
        "JENKINS_MCP_READONLY": "1"
      }
    }
  }
}
```

**Secrets rule:** if the config file is committed (project-scoped `.mcp.json`),
do NOT hardcode the token. Use `"${JENKINS_API_TOKEN}"` (expanded from the
user's shell/host env) or keep the whole server config in user scope. If you
write a plaintext token into any file, tell the user and confirm the file is
gitignored.

Optional tuning, only if the user asks:

| Variable | Default | Effect |
|----------|---------|--------|
| `JENKINS_INDEX_DEPTH` | `6` | Folder nesting depth the one-request job index walks. Raise it if `jenkins_find_jobs` reports dropped folders. |
| `JENKINS_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout. |
| `LOG_LEVEL` | `info` | `debug` for crumb/session detail on stderr. |

After editing a JSON file, the host must reload — restart Claude Desktop, or in
Claude Code the new server is picked up on next launch / `/mcp` reconnect.

## 5. Verify

1. List servers: `claude mcp list` — `jenkins` should appear and connect.
2. Call `jenkins_whoami` (no arguments). Success looks like:

   ```
   authenticated: alice
   fullName: Alice Ng
   url: https://ci.example.com/user/alice
   next: jenkins_find_jobs to locate a job on this instance
   ```

   This proves the URL, the credentials and Basic auth. It does **not** prove
   the CSRF crumb + session round-trip: `jenkins_whoami` is a **GET** to
   `/me/api/json`. Only `jenkins_trigger_build` and `jenkins_abort_build`
   issue a non-GET request, so only those two exercise the crumb path — which
   is why a read-only install can be complete without ever testing it.
3. Call `jenkins_find_jobs` with no query. A table of jobs with a count proves
   read access and the job index. An empty index with a `depthCap` note means
   the account can see nothing, not that Jenkins is empty.
4. Check the tool count matches the scope you chose: 11 tools normally, 9 with
   `JENKINS_MCP_READONLY=1`.

If the user has a multibranch job, one more call is worth making: `jenkins_job`
with `job` set and `ref` omitted lists the branches, `PR-<n>` and tags. A bare
integer `ref` (`"42"`) means `PR-42`, and it means that identically in all
seven ref-taking tools.

If you can't drive the host directly, run the server standalone to prove the
credentials before blaming config:

```bash
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=alice
export JENKINS_API_TOKEN=THE_TOKEN
export LOG_LEVEL=debug
npx @modelcontextprotocol/inspector node /absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js
```

## 6. Troubleshooting map

| Symptom | Fix |
|---------|-----|
| Server exits immediately, stderr names a field | A required env var is missing/malformed. Recheck the `env` block. The message names the field, never the value. |
| `error: auth_failed` (401) on `jenkins_whoami` | Wrong user/token, or password used instead of token. Regenerate the token, recheck `JENKINS_USER`. |
| `error: forbidden` (403) on a read | The account lacks Overall/Read or Job/Read. |
| `error: forbidden` (403) only on trigger/abort | Missing Job/Build or Job/Cancel, or the crumb round-trip is failing behind a proxy. `LOG_LEVEL=debug` and read stderr. |
| `error: unreachable` | `JENKINS_URL` not reachable from this host, wrong scheme, or a trailing slash. `curl` it from the same machine. |
| `error: not_found` on a job that exists | `job` is a fullName (`team-a/my-service`), not a URL; a branch goes in `ref`, not in `job`. Use `jenkins_find_jobs` to get the exact name. |
| Host lists 9 tools, not 11 | `JENKINS_MCP_READONLY` is set — intended for a shared scope. Remove it if the user wants trigger/abort. |
| Host lists no tools | Relative/wrong path in `args`, or `pnpm build` not run. Use the absolute path to `packages/mcp/dist/index.js` and reload the host. |
| `invalid_input` about `tree` from `jenkins_api_get` | `tree=` is mandatory for `api/json`, `api/xml`, `api/python`. Name only the fields needed. |
| A result looks truncated | It says so and names the exact follow-up call. Make that call rather than re-reading with a larger window. |
| `jenkins_wait_build` returns "still BUILDING — wait timed out" | Expected at the 120s default. Call it again with the `since_cursor` and `log_cursor` it printed; raise `timeout_s` if the user wants a longer block. |
| `jenkins_wait_build` returns `PAUSED — waiting for input` | The pipeline is blocked on an `input` step. Do not retry: a human answers it in the Jenkins UI, or `jenkins_abort_build` stops the build. |
| `jenkins_trigger_build` returned `queued:` with a `queueId` | The bounded wait for a real build number elapsed. That is a queue id, **not** a build number. Call `jenkins_queue`, or `jenkins_job` to see whether it has started. Do not re-trigger. |
| `jenkins_trigger_build` returned a build number plus a `warning:` | The POST succeeded and the follow-up failed. The build IS running. Do not re-trigger; use the build number it named. |
| `jenkins_log` with `save_to` wrote nested directories | Intended: `.jenkins-mcp/cli/<job>/<ref>/<build>.log` keeps the job path as real directories. Add `.jenkins-mcp/` to the project's `.gitignore`. |

## 7. Done checklist

- [ ] Node >= 20, pnpm 10, and `packages/mcp/dist/index.js` exists
- [ ] Server registered at the chosen scope, with an absolute path
- [ ] Token is NOT hardcoded in any committed file
- [ ] `JENKINS_MCP_READONLY=1` set for a shared/project scope, unless the user
      asked for trigger/abort
- [ ] `jenkins_whoami` returns the expected identity
- [ ] `jenkins_find_jobs` returns a job table
- [ ] Tool count is 11 (or 9 read-only), as expected for the chosen scope
