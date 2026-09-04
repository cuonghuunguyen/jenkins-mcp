/**
 * Build-control, watch and diagnosis tool adapters.
 *
 * Trigger and abort are the ONLY tools that issue a non-GET request, and they
 * issue exactly two shapes of it: a trigger POST and a `/stop` POST
 * (SAFE-01/SAFE-02). That claim used to be false - `jenkins_whoami` POSTed to
 * `/me/api/json` and is registered in read-only mode - so `operations/whoami.ts`
 * now GETs, and `safety.test.ts` drives every read-only tool's operation against
 * a client whose `post` fails the test rather than comparing tool names. Under `JENKINS_MCP_READONLY` they are not registered at
 * all (SAFE-03) - "the tool does not exist" rather than "the tool exists and
 * refuses", so an agent enumerating tools never sees a capability it cannot
 * use.
 *
 * `jenkins_wait_build` and `jenkins_diagnose_build` only GET, so they stay
 * registered in read-only mode: watching is not controlling.
 *
 * The structural safety test asserts both lists against the registrar rather
 * than trusting this comment.
 */

import {
  abortBuild,
  diagnoseBuild,
  formatAbortResult,
  formatDiagnoseResult,
  formatTriggerResult,
  formatWaitResult,
  type JenkinsCache,
  type JenkinsClient,
  triggerBuild,
  waitForBuild,
} from "@cuonghuunguyen/jenkins-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool } from "./result.js";
import { buildSchema, jobSchema, refSchema } from "./schemas.js";

export function registerControlTools(
  server: McpServer,
  client: JenkinsClient,
  cache: JenkinsCache,
  depth: number,
  readonly = false,
): string[] {
  const names: string[] = [];

  // -------------------------------------------------------------------------
  // jenkins_wait_build (CTRL-06) - read-only, registered in both modes
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_wait_build",
    {
      description:
        "Block until a build finishes, then return its result. Polls wfapi/describe " +
        "(falling back to api/json for a freestyle build) with exponential backoff, and " +
        "ALWAYS returns: on completion, on the timeout, or as soon as a stage pauses on " +
        "an `input` step - which never finishes on its own, so a human has to act. Pass " +
        "since_cursor and log_cursor from a previous call to get only the stage " +
        "transitions and log lines that appeared since. Read-only.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        build: buildSchema,
        timeout_s: z
          .number()
          .positive()
          .optional()
          .describe("Seconds to wait before giving up (default 120)."),
        since_cursor: z
          .string()
          .optional()
          .describe(
            "Stage id from a previous wait's `since_cursor` line: stage transitions are " +
              "reported from that stage onward instead of repeating the whole pipeline.",
          ),
        log_cursor: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Byte offset from a previous wait's or jenkins_log's cursor: the log lines " +
              "written since it are returned with the result.",
          ),
      },
    },
    async (args: {
      job: string;
      ref?: string;
      build?: string | number;
      timeout_s?: number;
      since_cursor?: string;
      log_cursor?: number;
    }) =>
      runTool("jenkins_wait_build", async () =>
        formatWaitResult(
          await waitForBuild(client, cache, {
            job: args.job,
            ref: args.ref,
            build: args.build,
            depth,
            timeoutMs: args.timeout_s === undefined ? undefined : args.timeout_s * 1000,
            sinceCursor: args.since_cursor,
            logCursor: args.log_cursor,
          }),
        ),
      ),
  );
  names.push("jenkins_wait_build");

  // -------------------------------------------------------------------------
  // jenkins_diagnose_build (DIAG-03) - read-only, both modes
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_diagnose_build",
    {
      description:
        "Diagnose a failed build: names the failed pipeline stage and step via wfapi, " +
        "lists the failed JUnit tests, and returns the failed step's own log - falling " +
        "back to the console tail only when neither is available. Works on freestyle " +
        "builds too. Byte-capped so a large real log still fits in context. Read-only.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        build: buildSchema,
      },
    },
    async (args: { job: string; ref?: string; build?: string | number }) =>
      runTool("jenkins_diagnose_build", async () =>
        formatDiagnoseResult(await diagnoseBuild(client, cache, { ...args, depth })),
      ),
  );
  names.push("jenkins_diagnose_build");

  if (readonly) return names;

  // -------------------------------------------------------------------------
  // jenkins_trigger_build (CTRL-01/CTRL-02/CTRL-07)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_trigger_build",
    {
      description:
        "Trigger a build, optionally with parameters. Parameters are validated against " +
        "the job's declared parameterDefinitions BEFORE the build is submitted, so a " +
        "misspelled name is an error instead of the silent ignore Jenkins would do. " +
        "Waits a short bounded time (default 15s, override with `timeout` seconds) for " +
        "a real build number and returns that - never the raw queue id. Use " +
        "`rebuild_from` to reuse a past build's parameters, and `wait` to block until " +
        "the new build finishes.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe("Build parameters as name/value pairs."),
        timeout: z.number().optional().describe("Seconds to wait for a build number (default 15)."),
        rebuild_from: buildSchema.describe(
          "Reuse this build's parameters as the base map; `params` overrides individual keys.",
        ),
        wait: z
          .boolean()
          .optional()
          .describe("Block until the triggered build finishes and return its result."),
        wait_timeout_s: z
          .number()
          .positive()
          .optional()
          .describe("Seconds to block when `wait` is true (default 120)."),
      },
    },
    async (args: {
      job: string;
      ref?: string;
      params?: Record<string, string>;
      timeout?: number;
      rebuild_from?: string | number;
      wait?: boolean;
      wait_timeout_s?: number;
    }) =>
      runTool("jenkins_trigger_build", async () =>
        formatTriggerResult(
          await triggerBuild(client, cache, {
            job: args.job,
            ref: args.ref,
            depth,
            params: args.params,
            timeout: args.timeout,
            rebuildFrom: args.rebuild_from,
            wait: args.wait,
            waitTimeoutMs:
              args.wait_timeout_s === undefined ? undefined : args.wait_timeout_s * 1000,
          }),
        ),
      ),
  );
  names.push("jenkins_trigger_build");

  // -------------------------------------------------------------------------
  // jenkins_abort_build (CTRL-04/CTRL-08)
  // -------------------------------------------------------------------------
  server.registerTool(
    "jenkins_abort_build",
    {
      description:
        "Gracefully abort a running build - the same effect as clicking Abort in the " +
        "Jenkins UI. Accepts a build number, -1, or a permalink alias such as lastBuild. " +
        "Never escalates to /term or /kill.",
      inputSchema: {
        job: jobSchema,
        ref: refSchema,
        build: buildSchema,
      },
    },
    async (args: { job: string; ref?: string; build?: string | number }) =>
      runTool("jenkins_abort_build", async () =>
        formatAbortResult(
          await abortBuild(client, cache, { ...args, depth, build: args.build ?? -1 }),
        ),
      ),
  );
  names.push("jenkins_abort_build");

  return names;
}
