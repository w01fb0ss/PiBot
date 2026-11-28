import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ConnectorConnectionOptions } from "@pibot/protocol-base";
import { TOOL_CALL_ID_REQUEST_META_KEY } from "./adapter/utils.ts";
import { boundedMcpResponse } from "./bounded-json-response.ts";
import { createConnectorOAuthProvider } from "./oauth.ts";

const RESUMED_STREAM_TIMEOUT_MS = 5 * 60_000;

function isInitialize(body: RequestInit["body"]): boolean {
  if (typeof body !== "string" || !body.includes('"initialize"')) return false;
  try {
    return JSON.parse(body)?.method === "initialize";
  } catch {
    // Only the SDK's JSON-RPC initialization request is classified.
    return false;
  }
}

export async function createHttpTransport(
  options: Extract<ConnectorConnectionOptions, { transport: "http" }>,
  setAuthFailure: (value: boolean) => void,
  kind: "streamable" | "sse",
  callSignals: ReadonlyMap<string, AbortSignal>,
  networkFetch: typeof fetch = fetch,
  legacyEndpoint?: () => void,
): Promise<Transport> {
  const endpoint = new URL(options.url);
  const resourceHeaders = new Headers(options.headers);
  const transportOptions = {
    redirectPolicy: "same-origin" as const,
    // In the pinned SDK the transports pass a Headers object. OAuth's createFetchWithInit
    // merges a supplied base init into a plain record, even for a same-origin token endpoint.
    requestInit: {},
    ...(options.oauth ? { authProvider: await createConnectorOAuthProvider(options.oauth) } : {}),
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(url instanceof Request ? url.url : url);
      const resourceRequest = target.origin === endpoint.origin && init?.headers instanceof Headers;
      const headers = new Headers(init?.headers);
      if (resourceRequest)
        for (const [name, value] of resourceHeaders)
          if (!headers.has(name)) headers.set(name, value);
      const get = (init?.method ?? "GET").toUpperCase() === "GET";
      const persistent = get && headers.get("accept")?.includes("text/event-stream") === true;
      const resumed = get && headers.has("last-event-id");
      const initialize = init?.method === "POST" && isInitialize(init.body);
      const signal = AbortSignal.any([
        options.signal,
        ...(resumed
          ? [AbortSignal.timeout(RESUMED_STREAM_TIMEOUT_MS)]
          : persistent
            ? []
            : [AbortSignal.timeout(initialize ? (options.startupTimeoutMs ?? 30_000) : 30_000)]),
        ...(init?.signal ? [init.signal] : []),
      ]);
      // Keep credentialed requests inside the SDK's same-origin redirect loop.
      const response = await networkFetch(url, {
        ...init,
        ...(resourceRequest ? { headers, redirect: "manual" } : {}),
        signal,
      });
      if (resourceRequest) setAuthFailure(response.status === 401 || response.status === 403);
      let detectLegacyEvent: (() => void) | undefined;
      if (legacyEndpoint && resourceRequest && initialize) {
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase();
        const incompatibleContentType =
          response.status === 200 &&
          contentType !== "application/json" &&
          contentType !== "text/event-stream";
        if (response.status === 404 || response.status === 405 || incompatibleContentType)
          legacyEndpoint();
        if (response.status === 200 && contentType === "text/event-stream")
          detectLegacyEvent = legacyEndpoint;
      }
      return boundedMcpResponse(response, signal, undefined, detectLegacyEvent);
    },
  };
  const transport: Transport =
    kind === "sse"
      ? new SSEClientTransport(new URL(options.url), transportOptions)
      : new StreamableHTTPClientTransport(new URL(options.url), transportOptions);
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    const meta =
      "method" in message && message.method === "tools/call" ? message.params?._meta : undefined;
    const callId =
      meta && typeof meta === "object"
        ? (meta as Record<string, unknown>)[TOOL_CALL_ID_REQUEST_META_KEY]
        : undefined;
    const signal = typeof callId === "string" ? callSignals.get(callId) : undefined;
    // 2.3.1 omits requestSignal for legacy peers. The public transport option is still honored
    // by the POST body, resume GET and reconnect scheduler, without closing concurrent calls.
    return send(
      message,
      signal
        ? {
            ...sendOptions,
            requestSignal: AbortSignal.any([
              signal,
              ...(sendOptions?.requestSignal ? [sendOptions.requestSignal] : []),
            ]),
          }
        : sendOptions,
    );
  };
  return transport;
}
