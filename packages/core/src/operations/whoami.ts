/**
 * Identity check against the connected Jenkins instance (D-05).
 *
 * `/me/api/json` is a READ, so it is issued with `client.get()`.
 *
 * It used to be a POST. The reasoning was that routing it through
 * `JenkinsClient.post()` exercised a real crumb+session round trip in one
 * benign call, and it is true that the endpoint mutates nothing. But
 * `jenkins_whoami` is registered in READ-ONLY mode (SAFE-03), so the project's
 * central safety claim - "no tool other than trigger and abort issues a
 * non-GET request" - was false on the very first identity check an agent
 * makes. A deployment that sets `JENKINS_MCP_READONLY` because a proxy, an
 * audit rule or a policy blocks non-GET verbs got a crumb-protected POST
 * anyway, and the structural safety test could not notice, because it only
 * compared tool NAMES. The claim is worth more than the crumb exercise; the
 * crumb path is covered by `auth.test.ts` and by the trigger/abort tests.
 *
 * Calls `JenkinsClient` only - never `fetch` directly - and throws any non-ok
 * response through `normalizeError`, so the surfaced message is
 * redacted/actionable and can never leak a token/crumb/cookie value (CONN-03).
 */

import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import type { WhoAmI } from "../types.js";

export async function whoami(client: JenkinsClient): Promise<WhoAmI> {
  const res = await client.get("/me/api/json");
  if (!res.ok) throw normalizeError(res, "jenkins_whoami");
  return (await res.json()) as WhoAmI;
}
