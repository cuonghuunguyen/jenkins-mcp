import { formatWhoAmI, whoami } from "@jenkins-mcp/core";
import { createSession } from "../client.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

// ---------------------------------------------------------------------------
// jenkins whoami
// ---------------------------------------------------------------------------

export const registerWhoamiCommand: CommandRegistrar = (cli) =>
  cli.command(
    "whoami",
    "Show the identity this CLI is authenticated as against Jenkins.",
    (yargs) => yargs,
    async (argv) => {
      try {
        const { client } = createSession(argv);
        const data = await whoami(client);
        emit(argv.json, data, () => formatWhoAmI(data));
      } catch (err) {
        fail(err);
      }
    },
  );
