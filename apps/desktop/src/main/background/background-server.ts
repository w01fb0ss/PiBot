import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";
import {
  ACP_MAX_FRAME,
  type BackgroundControlSchema,
  type BackgroundDescriptorSchema,
  type BackgroundWire,
  type BrowserFrameMessage,
  createPeer,
  GuiHostMethods,
  Methods,
  type Peer,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { createBackgroundHeartbeat } from "@pibot/sdk/node";
import { z } from "zod";
import { encodeFrameWire } from "../browser-frames/browser-frames-wire.ts";
import { createBackgroundAcp } from "./background-acp.ts";
import type { LoopbackReservation } from "./background-loopback.ts";
import { framedSocket, MAX_FRAME } from "./background-wire.ts";

const REQUEST_GUARD_MS = 120_000;
const REQUEST_GUARD_GRACE_MS = 30_000;

const requestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(100), z.number().int().safe(), z.null()]),
  method: z.string().max(100),
  params: z.unknown().optional(),
});
type Control = z.infer<typeof BackgroundControlSchema>;
export async function createBackgroundServer(options: {
  descriptor: z.infer<typeof BackgroundDescriptorSchema>;
  control(client: string, value: Control, pid: number): Promise<unknown>;
  disconnected(client: string, pid: number): Promise<void>;
  failed(): void;
  /** Reason code for every socket drop, so a lost GUI can be diagnosed. */
  log?(reason: string): void;
  requestTimedOut?(method: string): void;
  loopback?: LoopbackReservation;
}) {
  const acp = createBackgroundAcp(options.failed);
  const clients = new Map<
    string,
    {
      wire: ReturnType<typeof framedSocket>;
      socket: Socket;
      attached: boolean;
      role: "gui" | "acp" | "unknown";
      gui: Peer<typeof GuiHostMethods, Record<string, never>>;
      guiListeners: Set<(message: unknown) => void>;
      pending: Map<
        string,
        { original: unknown; timer: ReturnType<typeof setTimeout>; bytes: number }
      >;
    }
  >();
  const sockets = new Set<Socket>();
  const listeners = new Set<(message: unknown) => void>();
  const frameAcks = new Set<(botId: string, seq: number, groupId?: string) => void>();
  let stopping = false;
  let retainedBytes = 0;
  let admissionAt = Date.now();
  let admissions = 0;
  const dropped = new WeakSet<Socket>();
  // Every drop records why, so a GUI that lost the socket can be diagnosed
  // from the log instead of guessing (22 silent destroy() calls before).
  const drop = (socket: Socket, reason: string) => {
    if (!dropped.has(socket)) options.log?.(reason);
    dropped.add(socket);
    socket.destroy();
  };
  const receive = (socket: Socket) => {
    if (Date.now() - admissionAt >= 1000) {
      admissionAt = Date.now();
      admissions = 0;
    }
    if (stopping || sockets.size >= 8 || (options.loopback && ++admissions > 16)) {
      drop(socket, "admission");
      return;
    }
    sockets.add(socket);
    const id = randomUUID();
    let authenticated = false,
      controls = 0;
    let clientPid = 0;
    let peerEnded = false;
    let heartbeat: ReturnType<typeof createBackgroundHeartbeat> | undefined;
    socket.once("end", () => {
      peerEnded = true;
    });
    const timer = setTimeout(() => drop(socket, "auth_timeout"), 5000);
    const wire = framedSocket(
      socket,
      (message, bytes) => {
        if (!authenticated) {
          const expected = options.descriptor;
          if (options.loopback && message.kind === "auth" && message.clientKind === "acp")
            return wire
              .sendAsync({ kind: "acp-error", code: "attach_unsupported_platform" })
              .finally(() => drop(socket, "acp_unsupported"));
          if (message.kind === "auth" && message.version !== expected.version) {
            return wire
              .sendAsync({ kind: "acp-error", code: "version_mismatch" })
              .finally(() => drop(socket, "version_mismatch"));
          }
          if (
            message.kind !== "auth" ||
            message.version !== expected.version ||
            message.instance !== expected.instance ||
            !timingSafeEqual(Buffer.from(message.token), Buffer.from(expected.token))
          ) {
            drop(socket, "auth_failed");
            return;
          }
          authenticated = true;
          clientPid = message.pid;
          clearTimeout(timer);
          wire.authenticated();
          const guiListeners = new Set<(message: unknown) => void>();
          const gui = createPeer(
            {
              post: (message) => wire.send({ kind: "gui", message }),
              onMessage: (listener) => {
                guiListeners.add(listener);
                return () => guiListeners.delete(listener);
              },
            },
            { methods: GuiHostMethods, events: {} },
          );
          clients.set(id, {
            wire,
            socket,
            attached: false,
            role: message.clientKind === "acp" ? "acp" : "unknown",
            gui,
            guiListeners,
            pending: new Map(),
          });
          if (message.clientKind === "acp") gui.dispose();
          wire.send({ kind: "ready", instance: expected.instance });
          heartbeat = createBackgroundHeartbeat({
            send: wire.send,
            failed: (reason) => drop(socket, reason),
          });
          return;
        }
        const client = clients.get(id);
        if (!client) return;
        if (heartbeat?.receive(message)) return;
        if (message.kind === "control" && message.control.type === "acp-attach") {
          if (client.attached || client.role === "gui") {
            drop(socket, "acp_attach_conflict");
            return;
          }
          client.role = "acp";
          client.gui.dispose();
          wire.limit(ACP_MAX_FRAME + 1024);
          return acp
            .attach(
              id,
              message.control.client,
              (value) => wire.sendAsync(value as BackgroundWire),
              wire.close,
            )
            .then(() => {
              wire.send({ kind: "reply", id: message.id, ok: true });
            })
            .catch(async (error) => {
              const code =
                error instanceof RpcError && error.message === "acp_busy"
                  ? "acp_busy"
                  : error instanceof RpcError && error.message === "attach_unsupported_platform"
                    ? "attach_unsupported_platform"
                    : "app_quit";
              await wire.sendAsync({ kind: "acp-error", code }).catch(() => {});
              drop(socket, "acp_attach_failed");
            });
        }
        if (client.role === "acp") {
          if (message.kind === "acp") return acp.frame(id, message.message);
          if (message.kind === "control" && message.control.type === "acp-detach")
            return acp.disconnected(id);
          drop(socket, "acp_unexpected_message");
          return;
        }
        if (message.kind === "acp" || message.kind === "acp-error") {
          drop(socket, "acp_frame_unexpected");
          return;
        }
        if (message.kind === "gui") {
          for (const listener of client.guiListeners) listener(message.message);
          return;
        }
        // Overlay frame acks never enter the business queue or the control lane.
        if (message.kind === "browser-frame-ack") {
          if (client.attached)
            for (const listener of frameAcks) listener(message.botId, message.seq, message.groupId);
          return;
        }
        if (message.kind === "control") {
          if (++controls > 16) {
            drop(socket, "control_flood");
            return;
          }
          void (async () => {
            if (
              !client.attached &&
              !["attach", "state", "stop-service", "restart-brain", "brain-state"].includes(
                message.control.type,
              )
            )
              throw new Error("client_not_attached");
            if (message.control.type === "detach") {
              client.attached = false;
              client.gui.dispose();
            }
            if (message.control.type === "attach" && !client.attached) {
              client.gui.dispose();
              client.gui = createPeer(
                {
                  post: (message) => wire.send({ kind: "gui", message }),
                  onMessage: (listener) => {
                    client.guiListeners.add(listener);
                    return () => client.guiListeners.delete(listener);
                  },
                },
                { methods: GuiHostMethods, events: {} },
              );
            }
            const result = await options.control(id, message.control, clientPid);
            if (message.control.type === "attach") {
              client.attached = true;
              client.role = "gui";
            }
            if (message.control.type === "detach") client.attached = false;
            wire.send({ kind: "reply", id: message.id, ok: true, result });
          })()
            .catch((error) => {
              try {
                wire.send({
                  kind: "reply",
                  id: message.id,
                  ok: false,
                  code: error instanceof RpcError ? error.code : RpcErrorCodes.internal,
                });
              } catch {
                drop(socket, "reply_send_failed");
              }
            })
            .finally(() => {
              controls--;
            });
          return;
        }
        if (message.kind !== "business" || !client.attached) {
          drop(socket, "business_unattached");
          return;
        }
        const parsed = requestSchema.safeParse(message.message);
        if (!parsed.success || !Object.hasOwn(Methods, parsed.data.method)) {
          drop(socket, "invalid_request");
          return;
        }
        const schema = Methods[parsed.data.method as keyof typeof Methods];
        if (!schema.params.safeParse(parsed.data.params).success) {
          drop(socket, "invalid_params");
          return;
        }
        if (retainedBytes + bytes > MAX_FRAME * 2) {
          drop(socket, "frame_overflow");
          return;
        }
        // A valid GUI burst must not discard previously accepted requests.
        if (client.pending.size >= 16) {
          wire.send({
            kind: "business",
            message: {
              jsonrpc: "2.0",
              id: parsed.data.id,
              error: { code: RpcErrorCodes.busy, message: "background_busy" },
            },
          });
          return;
        }
        const route = `client:${id}:${randomUUID()}`;
        retainedBytes += bytes;
        // A request deadline says nothing about the connection or other runs. Retire only
        // this route; its operation may already have committed, so never replay it here.
        const declared = (schema as { timeoutMs?: number }).timeoutMs ?? 0;
        client.pending.set(route, {
          original: parsed.data.id,
          timer: setTimeout(
            () => {
              const pending = client.pending.get(route);
              if (!pending) return;
              client.pending.delete(route);
              retainedBytes -= pending.bytes;
              options.requestTimedOut?.(parsed.data.method);
              try {
                wire.send({
                  kind: "business",
                  message: {
                    jsonrpc: "2.0",
                    id: pending.original,
                    error: { code: RpcErrorCodes.timeout, message: "background_request_timeout" },
                  },
                });
              } catch {
                drop(socket, "reply_send_failed");
              }
            },
            Math.max(REQUEST_GUARD_MS, declared + REQUEST_GUARD_GRACE_MS),
          ),
          bytes,
        });
        for (const listener of listeners) listener({ ...parsed.data, id: route });
      },
      4096,
      (bytes) => {
        if (retainedBytes + bytes > MAX_FRAME * 2) return undefined;
        retainedBytes += bytes;
        return () => {
          retainedBytes -= bytes;
        };
      },
    );
    socket.once("close", (hadError) => {
      clearTimeout(timer);
      heartbeat?.dispose();
      if (!dropped.has(socket))
        options.log?.(
          peerEnded ? "peer_closed" : hadError ? "transport_error" : "transport_closed",
        );
      dropped.add(socket);
      sockets.delete(socket);
      const client = clients.get(id);
      clients.delete(id);
      client?.gui.dispose();
      for (const pending of client?.pending.values() ?? []) {
        clearTimeout(pending.timer);
        retainedBytes -= pending.bytes;
      }
      client?.pending.clear();
      if (client?.role === "acp") void acp.disconnected(id).catch(options.failed);
      else if (authenticated) void options.disconnected(id, clientPid).catch(options.failed);
    });
  };
  const server = options.loopback?.server ?? createServer(receive);
  if (options.loopback) options.loopback.activate(receive);
  else
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.descriptor.endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error) => {
      stopping = true;
      for (const socket of sockets) drop(socket, "listen_failed");
      // A failed listen has no writer and no accepting listener to retain.
      server.close();
      throw error;
    });
  server.on("error", options.failed);
  const port: Port = {
    post(message) {
      if (!message || typeof message !== "object") return;
      if ("id" in message) {
        for (const client of clients.values()) {
          const route = typeof message.id === "string" ? client.pending.get(message.id) : undefined;
          if (!route) continue;
          clearTimeout(route.timer);
          retainedBytes -= route.bytes;
          client.pending.delete(String(message.id));
          try {
            client.wire.send({ kind: "business", message: { ...message, id: route.original } });
          } catch {
            drop(client.socket, "post_failed");
          }
          return;
        }
      } else {
        for (const client of clients.values())
          if (client.attached) {
            try {
              client.wire.send({ kind: "business", message });
            } catch {
              drop(client.socket, "post_failed");
            }
          }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    port,
    acpPort: acp.port,
    disconnectAcp: acp.stop,
    acpRetired: acp.retired,
    /**
     * Forward the deadline the picker asked for. A fixed 60 s cut off a native dialog
     * that was still on screen, and the caller then reported a timeout the user could not clear
     * by cancelling. Callers that declare nothing keep the short guard.
     */
    gui<K extends keyof typeof GuiHostMethods>(
      method: K,
      params: z.input<(typeof GuiHostMethods)[K]["params"]>,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) {
      const client = [...clients.values()].find((value) => value.attached);
      if (!client) throw new Error("gui_offline");
      return client.gui.call(method, params, {
        timeoutMs: options?.timeoutMs ?? 60_000,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
    /** Overlay frames to attached windows; false when none is attached (the stream stops). */
    browserFrame(message: BrowserFrameMessage) {
      let delivered = false;
      const wire: BackgroundWire = { kind: "browser-frame", message: encodeFrameWire(message) };
      for (const client of clients.values()) {
        if (!client.attached) continue;
        try {
          client.wire.send(wire);
          delivered = true;
        } catch {
          drop(client.socket, "frame_send_failed");
        }
      }
      return delivered;
    },
    onBrowserFrameAck(listener: (botId: string, seq: number, groupId?: string) => void) {
      frameAcks.add(listener);
      return () => {
        frameAcks.delete(listener);
      };
    },
    sendToClient(id: string, message: BackgroundWire) {
      const client = clients.get(id);
      if (!client) return false;
      try {
        client.wire.send(message);
        return true;
      } catch {
        drop(client.socket, "client_send_failed");
        return false;
      }
    },
    broadcast(message: BackgroundWire) {
      for (const client of clients.values()) {
        if (client.role === "acp") continue;
        try {
          client.wire.send(message);
        } catch {
          drop(client.socket, "broadcast_failed");
        }
      }
    },
    async close() {
      stopping = true;
      await acp.stop();
      for (const socket of sockets) drop(socket, "server_close");
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      listeners.clear();
      frameAcks.clear();
    },
  };
}
