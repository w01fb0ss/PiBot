import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo, BlockList, isIP, type Socket } from "node:net";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  CONNECTOR_NETWORK_WAIT_MS,
  type ConnectorNetworkFilter,
  connectorNetworkRefusal,
  connectorPrivateDnsAnswer,
} from "./connector-network.ts";
import { dialTarget } from "./network-dial.ts";
import { checkedTarget, listedTarget, targetAllowed, targetUrl } from "./network-target.ts";

function proxyBypass(value = "") {
  const cidr = new BlockList();
  const names: { host: string; port?: number }[] = [];
  for (const rule of value
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)) {
    if (rule === "*") return () => true;
    if (rule.includes("/")) {
      const [host, bits, extra] = rule.split("/");
      const address = host?.replace(/^\[|\]$/g, "") ?? "";
      const family = isIP(address);
      if (
        family &&
        bits &&
        /^\d+$/.test(bits) &&
        extra === undefined &&
        Number(bits) <= (family === 6 ? 128 : 32)
      )
        cidr.addSubnet(address, Number(bits), family === 6 ? "ipv6" : "ipv4");
      continue;
    }
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule);
    const host = (isIP(rule) ? rule : match?.[1])?.replace(/^\*?\.|^\[|\]$|\.$/g, "");
    if (host) names.push({ host, ...(match?.[2] ? { port: Number(match[2]) } : {}) });
  }
  return (host: string, port: number, address = host) => {
    const family = isIP(address);
    return (
      (family !== 0 && cidr.check(address, family === 6 ? "ipv6" : "ipv4")) ||
      names.some(
        (rule) =>
          (rule.port === undefined || rule.port === port) &&
          (host === rule.host || (!isIP(rule.host) && host.endsWith(`.${rule.host}`))),
      )
    );
  };
}

