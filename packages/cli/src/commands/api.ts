import { apiGet, formatApiGetResult } from "@jenkins-mcp/core";
import { createSession } from "../client.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

// ---------------------------------------------------------------------------
// jenkins api get <path> [--tree]
// ---------------------------------------------------------------------------

export const registerApiCommand: CommandRegistrar = (cli) =>
  cli.command(
    "api <command>",
    "Raw read-only access to any Jenkins path, for endpoints the typed commands " + "do not cover.",
    (yargs) =>
      yargs
        .command(
          "get <path>",
          "GET a Jenkins path and print the raw response. --tree is REQUIRED for a " +
            "path ending in api/json, which is otherwise megabytes.",
          (y) =>
            y
              .positional("path", {
                type: "string",
                describe:
                  "Path on the instance, starting with '/'. An absolute URL, a '..' " +
                  "segment or an embedded query string is rejected.",
              })
              .option("tree", {
                type: "string",
                describe: "Jenkins tree= field projection, e.g. 'jobs[fullName,color]'",
              })
              .option("max-bytes", {
                type: "number",
                describe:
                  "Body budget in bytes (default 65536). The only way to get the rest of a " +
                  "truncated non-api/json body, e.g. a large config.xml",
              }),
          async (argv) => {
            try {
              const { client } = createSession(argv);
              const data = await apiGet(client, {
                path: String(argv.path),
                tree: argv.tree,
                maxBytes: argv.maxBytes,
              });
              emit(argv.json, data, () => formatApiGetResult(data));
            } catch (err) {
              fail(err);
            }
          },
        )
        .demandCommand(1, "Specify an api subcommand. Run `jenkins api --help`."),
  );
