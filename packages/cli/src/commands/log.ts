/**
 * `jenkins log [build]` (READ-10, READ-11).
 *
 * Argument parsing only - the modes, the caps and the `save_to` containment
 * rules all live in core's `getBuildLog`, so this command and `jenkins_log`
 * cannot drift (ARCH-03).
 */

import { formatLogResult, getBuildLog, type LogMode } from "@cuonghuunguyen/jenkins-core";
import { createSession } from "../client.js";
import { gitOriginUrl, resolveJob } from "../job.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

const MODES: LogMode[] = ["tail", "grep", "range", "step", "failed"];

export const registerLogCommand: CommandRegistrar = (cli) =>
  cli.command(
    "log [build]",
    "Read a bounded window of a build's console log.",
    (yargs) =>
      yargs
        .positional("build", {
          type: "string",
          describe: "Build number, -1, or a permalink alias. Defaults to lastBuild.",
        })
        .option("ref", {
          type: "string",
          describe: "Branch, tag or PR of a multibranch job, e.g. main, feature/foo, PR-42",
        })
        .option("mode", {
          choices: MODES,
          default: "tail" as LogMode,
          describe: "Which window to return",
        })
        .option("lines", { type: "number", describe: "mode=tail: trailing lines (default 100)" })
        .option("pattern", { type: "string", describe: "mode=grep: a regular expression" })
        .option("context", {
          type: "number",
          describe:
            "mode=grep: context lines either side of a hit (default 2). " +
            "mode=failed: lines either side of the failure anchor (default 60/20)",
        })
        .option("max-matches", {
          type: "number",
          describe: "mode=grep: stop scanning after this many matches (default 200)",
        })
        .option("from", {
          type: "number",
          describe:
            "mode=range: first line, 1-based inclusive; negative is end-relative (-1 = last)",
        })
        .option("to", {
          type: "number",
          describe: "mode=range: last line, inclusive; negative is end-relative",
        })
        .option("step", { type: "string", describe: "mode=step: the pipeline stage name" })
        .option("clean", {
          type: "boolean",
          default: true,
          describe: "Strip ANSI escapes and Jenkins timestamp prefixes (--no-clean to keep them)",
        })
        .option("cursor", {
          type: "number",
          describe: "Byte offset from a previous call: fetch only what was written since",
        })
        .option("save-to", {
          type: "string",
          describe:
            "Write the full RAW log here and print a summary instead. Relative to the " +
            "current directory; pass '' for .jenkins-mcp/cli/<job>/<ref>/<build>.log",
        }),
    async (argv) => {
      try {
        const { client, cache, config } = createSession(argv);
        const job = await resolveJob({
          job: argv.job,
          remote: await gitOriginUrl(),
          client,
          cache,
          depth: config.indexDepth,
        });

        const data = await getBuildLog(client, cache, {
          job,
          ref: argv.ref,
          build: argv.build,
          depth: config.indexDepth,
          mode: argv.mode,
          lines: argv.lines,
          pattern: argv.pattern,
          context: argv.context,
          maxMatches: argv.maxMatches,
          from: argv.from,
          to: argv.to,
          step: argv.step,
          clean: argv.clean,
          cursor: argv.cursor,
          saveTo: argv.saveTo,
        });

        emit(argv.json, data, () => formatLogResult(data));
      } catch (err) {
        fail(err);
      }
    },
  );