/** One authenticated parent proxy per SRT host, including its SOCKS-to-HTTP tunnels. */
export async function createSandboxNetwork(
  config: SandboxRuntimeConfig,
  privateNetworkHosts?: readonly string[],
  connectorFilter?: ConnectorNetworkFilter,
) {
  const original = config.network.parentProxy;
  const bypass = proxyBypass(original?.noProxy);
  const allowed = [...config.network.allowedDomains];
  // A command's website list grants public destinations only. Keep per-run private consent
  // separate; profiles outside the command runner retain their own domain semantics.
  const privateHosts = connectorFilter ? [] : [...(privateNetworkHosts ?? allowed)];
  const authorization = Buffer.from(
    `Basic ${Buffer.from(`pibot:${randomBytes(32).toString("hex")}`).toString("base64")}`,
  );
  const lifetime = new AbortController();
  const sockets = new Set<Socket>();
  const active = new Set<Promise<void>>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      /* The request/tunnel owner handles failure; never expose raw socket errors. */
    });
    socket.once("close", () => sockets.delete(socket));
  };
  const authenticated = (req: IncomingMessage) => {
    const value = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return value.length === authorization.length && timingSafeEqual(value, authorization);
  };
  const dial = async (value: string, tunnel: boolean, signal: AbortSignal) => {
    let target: ReturnType<typeof targetUrl>;
    try {
      target = targetUrl(value, tunnel);
    } catch (error) {
      if (connectorFilter && !tunnel) {
        const url = new URL(value);
        const host = url.hostname
          .replace(/^\[|\]$/gu, "")
          .toLowerCase()
          .replace(/\.$/u, "");
        if (host && url.protocol !== "http:" && url.protocol !== "https:")
          await connectorFilter({ host, port: Number(url.port || 80), refusal: "scheme" }, signal);
      }
      throw error;
    }
    const { url, host, port } = target;
    const parent = tunnel ? original?.https || original?.http : original?.http || original?.https;
    const upstream = bypass(host, port) ? undefined : parent || undefined;
    const refusal = connectorFilter && connectorNetworkRefusal(host);
    if (refusal) {
      await connectorFilter?.({ host, port, refusal }, signal);
      throw new Error("private_address");
    }
    const address = await checkedTarget(
      host,
      port,
      privateHosts,
      // Only a separately approved destination may rely on the user's proxy to resolve it.
      !connectorFilter &&
        !!upstream &&
        (privateNetworkHosts === undefined || listedTarget(host, port, privateHosts)),
      signal,
      connectorFilter ? connectorPrivateDnsAnswer : undefined,
    ).catch(async (error) => {
      signal.throwIfAborted();
      await connectorFilter?.(
        {
          host,
          port,
          refusal:
            error instanceof Error && error.message === "private_address" ? "private" : "dns",
        },
        signal,
      );
      throw error;
    });
    if (connectorFilter && !(await connectorFilter({ host, port }, signal)))
      throw new Error("connector_network_denied");
    signal.throwIfAborted();
    return {
      url,
      socket: await dialTarget({
        // Pin the checked address even through an upstream; a second DNS lookup could map a
        // saved public domain to a private address that was never approved for this run.
        host: !connectorFilter && privateNetworkHosts === undefined ? host : address,
        address,
        port,
        upstream: bypass(host, port, address) ? undefined : upstream,
        signal,
        track,
      }),
    };
  };
  const run = (work: () => Promise<void>, fail: () => void) => {
    if (lifetime.signal.aborted || active.size >= 64 || sockets.size >= 256) return fail();
    const pending = work()
      .catch(fail)
      .finally(() => active.delete(pending));
    active.add(pending);
  };
  const setupBudget = connectorFilter ? CONNECTOR_NETWORK_WAIT_MS : 20_000;
  const server = createServer((req, res) => {
    if (!authenticated(req)) {
      res.writeHead(407).end();
      return;
    }
    run(
      () => forward(req, res),
      () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(403).end("sandbox_network_denied");
      },
    );
  });
  async function forward(req: IncomingMessage, res: ServerResponse) {
    const cancelled = new AbortController();
    const setup = new AbortController();
    const started = performance.now();
    let timer = setTimeout(() => setup.abort(), setupBudget);
    let receivedHeaders = false;
    const abort = () => cancelled.abort();
    res.once("close", abort);
    const signal = AbortSignal.any([lifetime.signal, cancelled.signal, setup.signal]);
    let socket: Socket | undefined;
    try {
      const target = await dial(req.url ?? "", false, signal);
      socket = target.socket;
      clearTimeout(timer);
      const headerBudget = Math.max(0, setupBudget - (performance.now() - started));
      const headers: IncomingHttpHeaders = { ...req.headers, host: target.url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      delete headers.upgrade;
      headers.connection = "close";
      await new Promise<void>((resolve, reject) => {
        const request = httpRequest(
          {
            method: req.method,
            path: target.url.pathname + target.url.search,
            headers,
            // An Agent (including agent:false's implicit one) ignores createConnection and
            // would re-dial an unchecked address. This request owns exactly the checked socket.
            createConnection: () => target.socket,
            signal,
          },
          (response) => {
            receivedHeaders = true;
            clearTimeout(timer);
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.on("error", reject);
            response.once("end", resolve);
            response.pipe(res);
          },
        );
        // Upload time is owned by the command lifetime. Only start waiting for response
        // headers after the upload finishes; the body keeps cancellation, not a deadline.
        request.once("finish", () => {
          if (!receivedHeaders) timer = setTimeout(() => setup.abort(), headerBudget);
        });
        request.once("error", reject);
        req.once("error", () => request.destroy(new Error("request_failed")));
        req.pipe(request);
        target.socket.resume();
      });
    } finally {
      clearTimeout(timer);
      res.off("close", abort);
      socket?.destroy();
    }
  }
  server.on("connect", (req, client, head) => {
    if (!authenticated(req)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    run(
      async () => {
        const cancelled = new AbortController();
        const abort = () => cancelled.abort();
        client.once("close", abort);
        const signal = AbortSignal.any([
          lifetime.signal,
          cancelled.signal,
          AbortSignal.timeout(setupBudget),
        ]);
        try {
          const { socket } = await dial(req.url ?? "", true, signal);
          if (client.destroyed || lifetime.signal.aborted) {
            socket.destroy();
            return;
          }
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) socket.write(head);
          client.once("close", () => socket.destroy());
          socket.once("close", () => client.destroy());
          socket.pipe(client);
          client.pipe(socket);
          socket.resume();
        } finally {
          client.off("close", abort);
        }
      },
      () => client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nsandbox_network_denied"),
    );
  });
  server.on("connection", (socket) => {
    if (sockets.size >= 256 || lifetime.signal.aborted) {
      socket.destroy();
      return;
    }
    track(socket);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const credentials = authorization.toString().slice(6);
  const [user, password] = Buffer.from(credentials, "base64").toString().split(":");
  const url = `http://${user}:${password}@127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    parentProxy: { http: url, https: url, noProxy: "" },
    // SRT always bypasses parent proxies for loopback. Route every policy decision through
    // the callback too; its configured allowlist would otherwise skip that callback entirely.
    config: {
      ...config,
      network: {
        ...config.network,
        allowedDomains: [],
        strictAllowlist: false,
        parentProxy: { http: url, https: url, noProxy: "" },
      },
    },
    authorize:
      (allowAll: boolean) =>
      async ({ host, port }: { host: string; port?: number }) => {
        try {
          if (port === undefined) return false;
          // The SDK callback receives the original spelling, although its bypass check uses
          // canonical hosts. Normalize inet_aton, trailing dots and mapped IPv6 identically.
          const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
          const target = targetUrl(`http://${authority}:${port}`);
          if (connectorFilter) {
            // SRT bypasses its parent proxy for loopback. Refuse local literals and names here;
            // the authenticated parent is the decision point for every public request.
            const refusal = connectorNetworkRefusal(target.host);
            if (refusal) {
              await connectorFilter(
                { host: target.host, port: target.port, refusal },
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(1000)]),
              );
              return { allow: false as const, reason: "pibot_connector_network_denied" };
            }
            return !lifetime.signal.aborted;
          }
          if (lifetime.signal.aborted || !targetAllowed(target.host, target.port, privateHosts))
            return false;
          if (!allowAll && !listedTarget(target.host, target.port, allowed))
            return { allow: false as const, reason: "pibot_website_not_allowed" };
          return true;
        } catch {
          return false;
        }
      },
    async close() {
      lifetime.abort();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.allSettled([...active]);
      await closed;
    },
  };
}
