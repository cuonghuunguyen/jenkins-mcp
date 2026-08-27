/**
 * Shared zod field schemas for tool inputs.
 *
 * zod lives in this package only: core stays transport-neutral, and the CLI
 * validates through yargs. That does mean argument validation exists twice, so
 * the shared PARAM TYPES come from core - a new required param breaks both
 * adapters at compile time rather than silently drifting.
 *
 * `inputSchema` is a plain object of zod fields, not a wrapped `z.object()` -
 * that is what the MCP SDK's `registerTool` expects.
 */

import { z } from "zod";

export const jobSchema = z
  .string()
  .min(1)
  .describe(
    "Job fullName, e.g. 'team-a/my-service'. Folder levels are separated by '/'. " +
      "Use jenkins_find_jobs to discover it, including by git remote URL.",
  );

export const refSchema = z
  .string()
  .optional()
  .describe(
    "Branch, tag or PR of a multibranch job, e.g. 'main', 'feature/foo', 'PR-42'. " +
      "A bare number is treated as a PR ('42' means 'PR-42'). Pass the raw name - " +
      "it is URL-encoded for you. Omit for a plain (non-multibranch) job.",
  );

export const buildSchema = z
  .union([z.number(), z.string()])
  .optional()
  .describe(
    "Build number, -1 for the most recent build, or a permalink alias " +
      "(lastBuild, lastCompletedBuild, lastSuccessfulBuild, lastStableBuild, " +
      "lastFailedBuild, lastUnsuccessfulBuild). Defaults to lastBuild.",
  );

export const limitSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Maximum rows to return (default 20).");
