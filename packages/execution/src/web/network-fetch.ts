import { createRequire } from "node:module";
import type { Dispatcher, RequestInit } from "undici";
import {
  isProxyAuthenticationFailure,
  isProxyUnavailable,
  type NetworkProxy,
  ProxyAuthenticationError,
  ProxyUnavailableError,
  proxyAgent,
} from "./network-proxy.ts";

/** One brain owns every dispatcher until its response is consumed, cancelled or shutdown. */
export function createNetworkFetch(
  proxy: () => NetworkProxy | undefined,
  { responseTimeoutMs }: { responseTimeoutMs?: number } = {},
) {
  const lifetime = new AbortController();
  const owners = new Map<Dispatcher, Promise<void>>();
  const completions = new Set<Promise<void>>();
  let cleanupFailed = false;
  const networkFetch: typeof globalThis.fetch = async (input, init) => {
    const { Agent, fetch } = createRequire(import.meta.url)("undici") as typeof import("undici");

    lifetime.signal.throwIfAborted();
    const request = new Request(input, init);
    const signal = AbortSignal.any([
      request.signal,
      lifetime.signal,
      AbortSignal.timeout(1_200_000),
    ]);
    const selected = proxy();
    const timeouts = { headersTimeout: responseTimeoutMs, bodyTimeout: responseTimeoutMs };
    const agent = selected
      ? proxyAgent(selected, timeouts)
      : new Agent({ ...timeouts, connect: { timeout: 20_000 } });
    let complete = () => {};
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    completions.add(completion);
    let closing: Promise<void> | undefined;
    const close = () => {
      if (!closing) {
        closing = agent
          .destroy()
          .catch(() => {
            cleanupFailed = true;
            throw new Error("Network cleanup failed");
          })
          .finally(() => {
            signal.removeEventListener("abort", abort);
            owners.delete(agent);
            completions.delete(completion);
            complete();
          });
        owners.set(agent, closing);
      }
      return closing;
    };
    const abort = () => {
      void close().catch(() => {
        /* The owning request reports cancellation. */
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const response = await fetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        ...(request.body ? { body: request.body, duplex: "half" } : {}),
        signal,
        redirect: request.redirect,
        dispatcher: agent,
      } as RequestInit);
      if (!response.body) {
        await close();
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
        });
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              await close();
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            await close();
            reader.releaseLock();
            controller.error(isProxyUnavailable(error) ? new ProxyUnavailableError() : error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await close();
            reader.releaseLock();
          }
        },
      });
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
      });
      Object.defineProperty(result, "url", { value: response.url });
      return result;
    } catch (error) {
      await close();
      throw isProxyAuthenticationFailure(error)
        ? new ProxyAuthenticationError()
        : isProxyUnavailable(error)
          ? new ProxyUnavailableError()
          : error;
    }
  };
  return {
    fetch: networkFetch,
    async stop() {
      lifetime.abort();
      await Promise.all([...owners.values()]);
      await Promise.all([...completions]);
      if (cleanupFailed) throw new Error("Network cleanup failed");
    },
  };
}
