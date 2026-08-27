/**
 * `jenkins_log` adapter (READ-10, READ-11).
 *
 * Schema and wire-name mapping only. Every mode, cap and validation rule lives
 * in `getBuildLog`, so the CLI gets exactly the same behaviour (ARCH-03).
 */

import {
  formatLogResult,
  getBuildLog,
  type JenkinsCache,
  type JenkinsClient,
  type LogMode,
} from "@jenkins-mcp/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool } from "./result.js";
import { buildSchema, jobSchema, refSchema } from "./schemas.js";

/** The wire shape. `save_to` stays snake_case because READ-11 specifies it. */
interface LogToolInput {
  job: string;
  ref?: string;
  build?: string | number;
  mode?: LogMode;
  lines?: number;
  pattern?: string;
  context?: number;
  max_matches?: number;
  from?: number;
  to?: number;
  step?: string;
  clean?: boolean;
  cursor?: number;
  save_to?: string;
}

export function registerLogTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
  indexDepth: number,
): string[] {
  server.registerTool(
    "jenkins_log",
    {
      description:
        "Read a bounded window of a build's console log. Modes: 'tail' (last N lines, " +
        "the default), 'grep' (regex matches plus context), 'range' (explicit 1-based " +
        "line range), 'step' (one pipeline stage's log), 'failed' (the window around " +
        "the failure). Lines are numbered as in the full log, so a follow-up " +
        "mode=range call addresses the right lines. Pass cursor to poll a running " +
        "build's new output. save_to writes the full RAW log to a file under the " +
        "current directory and returns a summary INSTEAD of the log body.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        build: buildSchema,
        mode: z
          .enum(["tail", "grep", "range", "step", "failed"])
          .optional()
          .describe("Which window to return. Defaults to 'tail'."),
        lines: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("mode=tail: trailing lines to return (default 100)."),
        pattern: z
          .string()
          .optional()
          .describe("mode=grep: a regular expression. Required for mode=grep."),
        context: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "mode=grep: lines of context either side of a hit (default 2). " +
              "mode=failed: lines either side of the failure anchor (default 60 before, " +
              "20 after).",
          ),
        max_matches: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "mode=grep: stop scanning after this many matches (default 200). The result " +
              "says whether the scan stopped early, which is not the same fact as the log " +
              "having only that many matches.",
          ),
        from: z
          .number()
          .int()
          .optional()
          .describe(
            "mode=range: first line, 1-based and inclusive. Negative is end-relative: " +
              "-1 is the last line, so from=-100 to=-1 is the last 100 lines.",
          ),
        to: z
          .number()
          .int()
          .optional()
          .describe("mode=range: last line, inclusive. Negative is end-relative."),
        step: z.string().optional().describe("mode=step: the pipeline stage name."),
        clean: z
          .boolean()
          .optional()
          .describe("Strip ANSI escapes and Jenkins timestamp prefixes (default true)."),
        cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Byte offset from a previous call, to fetch only what has been written since."),
        save_to: z
          .string()
          .optional()
          .describe(
            "Write the full RAW log here instead of returning it. Relative to the current " +
              "directory; absolute paths and '..' are rejected. Empty string uses " +
              ".jenkins-mcp/cli/<job>/<ref>/<build>.log.",
          ),
      },
    },
    async ({ save_to, max_matches, ...rest }: LogToolInput) =>
      runTool("jenkins_log", async () =>
        formatLogResult(
          await getBuildLog(client, cache, {
            ...rest,
            saveTo: save_to,
            maxMatches: max_matches,
            depth: indexDepth,
          }),
        ),
      ),
  );

  return ["jenkins_log"];
}
