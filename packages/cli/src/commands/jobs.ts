import { findJobs, formatJobSearch } from "@cuonghuunguyen/jenkins-core";
import { createSession } from "../client.js";
import { gitOriginUrl } from "../job.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

// ---------------------------------------------------------------------------
// jenkins jobs find [query]
// ---------------------------------------------------------------------------

export const registerJobsCommands: CommandRegistrar = (cli) =>
  cli.command("jobs <command>", "Find jobs by name or by the git remote they build.", (yargs) =>
    yargs
      .command(
        "find [query]",
        "Find jobs by fullName substring or git remote URL. With no query, " +
          "resolves the current checkout's origin remote.",
        (y) =>
          y
            .positional("query", {
              type: "string",
              describe: "fullName substring, or a git remote URL",
            })
            .option("limit", {
              type: "number",
              default: 20,
              describe: "Maximum rows to show",
            })
            .option("all", {
              type: "boolean",
              default: false,
              describe: "List the whole index instead of resolving the origin remote",
            }),
        async (argv) => {
          try {
            const { client, cache, config } = createSession(argv);

            // With no query, default to the current checkout's remote - the
            // data-first behaviour an agent expects from a bare command.
            const query = argv.query ?? (argv.all ? undefined : await gitOriginUrl());

            const data = await findJobs(client, cache, {
              query,
              limit: argv.limit,
              depth: config.indexDepth,
            });
            emit(argv.json, data, () => formatJobSearch(data));
          } catch (err) {
            fail(err);
          }
        },
      )
      .demandCommand(1, "Specify a jobs subcommand. Run `jenkins jobs --help`."),
  );
