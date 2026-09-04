# @cuonghuunguyen/jenkins-core

The Jenkins client, operations and formatters shared by
[`@cuonghuunguyen/jenkins-mcp`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-mcp) and
[`@cuonghuunguyen/jenkins-cli`](https://www.npmjs.com/package/@cuonghuunguyen/jenkins-cli).

Every capability is an operation that returns a structured result plus a
formatter that renders it as compact, counted, truncation-honest text. Both
surfaces call the same pair, which is why a shell answer and a tool answer are
byte-identical apart from the `next:` vocabulary.

```bash
npm install @cuonghuunguyen/jenkins-core
```

```ts
import {
  createJenkinsClient,
  findJobs,
  formatJobSearch,
  JenkinsCache,
  loadConfig,
} from '@cuonghuunguyen/jenkins-core'

const config = loadConfig(process.env) // JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN
const client = createJenkinsClient(config)
const cache = new JenkinsCache()

const result = await findJobs(client, cache, {
  query: 'my-service',
  depth: config.indexDepth,
})
console.log(formatJobSearch(result))
```

Requires Node.js >= 20.

Full documentation, configuration and the operation reference:
https://github.com/cuonghuunguyen/jenkins-mcp#readme

MIT
