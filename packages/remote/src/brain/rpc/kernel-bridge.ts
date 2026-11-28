import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  EventEnvelopeSchema,
  type Methods,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { RemoteKernelEvent, RemoteKernelPort } from "./port.ts";

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}
const prefix = "pibot-capability:";
/** Private loopback reaches the same Peer/handler wrapper as the desktop, after its redaction. */
export function remoteKernelBridge(external: Port) {
  const origin = new AsyncLocalStorage<string | undefined>();
  const pending = new Map<string, Pending>();
  const listeners = new Set<(event: RemoteKernelEvent) => void>();
  const cancelListeners = new Set<(id: string) => void>();
  let receive: ((message: unknown) => void) | undefined;
  let off: (() => void) | undefined;
  let closed = false;
  const kernel: RemoteKernelPort = {
    dispatch(method: keyof typeof Methods, params: unknown, context) {
      context.signal.throwIfAborted();
      if (closed || !receive)
        return Promise.reject(new RpcError(RpcErrorCodes.closed, "remote_kernel_closed"));
      if (pending.size >= 16)
        return Promise.reject(new RpcError(RpcErrorCodes.busy, "remote_kernel_capacity"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const requestId = `${prefix}${JSON.stringify(["phone", id])}`;
        const abort = () => {
          for (const listener of cancelListeners) listener(requestId);
        };
        const cleanup = () => context.signal.removeEventListener("abort", abort);
        pending.set(id, { resolve, reject, cleanup });
        context.signal.addEventListener("abort", abort, { once: true });
        // Accepted mutations settle at the real response, even after the socket/caller cancels.
        origin.run(context.deviceId, () =>
          receive?.({ jsonrpc: "2.0", id: requestId, method, params }),
        );
        if (context.signal.aborted) abort();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const port: Port = {
    post(raw) {
      if (closed || !raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (typeof message.id === "string" && message.id.startsWith(prefix)) {
        const [owner, id] = JSON.parse(message.id.slice(prefix.length)) as [
          string,
          string | number | null,
        ];
        if (owner === "external") external.post({ ...message, id });
        else if (owner === "phone" && typeof id === "string") {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.cleanup();
          if ("error" in message) {
            const error = message.error as { code: number; message: string };
            request.reject(new RpcError(error.code, error.message));
          } else request.resolve(message.result);
        }
        return;
      }
      external.post(raw);
      const event = EventEnvelopeSchema.safeParse(raw);
      if (event.success)
        for (const listener of listeners)
          listener({ method: event.data.method, payload: event.data.params.payload });
    },
    onMessage(listener) {
      receive = listener;
      off = external.onMessage((raw) =>
        origin.run(undefined, () => {
          if (!raw || typeof raw !== "object" || !("id" in raw)) return listener(raw);
          const message = raw as Record<string, unknown>;
          if (
            !(
              typeof message.id === "string" ||
              message.id === null ||
              (typeof message.id === "number" && Number.isSafeInteger(message.id))
            )
          )
            return listener(raw);
          // An external request can never forge a response address for a phone request.
          listener({ ...message, id: `${prefix}${JSON.stringify(["external", message.id])}` });
        }),
      );
      return () => {
        off?.();
        off = undefined;
        receive = undefined;
      };
    },
    onRequestCancel(listener) {
      cancelListeners.add(listener);
      return () => {
        cancelListeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      off?.();
      receive = undefined;
      for (const request of pending.values()) {
        request.cleanup();
        request.reject(new RpcError(RpcErrorCodes.closed, "remote_kernel_closed"));
      }
      pending.clear();
      listeners.clear();
      cancelListeners.clear();
      external.dispose?.();
    },
  };
  return {
    port,
    kernel,
    isPhoneRequest: () => !!origin.getStore(),
    phoneRequestDeviceId: () => origin.getStore(),
  };
}
