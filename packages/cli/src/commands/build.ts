/**
 * `jenkins build [build]` plus its control subcommands (READ-09,
 * CTRL-06/CTRL-07/CTRL-08, DIAG-03).
 *
 * `trigger`, `abort`, `wait` and `diagnose` live in THIS file because registering the
 * same top-level yargs command name twice replaces it rather than extending
 * it: every `build` subcommand must be declared from one module.
 *
 * There is deliberately no read-only mode here (SAFE-03 is an MCP concern) -
 * a human at a shell is the trust boundary.
 */

import {
  abortBuild,
  diagnoseBuild,
  formatAbortResult,
  formatBuildDetail,
  formatDiagnoseResult,
  formatTriggerResult,
  formatWaitResult,
  getBuildDetail,
  JenkinsError,
  triggerBuild,
  waitForBuild,
} from "@jenkins-mcp/core";
import type { Argv } from "yargs";
import { createSession } from "../client.js";
import { gitOriginUrl, resolveJob } from "../job.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar, GlobalArgs } from "./types.js";

/** The `--ref` option every build subcommand shares. */
function refOption<T>(yargs: Argv<T>) {
  return yargs.option("ref", {
    type: "string",
    describe: "Branch, tag or PR of a multibranch job, e.g. main, feature/foo, PR-42",
  });
}

/**
 * Parses repeatable `--param NAME=VALUE` flags. Only the FIRST `=` splits, so
 * a value containing `=` (a query string, a base64 blob) survives intact.
 */
