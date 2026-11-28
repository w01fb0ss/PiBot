import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { Response } from "undici";
import { ExecError } from "../core/types.ts";
import { type NetworkProxy, proxyAgent } from "./network-proxy.ts";
import { checkedUrl, checkProxyTarget, publicAddresses, waitForWeb } from "./web-address.ts";

export class PublicDownloadError extends Error {
  constructor(
    readonly reason: "host_not_allowed" | "private_address" | "unsupported_url" | "redirect_limit",
  ) {
    super(reason);
  }
}

function target(input: string, uvAssetRedirect = false, video = false) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PublicDownloadError("unsupported_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  )
    throw new PublicDownloadError("private_address");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.search &&
      !video &&
      !(
        uvAssetRedirect &&
        ["objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(host)
      )) ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new PublicDownloadError("unsupported_url");
  return checkedUrl(url.href);
}

/** User-initiated archive reads: no cookies, target credentials or implicit redirect authority. */
export async function withPublicDownload<T>(
  options: {
    url: string;
    hosts?: ReadonlySet<string>;
    /** Video CDNs use signed URLs and redirects. Each hop still requires public HTTPS. */
    video?: true;
    method: "HEAD" | "GET";
    signal: AbortSignal;
    proxy?: NetworkProxy;
    /** Signed query strings are allowed only on GitHub asset redirects from a fixed uv release. */
    uvRelease?: true;
  },
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const { Agent, fetch } = createRequire(import.meta.url)("undici") as typeof import("undici");
  try {
    let url = target(options.url, false, options.video);
    const uvRelease =
      options.uvRelease === true &&
      ((url.hostname === "github.com" && url.pathname.startsWith("/astral-sh/")) ||
        (url.hostname === "releases.astral.sh" && url.pathname.startsWith("/github/"))) &&
      /^\/(?:astral-sh|github)\/uv\/releases\/download\/\d+\.\d+\.\d+\/uv-[a-z0-9_-]+\.(?:zip|tar\.gz)$/.test(
        url.pathname,
      );
    for (let hop = 0; hop <= 5; hop++) {
      const { signal, proxy } = options;
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (
        url.protocol !== "https:" ||
        (!options.video && !options.hosts?.has(url.hostname)) ||
        (url.port && url.port !== "443")
      )
        throw new PublicDownloadError("host_not_allowed");
      if (proxy) await checkProxyTarget(url, signal);
      const addresses = proxy ? [] : await publicAddresses(url, signal);
      const agent = proxy
        ? proxyAgent(proxy)
        : new Agent({
            connect: {
              timeout: 20_000,
              ...(!isIP(host) ? { servername: host } : {}),
              lookup: (_host, lookupOptions, callback) => {
                if (lookupOptions.all) callback(null, addresses);
                else {
                  const address = addresses[0];
                  if (address) callback(null, address.address, address.family);
                  else callback(new Error("No public address"), "", 4);
                }
              },
            },
          });
      let response: Response | undefined;
      const abort = () => {
        void agent.destroy().catch(() => {
          /* Owner awaits destroy below. */
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        response = await waitForWeb(
          fetch(url, {
            method: options.method,
            dispatcher: agent,
            signal,
            redirect: "manual",
            credentials: "omit",
            headers: {
              "User-Agent": options.video ? "Pi Bot" : "Pi Bot skill import",
              Accept: options.video || uvRelease ? "application/octet-stream" : "application/zip",
              "Accept-Encoding": "identity",
            },
          }),
          signal,
        );
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location || hop === 5) throw new PublicDownloadError("redirect_limit");
          url = target(new URL(location, url).href, uvRelease, options.video);
          continue;
        }
        return await consume(response);
      } finally {
        signal.removeEventListener("abort", abort);
        // Destroying the dispatcher also drains a cancelled or unconsumed response socket.
        await agent.destroy();
      }
    }
    throw new PublicDownloadError("redirect_limit");
  } catch (error) {
    if (error instanceof ExecError && error.reason === "private_address")
      throw new PublicDownloadError("private_address");
    if (error instanceof ExecError && error.reason === "unsupported_url")
      throw new PublicDownloadError("unsupported_url");
    throw error;
  }
}
