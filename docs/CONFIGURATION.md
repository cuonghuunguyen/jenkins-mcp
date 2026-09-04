# Configuration

[← README](../README.md)

## MCP client configuration

`claude mcp add jenkins -- npx -y @cuonghuunguyen/jenkins-mcp` is the quickest
path. The equivalent JSON, for `.mcp.json` (Claude Code) or
`claude_desktop_config.json` (Claude Desktop) — replace the placeholders, and
never commit a real token:

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
server as a child process and does not resolve a relative path against the
repo.

## Environment variables

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
