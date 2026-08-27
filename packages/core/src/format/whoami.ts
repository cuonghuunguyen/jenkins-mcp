/**
 * Identity formatter - compact key/value, not a JSON dump (AGNT-03).
 */

import type { WhoAmI } from "../types.js";
import { withNext } from "./common.js";

export function formatWhoAmI(identity: WhoAmI): string {
  const lines: string[] = [`authenticated: ${identity.id}`];
  if (identity.fullName) lines.push(`fullName: ${identity.fullName}`);
  if (identity.description) lines.push(`description: ${identity.description}`);
  if (identity.absoluteUrl) lines.push(`url: ${identity.absoluteUrl}`);
  if (identity.authorities && identity.authorities.length > 0) {
    lines.push(`authorities: ${identity.authorities.join(", ")}`);
  }

  return withNext(lines.join("\n"), ["{findJobs} to locate a job on this instance"]);
}
