import {
  applyCommandRefs,
  type CommandVocabulary,
  formatErrorLine,
} from "@cuonghuunguyen/jenkins-core";

/**
 * How core's `{...}` references read at a shell: as `jenkins` commands the
 * reader can actually run. The MCP server resolves the same placeholders to
 * tool names.
 */
export const CLI_VOCABULARY: CommandVocabulary = {
  whoami: "jenkins whoami",
  findJobs: "jenkins jobs find",
  job: "jenkins job",
  build: "jenkins build",
  log: "jenkins log",
  queue: "jenkins queue",
  trigger: "jenkins build trigger",
  abort: "jenkins build abort",
  diagnose: "jenkins build diagnose",
  wait: "jenkins build wait",
};

/** Writes a rendered block to stdout. */
export function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Writes structured data to stdout as indented JSON (for `--json`). */
export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Renders a command result either as JSON or as human-readable text.
 *
 * Every command funnels through this so `--json` is uniformly available: the
 * structured value comes straight from a core operation and the text from its
 * matching core formatter. `render` is a thunk, so the formatter is not run at
 * all under `--json`.
 *
 * This is why core operations return data rather than pre-formatted text - a
 * global `--json` is impossible otherwise.
 */
export function emit(json: boolean, data: unknown, render: () => string): void {
  if (json) {
    printJson(data);
    return;
  }
  print(applyCommandRefs(render(), CLI_VOCABULARY));
}

/** Writes one structured error line to stderr and exits non-zero. */
export function fail(err: unknown): never {
  process.stderr.write(`${applyCommandRefs(formatErrorLine(err), CLI_VOCABULARY)}\n`);
  process.exit(1);
}
