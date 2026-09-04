import { formatJobDetail, getJobDetail } from "@cuonghuunguyen/jenkins-core";
import { createSession } from "../client.js";
import { gitOriginUrl, resolveJob } from "../job.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

// ---------------------------------------------------------------------------
// jenkins job [ref]
// ---------------------------------------------------------------------------

export const registerJobCommand: CommandRegistrar = (cli) =>
  cli.command(
    "job [ref]",
    "Inspect one job: parameters and last 10 builds, or the branches/PRs/tags of a " +
      "multibranch parent.",
    (yargs) =>
      yargs.positional("ref", {
        type: "string",
        describe: "Branch, tag or PR of a multibranch job (a bare number means PR-<n>)",
      }),
    async (argv) => {
      try {
        const { client, cache, config } = createSession(argv);

        // --job, then JENKINS_JOB, then the job that builds this checkout's
        // origin remote - so `jenkins job` with no arguments works from inside
        // a repo (ARCH-02).
        const job = await resolveJob({
          job: argv.job,
          remote: await gitOriginUrl(),
          client,
          cache,
          depth: config.indexDepth,
        });

        const data = await getJobDetail(client, cache, {
          job,
          ref: argv.ref,
          depth: config.indexDepth,
        });
        emit(argv.json, data, () => formatJobDetail(data));
      } catch (err) {
        fail(err);
      }
    },
  );