function parseParams(raw: string[] | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const at = entry.indexOf("=");
    if (at <= 0) {
      throw new JenkinsError(
        `Invalid --param '${entry}'. Use --param NAME=VALUE.`,
        "jenkins_trigger_build",
        undefined,
        "invalid_input",
      );
    }
    out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

/**
 * An AbortSignal wired to SIGINT, so an UNBOUNDED `jenkins build wait` is
 * genuinely interruptible: Ctrl-C ends the wait and prints what it knows
 * (build number, elapsed time, stages so far) instead of killing the process
 * mid-poll with nothing to show for it. A second Ctrl-C still exits hard,
 * because the default handler is restored once the first one fires.
 */
function interruptSignal(): AbortSignal {
  const controller = new AbortController();
  const onSigint = () => {
    process.off("SIGINT", onSigint);
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  return controller.signal;
}

/** Resolves the job the way every command in this file does. */
async function session(argv: GlobalArgs) {
  const { client, cache, config } = createSession(argv);
  const job = await resolveJob({
    job: argv.job,
    remote: await gitOriginUrl(),
    client,
    cache,
    depth: config.indexDepth,
  });
  return { client, cache, config, job };
}

export const registerBuildCommand: CommandRegistrar = (cli) =>
  cli.command(
    "build [build]",
    "Inspect one build: status, cause, params, commits, stages, failed steps and " +
      "failed tests.",
    (yargs) =>
      refOption(
        yargs.positional("build", {
          type: "string",
          describe:
            "Build number, -1 for the most recent build, or a permalink alias " +
            "(lastBuild, lastSuccessfulBuild, lastFailedBuild, ...). Defaults to lastBuild.",
        }),
      )
        // ---------------------------------------------------------------
        // jenkins build trigger (CTRL-07)
        // ---------------------------------------------------------------
        .command(
          "trigger",
          "Trigger a build. Parameters are validated against the job's declared " +
            "parameters before anything is submitted.",
          (y) =>
            refOption(y)
              .option("param", {
                type: "string",
                array: true,
                describe: "Build parameter as NAME=VALUE. Repeatable.",
              })
              .option("rebuild-from", {
                type: "string",
                describe: "Reuse this build's parameters as the base map; --param overrides keys.",
              })
              .option("wait", {
                type: "boolean",
                default: false,
                describe: "Block until the triggered build finishes",
              })
              .option("timeout", {
                type: "number",
                describe: "Seconds to wait for a build number (default 15)",
              })
              .option("wait-timeout", {
                type: "number",
                describe: "Seconds to block with --wait (default: no limit; Ctrl-C to stop)",
              }),
          async (argv) => {
            try {
              const { client, cache, config, job } = await session(argv);
              const data = await triggerBuild(client, cache, {
                job,
                ref: argv.ref,
                depth: config.indexDepth,
                params: parseParams(argv.param),
                timeout: argv.timeout,
                rebuildFrom: argv.rebuildFrom,
                wait: argv.wait,
                // CLI `--wait` is UNBOUNDED (Phase 7 criterion 2): a human at a
                // shell can Ctrl-C, an agent cannot, which is the documented
                // difference between the two surfaces.
                waitTimeoutMs:
                  argv.waitTimeout === undefined
                    ? Number.POSITIVE_INFINITY
                    : argv.waitTimeout * 1000,
                signal: argv.wait ? interruptSignal() : undefined,
              });
              emit(argv.json, data, () => formatTriggerResult(data));
            } catch (err) {
              fail(err);
            }
          },
        )
        // ---------------------------------------------------------------
        // jenkins build abort [build] (CTRL-08)
        // ---------------------------------------------------------------
        .command(
          "abort [build]",
          "Gracefully abort a running build. Never escalates to /term or /kill.",
          (y) =>
            refOption(
              y.positional("build", {
                type: "string",
                describe: "Build number, -1, or a permalink alias. Defaults to lastBuild.",
              }),
            ),
          async (argv) => {
            try {
              const { client, cache, config, job } = await session(argv);
              const data = await abortBuild(client, cache, {
                job,
                ref: argv.ref,
                depth: config.indexDepth,
                build: argv.build ?? -1,
              });
              emit(argv.json, data, () => formatAbortResult(data));
            } catch (err) {
              fail(err);
            }
          },
        )
        // ---------------------------------------------------------------
        // jenkins build wait [build] (CTRL-06)
        // ---------------------------------------------------------------
        .command(
          "wait [build]",
          "Block until a build finishes, then print its result. A timeout prints the " +
            "build as still running rather than failing.",
          (y) =>
            refOption(
              y.positional("build", {
                type: "string",
                describe: "Build number, -1, or a permalink alias. Defaults to lastBuild.",
              }),
            )
              .option("timeout", {
                type: "number",
                describe: "Seconds to wait before giving up (default: no limit; Ctrl-C to stop)",
              })
              .option("since-cursor", {
                type: "string",
                describe: "Stage id from a previous wait: report transitions from it onward",
              })
              .option("log-cursor", {
                type: "number",
                describe: "Byte offset from a previous call: return the log lines written since",
              }),
          async (argv) => {
            try {
              const { client, cache, config, job } = await session(argv);
              const data = await waitForBuild(client, cache, {
                job,
                ref: argv.ref,
                build: argv.build,
                depth: config.indexDepth,
                // Unbounded by default (Phase 7 criterion 0). `Infinity` keeps
                // the loop's elapsed-time exit well-defined - unlike NaN, which
                // silently removes it - and Ctrl-C ends the wait via the signal.
                timeoutMs:
                  argv.timeout === undefined ? Number.POSITIVE_INFINITY : argv.timeout * 1000,
                sinceCursor: argv.sinceCursor,
                logCursor: argv.logCursor,
                signal: interruptSignal(),
              });
              emit(argv.json, data, () => formatWaitResult(data));
            } catch (err) {
              fail(err);
            }
          },
        )
        // ---------------------------------------------------------------
        // jenkins build diagnose [build] (DIAG-03)
        // ---------------------------------------------------------------
        .command(
          "diagnose [build]",
          "Explain why a build failed: the failed stage and step, the failed tests, and " +
            "the failed step's own log.",
          (y) =>
            refOption(
              y.positional("build", {
                type: "string",
                describe: "Build number, -1, or a permalink alias. Defaults to lastBuild.",
              }),
            ),
          async (argv) => {
            try {
              const { client, cache, config, job } = await session(argv);
              const data = await diagnoseBuild(client, cache, {
                job,
                ref: argv.ref,
                depth: config.indexDepth,
                build: argv.build,
              });
              emit(argv.json, data, () => formatDiagnoseResult(data));
            } catch (err) {
              fail(err);
            }
          },
        ),
    async (argv) => {
      try {
        const { client, cache, config, job } = await session(argv);
        const data = await getBuildDetail(client, cache, {
          job,
          ref: argv.ref,
          build: argv.build,
          depth: config.indexDepth,
        });
        emit(argv.json, data, () => formatBuildDetail(data));
      } catch (err) {
        fail(err);
      }
    },
  );
