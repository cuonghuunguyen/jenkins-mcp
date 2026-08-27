# Setup guide

Getting `jenkins-mcp` connected to your Jenkins instance: the MCP server for
Claude Code / Claude Desktop, and the `jenkins` CLI for your shell. For the
tool reference and the safety model see [README.md](README.md); for what has
and has not been verified against a real instance see
[VERIFICATION.md](VERIFICATION.md).

## 1. Prerequisites

- **Node.js >= 20** — `node --version`.
- **pnpm 10** — `pnpm --version`. `corepack enable` if you do not have it.
- **A Jenkins instance** reachable from the machine that will run the server.
- **A Jenkins account** whose permissions match what you want done: Overall/Read
  plus Job/Read is enough for all 9 read tools; `jenkins_trigger_build` needs
  Job/Build and `jenkins_abort_build` needs Job/Cancel.

## 2. Create a Jenkins API token

The server authenticates with a per-user API token — **never** the account
password.

1. Log in to Jenkins as the account you want the server to act as.
2. Click your username (top-right) → **Configure**.
3. Under **API Token**, click **Add new Token**, name it (e.g. `jenkins-mcp`),
   and click **Generate**.
4. Copy the token **now** — Jenkins shows it once. Keep three values:
   - `JENKINS_URL` — instance base URL, e.g. `https://ci.example.com` (no
     trailing slash)
   - `JENKINS_USER` — the username the token belongs to
   - `JENKINS_API_TOKEN` — the token you just generated

If the token leaks or you rotate it, revoke it from the same screen and
generate a new one.

## 3. Install and build

This is a pnpm workspace. `npm ci` will not build it, and the git-`npx` install
path does not work — there is no `prepare` script.

```bash
git clone https://github.com/cuonghuunguyen/jenkins-mcp.git
cd jenkins-mcp
pnpm install
pnpm build
```

Two entrypoints come out:

```bash
echo "$(pwd)/packages/mcp/dist/index.js"   # MCP server — the host spawns this
echo "$(pwd)/packages/cli/dist/index.js"   # jenkins CLI
```

Note the **absolute** MCP path; the next step needs it.

## 4. Configure your MCP client

The server reads its values from environment variables. It does **not** read a
`.env` file. Supply them through the client's `env` block.

### Claude Code

```bash
claude mcp add jenkins -- node /absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js
```

Then add the credentials to the generated entry, or use the JSON form below.
(`claude mcp add` flag syntax varies by version; the JSON block works
everywhere.)

### Claude Desktop

Settings → Developer → Edit Config, then merge into `mcpServers`:

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "node",
      "args": ["/absolute/path/to/jenkins-mcp/packages/mcp/dist/index.js"],
      "env": {
        "JENKINS_URL": "https://ci.example.com",
        "JENKINS_USER": "your-jenkins-username",
        "JENKINS_API_TOKEN": "your-jenkins-api-token"
      }
    }
  }
}
```

Use the absolute path from step 3 — the host spawns the server as a child
process and will not resolve a relative path against this repo. Restart the
client (or reload its MCP config) after editing.

To hand out a read-only server, add `"JENKINS_MCP_READONLY": "1"` to the `env`
block. The two write tools are then never registered and the client sees 9
tools instead of 11.

## 5. Verify the MCP connection

Ask the assistant to call **`jenkins_whoami`** (no arguments). Success:

```
authenticated: svc-ci
fullName: CI Service Account
url: https://jenkins.example.com/user/svc-ci
next: jenkins_find_jobs to locate a job on this instance
```

Then **`jenkins_find_jobs`** with no query, which proves the job index reads:

```
jobs (4)
fullName                          type/status          lastBuild  age
team-a/api-service                multibranch/unknown  -          -
team-a/api-service/main           pipeline/success     #118       3h
team-a/api-service/PR-42          pipeline/failed      #7         1d
...
```

Anything else — a one-line `error: auth_failed` / `error: forbidden` /
`error: unreachable` — means the credentials or the URL are wrong. See
Troubleshooting.

## 6. Install the `jenkins` CLI

Optional, and independent of the MCP server. Install a wrapper rather than a
symlink: `tsc` emits `dist/index.js` without the executable bit, so a symlink
breaks after every rebuild.

```bash
mkdir -p ~/.local/bin        # make sure this is on your PATH
printf '#!/bin/sh\nexec node "%s" "$@"\n' "$PWD/packages/cli/dist/index.js" > ~/.local/bin/jenkins
chmod +x ~/.local/bin/jenkins
jenkins --version            # 0.2.0
```

Give it credentials the same three ways the server takes them, or per command:

```bash
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=your-jenkins-username
export JENKINS_API_TOKEN=your-jenkins-api-token

