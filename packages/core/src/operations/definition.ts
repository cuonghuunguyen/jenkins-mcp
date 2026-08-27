/**
 * Job definition reads: raw `config.xml` and the derived Jenkinsfile
 * (CTRL-05, D-07/D-07a).
 *
 * Salvaged from the deleted VFS, which was the only place either lived. Two
 * details here were hard-won and are preserved deliberately:
 *
 * 1. A 403 on `config.xml` gets its own message naming `Job/ExtendedRead`,
 *    because modern Jenkins (2.401.3.3+) gates `config.xml` separately from
 *    the plain `Job/Read` that covers every other read in this project - so a
 *    generic "insufficient permissions" would send an operator looking in the
 *    wrong place.
 *
 * 2. `deriveJenkinsfileContent` branches on the `<definition class="...">`
 *    attribute BEFORE attempting `<script>` extraction, because both inline
 *    and SCM-sourced pipelines produce a `<definition>` element. An SCM
 *    pipeline's script is not in config.xml at all, so it returns an explicit
 *    marker naming the `scriptPath` rather than an empty string that would
 *    read as "this pipeline has no script".
 *
 * The extractors are a best-effort string scan, not a full XML parser - they
 * are a convenience for diagnosis, not a config-management interface.
 */

import { type JenkinsCache, jobKey } from "../cache.js";
import type { JenkinsClient } from "../client.js";
import { normalizeError } from "../errors.js";
import { jobRestPath } from "../paths.js";

/** Matches the `<definition class="...">` opening tag in a job's config.xml. */
const DEFINITION_TAG_RE = /<definition\s+class="([^"]*)"/;

/** Matches the `<script>...</script>` body of an inline (CpsFlowDefinition) pipeline. */
const SCRIPT_TAG_RE = /<script>([\s\S]*?)<\/script>/;

/** Matches the `<scriptPath>...</scriptPath>` value of an SCM (CpsScmFlowDefinition) pipeline. */
const SCRIPT_PATH_TAG_RE = /<scriptPath>([\s\S]*?)<\/scriptPath>/;

/** Strips a `<![CDATA[ ... ]]>` wrapper from an extracted XML text node, if present. */
function stripCdata(text: string): string {
  const trimmed = text.trim();
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(trimmed);
  return cdataMatch ? (cdataMatch[1] ?? "").trim() : trimmed;
}

/**
 * Derives a job's Jenkinsfile content from its raw `config.xml` text
 * (D-07a, Pitfall 4). See the module comment for why the definition class is
 * checked before any `<script>` extraction is attempted.
 */
export function deriveJenkinsfileContent(configXml: string): string {
  const definitionClass = DEFINITION_TAG_RE.exec(configXml)?.[1] ?? "";

  if (definitionClass.includes("CpsScmFlowDefinition")) {
    const scriptPath = SCRIPT_PATH_TAG_RE.exec(configXml)?.[1]?.trim() || "unknown";
    return (
      `This pipeline's Jenkinsfile is SCM-sourced (scriptPath: ${scriptPath}) ` +
      "and is not retrievable via the Jenkins REST config.xml endpoint."
    );
  }

  if (definitionClass.includes("CpsFlowDefinition")) {
    const scriptBody = SCRIPT_TAG_RE.exec(configXml)?.[1];
    if (scriptBody !== undefined) return stripCdata(scriptBody);
  }

  return "This job has no inline pipeline script (not a CpsFlowDefinition pipeline).";
}

/**
 * Fetches a job's raw `config.xml`. Cached under the index tier: a job's
 * definition changes only when someone edits Jenkins.
 */
export async function getConfigXml(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: { job: string; ref?: string },
): Promise<string> {
  return cache.fetch(
    jobKey(args.job, args.ref, "config.xml"),
    async () => {
      const res = await client.get(`${jobRestPath(args.job, args.ref)}/config.xml`);
      if (res.status === 403) {
        throw normalizeError(res, "jenkins_job:config-xml (requires Job/ExtendedRead permission)");
      }
      if (!res.ok) throw normalizeError(res, "jenkins_job:config-xml");
      return res.text();
    },
    "index",
  );
}

/** Fetches a job's config.xml and derives its Jenkinsfile content. */
export async function getJenkinsfile(
  client: JenkinsClient,
  cache: JenkinsCache,
  args: { job: string; ref?: string },
): Promise<string> {
  return deriveJenkinsfileContent(await getConfigXml(client, cache, args));
}
