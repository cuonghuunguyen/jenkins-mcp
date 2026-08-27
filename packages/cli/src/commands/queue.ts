import { formatQueueListing, listQueue } from "@jenkins-mcp/core";
import { createSession } from "../client.js";
import { emit, fail } from "../output.js";
import type { CommandRegistrar } from "./types.js";

// ---------------------------------------------------------------------------
// jenkins queue
// ---------------------------------------------------------------------------

/** No job resolution: the queue is instance-wide. */
export const registerQueueCommand: CommandRegistrar = (cli) =>
  cli.command(
    "queue",
    "List what the Jenkins build queue is currently holding, and why.",
    (yargs) => yargs,
    async (argv) => {
      try {
        const { client, cache } = createSession(argv);
        const data = await listQueue(client, cache);
        emit(argv.json, data, () => formatQueueListing(data));
      } catch (err) {
        fail(err);
      }
    },
  );
