# @cuonghuunguyen/jenkins-cli

The `jenkins` CLI — the same Jenkins operations the
[MCP server](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-mcp) exposes, at a
shell. Compact, counted output that names the next call worth making, plus
`--json` on every command for the raw structured result.

```bash
npm install -g @cuonghuunguyen/jenkins-cli
```

```bash
export JENKINS_URL=https://ci.example.com
export JENKINS_USER=your-username
export JENKINS_API_TOKEN=your-api-token

jenkins whoami                    # who am I against Jenkins
jenkins jobs my-service           # find jobs by name, or by git remote
jenkins job                       # the job that builds this checkout
jenkins build                     # last build: cause, stages, failed tests
jenkins log --lines 200           # a bounded window of the console log
jenkins queue                     # what the queue is holding, and why
```

Requires Node.js >= 20 and an API token for the Jenkins account to act as.

Command reference and setup walkthrough:
https://github.com/cuonghuunguyen/jenkins-mcp#readme

MIT
