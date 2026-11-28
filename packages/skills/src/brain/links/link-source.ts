import { packagePath } from "@pibot/brain/kit";
import { type NetworkProxy, withPublicDownload } from "@pibot/execution";
import { SKILL_IMPORT_MAX_BYTES } from "@pibot/skills-contract/full";
import { z } from "zod";
import { linkError } from "./link-errors.ts";

export { linkError } from "./link-errors.ts";
export interface LinkSource {
  url: string;
  host: string;
  download: string;
  hosts: Set<string>;
  owner?: string;
  repo?: string;
  ref?: string;
  subpath: string;
}
export function parseLink(input: string): LinkSource & { tree?: string[] } {
  if (/[\\\p{Cc}\p{Cf}]/u.test(input)) throw linkError("skill_link_ref_invalid");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw linkError("skill_link_unsupported");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw linkError("skill_link_unsupported");
  const host = url.hostname;
  if (host === "github.com") {
    const query = [...url.searchParams];
    if (
      url.search &&
      (query.length !== 1 || query[0]?.[0] !== "tab" || !/^[a-z0-9-]{1,80}$/i.test(query[0][1]))
    )
      throw linkError("skill_link_unsupported");
    url.search = "";
    url.hash = "";
  } else if (url.search || url.hash) {
    throw linkError("skill_link_unsupported");
  }
  const hosts = new Set(["github.com", "codeload.github.com", host]);
  if (host !== "github.com" && host !== "codeload.github.com") {
    if (!url.pathname.toLowerCase().endsWith(".zip")) throw linkError("skill_link_unsupported");
    return { url: url.href, host, download: url.href, hosts, subpath: "" };
  }
  let parts: string[];
  try {
    // WHATWG URL normalizes dot segments; inspect the original spelling before losing them.
    const rawPath = /^https:\/\/[^/?#]+([^?#]*)/i.exec(input.trim())?.[1] ?? "";
    const rawSegments = rawPath
      .split("/")
      .map(decodeURIComponent)
      .flatMap((part) => part.split("/"));
    if (rawSegments.some((part) => part === "." || part === ".." || /[\\\p{Cc}\p{Cf}]/u.test(part)))
      throw linkError("skill_link_ref_invalid");
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch (error) {
    if (error instanceof Error && error.message === "skill_link_ref_invalid") throw error;
    throw linkError("skill_link_unsupported");
  }
  const [owner, repo] = parts;
  if (
    !owner ||
    !repo ||
    !/^[\w-]{1,100}$/.test(owner) ||
    !/^[\w.-]{1,100}$/.test(repo) ||
    [".", ".."].includes(repo)
  )
    throw linkError("skill_link_unsupported");
  if (
    host === "github.com" &&
    parts[2] === "blob" &&
    parts.length >= 5 &&
    parts.length <= 21 &&
    parts.at(-1) === "SKILL.md"
  ) {
    parts.pop();
    parts[2] = "tree";
    url.pathname = `/${parts.map(encodeURIComponent).join("/")}`;
  }
  const base = { url: url.href, host, hosts, owner, repo, subpath: "" };
  if (parts.length === 2) return { ...base, ref: "HEAD", download: archive(owner, repo, "HEAD") };
  if (host === "codeload.github.com" && parts[2] === "zip" && parts.length > 3) {
    const ref = parts.slice(3).join("/");
    validateRef(ref);
    return { ...base, ref, download: archive(owner, repo, ref) };
  }
  if (host === "github.com" && parts[2] === "tree" && parts.length > 3 && parts.length <= 20)
    return { ...base, download: "", tree: parts.slice(3) };
  if (url.pathname.toLowerCase().endsWith(".zip")) return { ...base, download: url.href };
  throw linkError("skill_link_unsupported");
}
function archive(owner: string, repo: string, ref: string) {
  validateRef(ref);
  return `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
}
function validateRef(ref: string) {
  if (
    ref.length > 512 ||
    /[\\\p{Cc}\p{Cf}]/u.test(ref) ||
    ref.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw linkError("skill_link_ref_invalid");
}

export function linkSubpath(value: string) {
  try {
    return packagePath(value);
  } catch {
    throw linkError("skill_link_subpath_invalid");
  }
}
export function responseSize(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw linkError("skill_link_download_failed");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > SKILL_IMPORT_MAX_BYTES)
    throw linkError("skill_import_too_large");
  return size;
}
const GITHUB_API_HOSTS = new Set(["api.github.com"]);
// A large repository's tree listing is a few MB of JSON; the summary is a few KB.
const GITHUB_TREE_BODY_MAX_BYTES = 16 * 1024 * 1024;
const GITHUB_REPO_BODY_MAX_BYTES = 64 * 1024;
const githubSizeSchema = z.looseObject({ size: z.number().int().nonnegative().finite() });
const githubTreeSchema = z.looseObject({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.looseObject({
      type: z.string(),
      path: z.string(),
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});

/** Bounded body read: untrusted API responses must not be buffered without a ceiling. */
async function readBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function githubSource(source: LinkSource) {
  if (!source.owner || !source.repo) return null;
  if (source.host !== "github.com" && source.host !== "codeload.github.com") return null;
  return `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
}

/**
 * Sum of the blob sizes under the link's subpath in the git tree of the ref being downloaded.
 * That tracks the archive's contents, unlike the repository size which also counts history
 * (hugohe3/ppt-master is ~140 MB of history for a ~57 MB zip). Still only an estimate: the zip is
 * compressed, so an under-count must never let the bar read as finished. A truncated tree would
 * under-count badly, so it is left to the repository-size fallback instead.
 */
async function githubTreeEstimate(
  source: LinkSource,
  signal: AbortSignal,
  proxy: NetworkProxy | undefined,
  request: typeof withPublicDownload,
): Promise<number | null> {
  const repo = githubSource(source);
  if (!repo) return null;
  const ref = source.ref ?? "HEAD";
  try {
    return await request(
      {
        url: `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        hosts: GITHUB_API_HOSTS,
        method: "GET",
        signal,
        ...(proxy ? { proxy } : {}),
      },
      async (response) => {
        if (response.status !== 200 || !response.body) return null;
        const body = await readBody(response.body, GITHUB_TREE_BODY_MAX_BYTES);
        if (body === null) return null;
        const parsed = githubTreeSchema.safeParse(JSON.parse(body));
        if (!parsed.success || parsed.data.truncated) return null;
        const prefix = source.subpath ? `${source.subpath}/` : "";
        let total = 0;
        for (const entry of parsed.data.tree) {
          if (entry.type !== "blob" || entry.size === undefined) continue;
          if (prefix && !entry.path.startsWith(prefix)) continue;
          total += entry.size;
          if (total > SKILL_IMPORT_MAX_BYTES) return SKILL_IMPORT_MAX_BYTES;
        }
        return total > 0 ? total : null;
      },
    );
  } catch (error) {
    // Abort and timeouts must still stop the request; only an unavailable estimate is tolerated.
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * Whole-repository size from GitHub's API, in KB. Coarser than the tree sum and missing for empty
 * repositories, but the only fallback when the tree is truncated or unavailable.
 */
async function githubRepoEstimate(
  source: LinkSource,
  signal: AbortSignal,
  proxy: NetworkProxy | undefined,
  request: typeof withPublicDownload,
): Promise<number | null> {
  const repo = githubSource(source);
  if (!repo) return null;
  try {
    return await request(
      {
        url: `https://api.github.com/repos/${repo}`,
        hosts: GITHUB_API_HOSTS,
        method: "GET",
        signal,
        ...(proxy ? { proxy } : {}),
      },
      async (response) => {
        if (response.status !== 200 || !response.body) return null;
        const body = await readBody(response.body, GITHUB_REPO_BODY_MAX_BYTES);
        if (body === null) return null;
        const parsed = githubSizeSchema.safeParse(JSON.parse(body));
        if (!parsed.success || parsed.data.size <= 0) return null;
        return Math.min(SKILL_IMPORT_MAX_BYTES, parsed.data.size * 1024);
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * Advisory total for the progress bar only. It is never compared with the confirmed `bytes`: the
 * download keeps its own byte limit and size confirmation, and a link whose lookups fail still
 * opens with an unknown size (the bar then shows indeterminate progress).
 */
async function githubEstimate(
  source: LinkSource,
  signal: AbortSignal,
  proxy: NetworkProxy | undefined,
  request: typeof withPublicDownload,
): Promise<number | null> {
  return (
    (await githubTreeEstimate(source, signal, proxy, request)) ??
    (await githubRepoEstimate(source, signal, proxy, request))
  );
}

export async function resolveLink(
  input: string,
  signal: AbortSignal,
  proxy?: NetworkProxy,
  request: typeof withPublicDownload = withPublicDownload,
) {
  const parsed = parseLink(input);
  const head = (source: LinkSource) =>
    request(
      {
        url: source.download,
        hosts: source.hosts,
        method: "HEAD",
        signal,
        ...(proxy ? { proxy } : {}),
      },
      async (response) => ({
        status: response.status,
        bytes: responseSize(response.headers.get("content-length")),
      }),
    );
  if (parsed.tree) {
    for (let n = parsed.tree.length; n >= 1; n--) {
      const ref = parsed.tree.slice(0, n).join("/");
      const subpath = parsed.tree.slice(n).join("/");
      if (subpath) linkSubpath(subpath);
      const source = {
        ...parsed,
        ref,
        subpath,
        download: archive(parsed.owner as string, parsed.repo as string, ref),
      };
      const result = await head(source);
      if (result.status === 404) continue;
      checkStatus(result.status);
      return {
        source,
        bytes: result.bytes,
        estimate:
          result.bytes === null ? await githubEstimate(source, signal, proxy, request) : null,
      };
    }
    throw linkError("skill_link_private_or_missing");
  }
  const result = await head(parsed);
  // Some public ZIP endpoints do not implement HEAD; still require confirmation of unknown size.
  if (![405, 501].includes(result.status)) checkStatus(result.status);
  const bytes = [405, 501].includes(result.status) ? null : result.bytes;
  return {
    source: parsed,
    bytes,
    estimate: bytes === null ? await githubEstimate(parsed, signal, proxy, request) : null,
  };
}
export function checkStatus(status: number) {
  if ([401, 403].includes(status)) throw linkError("skill_link_private_unsupported");
  if (status === 404) throw linkError("skill_link_private_or_missing");
  if (status < 200 || status >= 300) throw linkError("skill_link_download_failed");
}
