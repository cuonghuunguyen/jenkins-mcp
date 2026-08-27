import { applyCommandRefs, type CommandVocabulary, formatErrorLine } from "@jenkins-mcp/core";

/** The MCP tool result shape used by every tool in this package. */
export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/**
 * How core's `{...}` references read to an MCP client: as the names of the
 * tools it can call. The CLI package resolves the same placeholders to shell
 * commands instead.
 */
export const MCP_VOCABULARY: CommandVocabulary = {
  whoami: "jenkins_whoami",
  findJobs: "jenkins_find_jobs",
  job: "jenkins_job",
  build: "jenkins_build",
  log: "jenkins_log",
  queue: "jenkins_queue",
  trigger: "jenkins_trigger_build",
  abort: "jenkins_abort_build",
  diagnose: "jenkins_diagnose_build",
  wait: "jenkins_wait_build",
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Runs a tool body and adapts it to the MCP result shape.
 *
 * Core operations return data (rendered to text by the caller) or throw.
 * Anything thrown becomes an `isError` result carrying one structured error
 * line (AGNT-05), with its `{ref}` placeholders resolved to tool names.
 *
 * Diagnostics go to `console.error` - stderr - because stdout is the JSON-RPC
 * transport and a single stray byte on it corrupts the protocol.
 */
export async function runTool(toolName: string, body: () => Promise<string>): Promise<ToolResult> {
  try {
    return textResult(applyCommandRefs(await body(), MCP_VOCABULARY));
  } catch (err: unknown) {
    console.error(`[jenkins-mcp] ${toolName} error:`, err);
    return errorResult(applyCommandRefs(formatErrorLine(err), MCP_VOCABULARY));
  }
}
