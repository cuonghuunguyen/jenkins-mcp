# Setup guide

A step-by-step walkthrough to get `jenkins-mcp` connected to your Jenkins
instance and callable from Claude Code or Claude Desktop. For the tool
reference and safety model, see [README.md](README.md).

## 1. Prerequisites

- **Node.js >= 20** — check with `node --version`.
- **A Jenkins instance** you can reach over the network from the machine that
  will run the server.
- **A Jenkins account** whose permissions match what you want the agent to do:
  read access is enough for `jenkins_whoami` and `jenkins_bash`; triggering and
  aborting builds require the corresponding job permissions.

## 2. Create a Jenkins API token

The server authenticates with a per-user API token — **never** the account
password.

1. Log in to Jenkins as the account you want the server to act as.
2. Click your username (top-right) → **Configure**.
3. Under **API Token**, click **Add new Token**, give it a name (e.g.
   `jenkins-mcp`), and click **Generate**.
4. Copy the token **now** — Jenkins shows it only once. Keep the values for the
   next step:
   - `JENKINS_URL` — your instance base URL, e.g. `https://ci.example.com`
     (no trailing slash)
   - `JENKINS_USER` — the username the token belongs to
   - `JENKINS_API_TOKEN` — the token you just generated

If the token leaks or you rotate it, revoke it from the same **API Token**
screen and generate a new one.

## 3. Install and build

From the repository root:

```bash
npm install
npm run build
```

This produces `dist/index.js`, the stdio entrypoint the MCP host will spawn.
Note the **absolute** path to it — you'll need it in the next step:

```bash
echo "$(pwd)/dist/index.js"
```

## 4. Configure your MCP client

The server reads its three connection values from environment variables. It
does **not** read a `.env` file automatically — supply the values through your
MCP client's `env` block (recommended), or export them into the shell before a
manual run. [.env.example](.env.example) is a copyable template of the values.

### Claude Code

Add the server to your project or user MCP config. Using the CLI:

```bash
claude mcp add jenkins node /absolute/path/to/jenkins-mcp/dist/index.js \
  --env JENKINS_URL=https://ci.example.com \
  --env JENKINS_USER=your-jenkins-username \
  --env JENKINS_API_TOKEN=your-jenkins-api-token
```

(Flag syntax may vary by version; the equivalent JSON block below works
everywhere.)

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add
a `jenkins` entry under `mcpServers`:

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

Use the absolute path from step 3 — the host spawns the server as a child
process and will not resolve a relative path against this repo. Restart the
client (or reload the MCP config) after editing.

## 5. Verify the connection

Ask the assistant to run **`jenkins_whoami`** (or call it from the tools menu).
A successful response reads:

```
Authenticated as: your-jenkins-username
```

plus full name / authorities if Jenkins returns them. Anything else (a 401/403
or connection error) means the credentials or URL are wrong — see
Troubleshooting below.

Once `jenkins_whoami` works, try `jenkins_bash` to explore:

```bash
ls /jobs
```

## 6. Optional: verify without a client (MCP Inspector)

To exercise the server directly, export the credentials and drive it with the
MCP Inspector:

```bash
export JENKINS_URL="https://ci.example.com"
export JENKINS_USER="your-jenkins-username"
export JENKINS_API_TOKEN="your-jenkins-api-token"
export LOG_LEVEL=debug   # optional: see crumb/session detail on stderr

npx @modelcontextprotocol/inspector node dist/index.js
```

Then call `jenkins_whoami` (no arguments) from the Inspector UI. For the full
CSRF crumb + session round-trip verification — recommended the first time you
point the server at a new or upgraded Jenkins instance — follow the **Live
smoke test** section in [README.md](README.md).

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Server exits immediately, stderr names a variable | A required env var is missing or malformed. Set `JENKINS_URL`, `JENKINS_USER`, `JENKINS_API_TOKEN` in the client's `env` block. |
| `401 Unauthorized` from `jenkins_whoami` | Wrong username or token, or you used the account password. Regenerate the API token and re-check `JENKINS_USER`. |
| `403 Forbidden` even with a valid token | CSRF crumb/session issue (often behind a proxy). Set `LOG_LEVEL=debug` and follow the README's Live smoke test to capture the exact behavior. |
| Connection/timeout error | `JENKINS_URL` unreachable from this machine, wrong scheme/host, or a trailing slash. Confirm you can `curl` the URL from the same host. |
| Client doesn't list the tools | Wrong or relative path to `dist/index.js`, or you forgot to `npm run build`. Use the absolute path from step 3 and restart the client. |
| Output cut off with a truncation notice | `jenkins_bash` caps output at ~50KB. Narrow with `grep`/`tail`/`head` instead of `cat` on large logs. |

Secrets are always redacted from logs — if you ever see a raw token, crumb, or
cookie **value** on stderr, that is a bug worth reporting, not expected output.
