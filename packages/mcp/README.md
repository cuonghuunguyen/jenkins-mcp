# @cuonghuunguyen/jenkins-mcp

An MCP server exposing 11 Jenkins tools — find jobs, inspect a job, build, log
or queue, diagnose a failure, trigger, wait, abort — over stdio or streamable
HTTP. Built for coding agents rather than for browsing Jenkins: output is
compact, counted, truncation-honest, and always ends with the next call worth
making.

**Exactly two tools write**: `jenkins_trigger_build` and `jenkins_abort_build`.
With `JENKINS_MCP_READONLY=1` neither is registered, so an agent enumerating
tools never sees a capability it cannot use.

## Install

```bash
claude mcp add jenkins \
  -e JENKINS_URL=https://ci.example.com \
  -e JENKINS_USER=your-username \
  -e JENKINS_API_TOKEN=your-api-token \
  -- npx -y @cuonghuunguyen/jenkins-mcp
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

Requires Node.js >= 20 and an API token for the Jenkins account to act as.

Tool reference, addressing rules and setup walkthrough:
https://github.com/cuonghuunguyen/jenkins-mcp#readme

MIT