jenkins whoami
# or, without exporting anything:
jenkins whoami --url https://ci.example.com --user alice --token THE_TOKEN
```

With no credentials at all it fails in one line rather than hanging:

```
error: invalid_input — jenkins-mcp: invalid or missing configuration for: jenkinsUrl, jenkinsUser, jenkinsApiToken. Set JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN in the MCP client's env block. Or pass --url, --user and --token.
```

From inside a git checkout that Jenkins builds, most commands need no `--job`:

```bash
jenkins jobs find          # resolves the origin remote against the job index
jenkins build --ref main   # the last build of that job's main branch
jenkins log --ref main --mode failed   # the window around the failure
jenkins log --ref main --save-to ''    # the whole raw log under .jenkins-mcp/cli/
```

`jenkins --help` and `jenkins <command> --help` are the full reference.

## 7. Optional: drive the server without a client

```bash
export JENKINS_URL="https://ci.example.com"
export JENKINS_USER="your-jenkins-username"
export JENKINS_API_TOKEN="your-jenkins-api-token"
export LOG_LEVEL=debug   # optional: crumb/session detail on stderr

npx @modelcontextprotocol/inspector node packages/mcp/dist/index.js
```

Call `jenkins_whoami` (no arguments) from the Inspector UI. That proves the URL,
the credentials and Basic auth — it is a **GET** to `/me/api/json`, so it does
**not** exercise the CSRF crumb + session round-trip. Only `jenkins_trigger_build`
and `jenkins_abort_build` issue a non-GET request, so only those two prove the
crumb path. The full live checklist — a real multibranch job, a real PR build,
trigger and abort — is [VERIFICATION.md](VERIFICATION.md).

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Server exits immediately, stderr names a field | A required env var is missing or malformed. Set `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` in the client's `env` block. The message names the field, never the value. |
| `error: auth_failed` (401) | Wrong username or token, or the account password was used. Regenerate the API token and re-check `JENKINS_USER`. |
| `error: forbidden` (403) on a read | The account lacks Overall/Read or Job/Read on that job. |
| `error: forbidden` (403) on trigger or abort | Either the account lacks Job/Build / Job/Cancel, or the CSRF crumb round-trip is failing (common behind a proxy). Set `LOG_LEVEL=debug` and read stderr. |
| `error: unreachable` | `JENKINS_URL` not reachable from this machine, wrong scheme/host, or a trailing slash. `curl` the URL from the same host. |
| `error: not_found` on a job that exists | The `job` is a fullName with `/` between folder levels, not a URL. A branch is a `ref`, not part of `job`. Find the exact name with `jenkins_find_jobs`. |
| Client lists 9 tools, not 11 | `JENKINS_MCP_READONLY` is set to `1`/`true` somewhere in the environment the host passes down. |
| Client lists no tools | Wrong or relative path in `args`, or `pnpm build` was not run. Use the absolute path to `packages/mcp/dist/index.js` and restart the client. |
| `error: invalid_input — ... tree ...` from `jenkins_api_get` | `tree=` is mandatory for `api/json`, `api/xml` and `api/python`. Name the fields you need, e.g. `tree=jobs[fullName,color]`. |
| A log result looks cut off | It says so, and names the exact follow-up call — `mode=range` for the surrounding lines, `mode=grep` to search, `save_to` to write the whole raw log to a file. |
| `jenkins` says it cannot determine the job | Not in a git checkout, no `origin`, or no job on this Jenkins builds that remote. Pass `--job`, or set `JENKINS_JOB`. |
| `jenkins build wait` never returns | It is unbounded on the CLI by design. Ctrl-C ends it and prints what it knows; pass `--timeout <seconds>` for a bound. The MCP tool defaults to 120s instead. |
| `jenkins build wait` printed nothing until it finished | Correct: the CLI does not stream. Stage transitions and new log lines are returned when the wait ENDS. For live progress, loop `jenkins build wait --timeout 30 --since-cursor <id> --log-cursor <n>`, feeding back the cursors it prints. |
| `jenkins build wait` says `PAUSED — waiting for input` | The pipeline is blocked on an `input` step. Waiting longer cannot help — a human answers it in the Jenkins UI, or `jenkins build abort` stops it. |
| `jenkins <cmd> <subcmd> --help` shows the root help | Known defect in the nested-subcommand help wiring. `jenkins build --help` lists the subcommands; see [README.md](README.md) for their options. |

Secrets are always redacted from logs — if you ever see a raw token, crumb or
cookie **value** on stderr, that is a bug worth reporting, not expected output.
