import type { Argv } from "yargs";

/** Options every command inherits from the root parser. */
export type GlobalArgs = {
  job?: string;
  json: boolean;
  url?: string;
  user?: string;
  token?: string;
};

/**
 * A command module registers one top-level command (with its subcommands) on
 * the root parser. One module per domain keeps the command tree readable.
 *
 * Registering the same top-level command name twice REPLACES it rather than
 * extending it, so a domain's subcommands must all be registered from one
 * module.
 */
export type CommandRegistrar = (cli: Argv<GlobalArgs>) => Argv<GlobalArgs>;
