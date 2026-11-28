import { lookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";

import {
  isProxyAuthenticationFailure,
  isProxyUnavailable,
  type NetworkProxy,
  ProxyAuthenticationError,
  ProxyUnavailableError,
  proxyAgent,
} from "./network-proxy.ts";
import { checkedUrl, checkProxyTarget, publicAddresses, waitForWeb } from "./web-address.ts";

export class SearchHttpError extends Error {
  constructor(readonly reason: "network" | "response") {
    super(`search_${reason}_failed`);
  }
}
/** A non-2xx answer from a search API; carries the status so callers can say what to do next. */
export class SearchStatusError extends Error {
  constructor(readonly status: number) {
    super("Search request failed");
  }
}
/** Only the user-selected search endpoint may opt into private addresses. No redirects. */
export async function searchResponse(input: {
  url: string;
  proxy?: NetworkProxy;
  configuredPrivateEndpoint?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}): Promise<{ status: number; text: string; location?: string }> {
  const { Agent, request } = createRequire(import.meta.url)("undici") as typeof import("undici");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]);
  const url = new URL(input.url);
  const configured = input.configuredPrivateEndpoint
    ? new URL(input.configuredPrivateEndpoint)
    : undefined;
  const privateAllowed =
    !input.proxy &&
    configured &&
    configured.origin === url.origin &&
    url.pathname === `${configured.pathname.replace(/\/$/, "")}/search`;
  if (!privateAllowed) checkedUrl(url.href);
  else if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid search endpoint");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (input.proxy && !privateAllowed) await checkProxyTarget(url, signal);
  const connection = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  const addresses = await (async () => {
    try {
      return input.proxy
        ? []
        : privateAllowed
          ? isIP(host)
            ? [{ address: host, family: isIP(host) }]
            : await waitForWeb(lookup(host, { all: true, verbatim: true }), connection)
          : await publicAddresses(url, connection);
    } catch (error) {
      if (connection.aborted && !signal.aborted) throw new SearchHttpError("network");
      throw error;
    }
  })();
  if (!input.proxy && !addresses.length) throw new Error("Search endpoint unresolved");
  const agent = input.proxy
    ? proxyAgent(input.proxy)
    : new Agent({
        connect: {
          timeout: 4000,
          lookup: (_name, options, callback) => {
            const address =
              addresses.find((a) => !options.family || a.family === options.family) ?? addresses[0];
            if (!address) return callback(new Error("Search endpoint unresolved"), "", 4);
            if (options.all) callback(null, addresses);
            else callback(null, address.address, address.family);
          },
        },
      });
  try {
    const response = await request(url, {
      dispatcher: agent,
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
      signal,
      headersTimeout: 8000,
      bodyTimeout: 8000,
    });
    // Undici emits an asynchronous error on destroy, even when no iterator was attached yet.
    // Status/size failures are reported below; keep disposal errors from crashing the brain.
    const disposalError = () => {};
    response.body.on("error", disposalError);
    response.body.once("close", () => response.body.off("error", disposalError));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 1048576) {
        response.body.destroy();
        throw new SearchHttpError("response");
      }
      chunks.push(bytes);
    }
    const location = response.headers.location;
    return {
      status: response.statusCode,
      text: Buffer.concat(chunks).toString("utf8"),
      // Redirects are never followed here; callers decide whether a target is the same service.
      ...(typeof location === "string" ? { location } : {}),
    };
  } catch (error) {
    if (isProxyAuthenticationFailure(error)) throw new ProxyAuthenticationError();
    if (isProxyUnavailable(error)) throw new ProxyUnavailableError();
    // Only connection failures qualify for a retry; never surface URLs or queries in errors.
    if (
      !signal.aborted &&
      error instanceof Error &&
      "code" in error &&
      [
        "ECONNRESET",
        "ETIMEDOUT",
        "ECONNREFUSED",
        "ENETUNREACH",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
      ].includes(String(error.code))
    )
      throw new SearchHttpError("network");
    throw error;
  } finally {
    await agent.destroy();
  }
}

export async function searchJson(input: Parameters<typeof searchResponse>[0]): Promise<unknown> {
  const response = await searchResponse(input);
  if (response.status < 200 || response.status >= 300) throw new SearchStatusError(response.status);
  return JSON.parse(response.text);
}
