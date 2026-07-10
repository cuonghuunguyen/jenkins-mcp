/**
 * jenkins_whoami MCP tool adapter (D-05).
 *
 * Issues a write-shaped, crumb-protected but non-mutating POST to
 * `/me/api/json`. Per RESEARCH.md Assumption A1, routing this call through
 * `JenkinsClient.post()` (rather than `get()`) unifies D-05 (ship
 * `jenkins_whoami`) with D-04 (prove a real crumb+session write round-trip)
 * in a single benign call — `/me/api/json` returns only already-public,
 * read-only identity data for the authenticated user, so no create/update/
 * delete operation is ever performed (SAFE-01).
 *
 * The handler calls `JenkinsClient` only — never `fetch` directly
 * (RESEARCH.md Anti-Patterns) — and any non-ok response is thrown via
 * `normalizeError` so the surfaced message is redacted/actionable and never
 * leaks a token/crumb/cookie value (CONN-03).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JenkinsClient } from "../jenkins/client.js";
import { normalizeError } from "../jenkins/errors.js";
import type { WhoAmI } from "../jenkins/types.js";

/** MCP tool name (D-05). */
export const WHOAMI_TOOL_NAME = "jenkins_whoami";

/** Human-readable description surfaced to the MCP client (MCP-02). */
export const WHOAMI_TOOL_DESCRIPTION =
  "Return the identity and permissions the server is currently authenticated " +
  "as against the connected Jenkins instance. Use this to confirm connectivity " +
  "and that the configured credentials resolve to the expected account.";

/**
 * Zero-parameter zod raw shape (empty object) — `jenkins_whoami` takes no
 * input (RESEARCH.md Assumption A4, confirmed against the installed SDK
 * 1.29.0 `registerTool` types: `inputSchema` accepts a `ZodRawShapeCompat`,
 * and an empty object literal satisfies that shape for a no-argument tool).
 */
export const whoamiInputSchema = {};

/**
 * Formats a `WhoAmI` identity into the human-readable text returned as the
 * tool's MCP `content` payload.
 */
export function formatWhoAmI(identity: WhoAmI): string {
  const lines: string[] = [`Authenticated as: ${identity.id}`];
  if (identity.fullName) lines.push(`Full name: ${identity.fullName}`);
  if (identity.description) lines.push(`Description: ${identity.description}`);
  if (identity.absoluteUrl) lines.push(`Profile URL: ${identity.absoluteUrl}`);
  if (identity.authorities && identity.authorities.length > 0) {
    lines.push(`Authorities: ${identity.authorities.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Calls the Jenkins client's crumb-protected `post()` against `/me/api/json`
 * and parses the response as a `WhoAmI` identity. Throws a normalized,
 * secret-free `JenkinsError` on any non-ok response.
 */
export async function whoami(client: JenkinsClient): Promise<WhoAmI> {
  const res = await client.post("/me/api/json");
  if (!res.ok) throw normalizeError(res, "jenkins_whoami");
  return (await res.json()) as WhoAmI;
}

/**
 * Builds the `registerTool` handler bound to a given `JenkinsClient`
 * instance (`server.ts` constructs the client and wires it here).
 */
export function createWhoamiHandler(client: JenkinsClient): () => Promise<CallToolResult> {
  return async () => {
    const identity = await whoami(client);
    return { content: [{ type: "text", text: formatWhoAmI(identity) }] };
  };
}
