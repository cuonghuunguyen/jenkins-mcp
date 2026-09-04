#!/usr/bin/env node
/**
 * `jenkins` CLI root parser (ARCH-02).
 *
 * Every command shares the core operations and formatters the MCP server uses;
 * this package only parses arguments and chooses between `--json` (the
 * operation's raw return value) and the core formatter's text.
 */

import { formatErrorLine } from "@cuonghuunguyen/jenkins-core";
import yargs, { type Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import { registerApiCommand } from "./commands/api.js";
import { registerBuildCommand } from "./commands/build.js";
import { registerJobCommand } from "./commands/job.js";
import { registerJobsCommands } from "./commands/jobs.js";
import { registerLogCommand } from "./commands/log.js";
import { registerQueueCommand } from "./commands/queue.js";
import type { GlobalArgs } from "./commands/types.js";
import { registerWhoamiCommand } from "./commands/whoami.js";

const cli = yargs(hideBin(process.argv))
  .scriptName("jenkins")
  .usage("$0 <command> [options]")
  .option("job", {
    alias: "j",
    type: "string",
    describe:
      "Job fullName, e.g. team-a/my-service. Defaults to the job that builds the " +
      "git origin remote of the current checkout.",
    global: true,
  })
  .option("json", {
    type: "boolean",
    default: false,
    describe: "Emit the raw structured result as JSON instead of formatted text",
    global: true,
  })
  .option("url", {
    type: "string",
    describe: "Jenkins base URL (overrides JENKINS_URL)",
    global: true,
  })
  .option("user", {
    type: "string",
    describe: "Jenkins username (overrides JENKINS_USER)",
    global: true,
  })
  .option("token", {
    type: "string",
    describe: "Jenkins API token (overrides JENKINS_API_TOKEN)",
    global: true,
  });

// yargs infers a per-call option shape the command registrars cannot name, so
// the root parser is pinned to the GlobalArgs contract they all share.
const root = cli as unknown as Argv<GlobalArgs>;

const parser = [
  registerWhoamiCommand,
  registerJobsCommands,
  registerJobCommand,
  registerBuildCommand,
  registerLogCommand,
  registerQueueCommand,
  registerApiCommand,
].reduce((acc, register) => register(acc), root);

parser
  .demandCommand(1, "Specify a command. Run `jenkins --help` to see what is available.")
  .strict()
  .recommendCommands()
  .help()
  .alias("help", "h")
  .version()
  .wrap(Math.min(100, process.stdout.columns ?? 100))
  .fail((msg, err) => {
    process.stderr.write(`${msg ?? formatErrorLine(err)}\n`);
    process.exit(1);
  })
  .parse();
