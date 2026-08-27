/**
 * Raw-GET formatter (AGNT-03/AGNT-04).
 *
 * The body is passed through verbatim - the point of the escape hatch is to
 * see what the endpoint actually returned - but capped, with a hint naming the
 * narrower request that would have fitted.
 */

import type { ApiGetResult } from "../operations/api.js";
import { capBytes, withNext } from "./common.js";

export function formatApiGetResult(data: ApiGetResult): string {
  const header = `api: ${data.path} (${data.contentType}, ${data.bytes} bytes)`;

  // The next-step vocabulary has no ref for this tool, so the hint names the
  // request to repeat rather than a literal tool name (which core must never
  // emit). `tree=` only narrows an api/json read; for anything else (config.xml
  // is the case the byte cap exists for) the only route to the rest of the body
  // is a bigger budget, so the hint has to name that instead.
  const projectable = /\/api\/(json|xml|python)(\?|$)/.test(data.path);
  const body = capBytes(
    data.body,
    data.maxBytes,
    projectable
      ? "the same path with a narrower tree= projection, naming only the fields you need"
      : `the same path with max_bytes above ${data.bytes} to receive the whole body`,
  );

  return withNext(`${header}\n${body}`, [
    "{findJobs} / {job} / {build} for a typed view of the same data",
  ]);
}
