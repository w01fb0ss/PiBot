import type { Port } from "@pibot/protocol-base";
import { z } from "zod";
import {
  base64url,
  concat,
  equal,
  LinkError,
  type RandomBytes,
  unbase64,
  utf8,
} from "../core/bytes.ts";
import { dhPublic, type EndpointKeys, sharedSecret } from "../keys/endpoint.ts";
import { deriveRoomKey } from "../room/ticket.ts";
import { establishNoise } from "../transport/handshake.ts";
import { type BinaryTransport, encryptedPort } from "../transport/port.ts";
import { acceptIdentity, identityProof } from "./identity.ts";
import { decodeRunnerPairCode } from "./runner.ts";

const MAGIC = utf8("pibot-runner-bootstrap-v1:");
const RUNNER_HANDSHAKE_MS = 15_000;
const proof = z.strictObject({
  name: z.string().max(200),
  publicKey: z.string().max(64),
  signature: z.string().max(128),
});
const greeting = z.strictObject({ identity: proof });
const confirmation = z.strictObject({ identity: proof, rotation: z.string().max(64) });
const ack = z.strictObject({ paired: z.literal(true) });

export function receivePairMessage(port: Port, signal: AbortSignal) {
  const result = new Promise<unknown>((resolve, reject) => {
    const abort = () => finish(undefined, new LinkError("pairing_unavailable"));
    let off = () => {};
    let offClose = () => {};
    const finish = (value?: unknown, error?: Error) => {
      off();
      offClose();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    off = port.onMessage((value) => finish(value));
    offClose = port.onClose?.(abort) ?? (() => {});
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  void result.catch(() => {});
  return result;
}

/** Bootstrap key is untrusted until IKpsk2 and the bound signing identity both confirm. */
export async function pairRunnerSession(options: {
  transport: BinaryTransport;
  keys: EndpointKeys;
  code: string;
  name: string;
  role: "initiator" | "responder";
  random: RandomBytes;
  signal: AbortSignal;
  commit(value: { publicKey: string; rotation: string; name: string }): Promise<void>;
}) {
  const { transport, keys, signal, role } = options;
  const decoded = decodeRunnerPairCode(options.code);
  let bootstrapTimer: ReturnType<typeof setInterval> | undefined;
  let port: Port | undefined;
  try {
    let remoteStatic: Uint8Array | undefined;
    const isBootstrap = (frame: Uint8Array) =>
      frame.length === MAGIC.length + 32 && equal(frame.subarray(0, MAGIC.length), MAGIC);
    const wire: BinaryTransport = {
      ...transport,
      subscribe: (listener) =>
        transport.subscribe((frame) => {
          if (!isBootstrap(frame)) listener(frame);
        }),
    };
    if (role === "initiator") {
      remoteStatic = await new Promise<Uint8Array>((resolve, reject) => {
        const abort = () => {
          off();
          signal.removeEventListener("abort", abort);
          reject(new LinkError("pairing_unavailable"));
        };
        const off = transport.subscribe((frame) => {
          if (!isBootstrap(frame)) return;
          off();
          signal.removeEventListener("abort", abort);
          resolve(frame.slice(MAGIC.length));
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    } else {
      const hello = concat(MAGIC, keys.dhPublic);
      const send = () => {
        try {
          transport.send(hello);
        } catch {
          transport.close();
        }
      };
      bootstrapTimer = setInterval(send, 250);
      // The first initiator handshake stops bootstrap before its responder message is sent.
      const original = wire.subscribe;
      wire.subscribe = (listener) =>
        original((frame) => {
          clearInterval(bootstrapTimer);
          listener(frame);
        });
      send();
    }
    const channel = await establishNoise(wire, {
      role,
      staticSecret: keys.dhSecret,
      remoteStatic,
      psk: decoded.psk,
      prologue: decoded.prologue,
      random: options.random,
      signal,
      timeoutMs: RUNNER_HANDSHAKE_MS,
    });
    clearInterval(bootstrapTimer);
    port = encryptedPort(channel, wire, { signal });
    if (role === "responder") {
      const response = receivePairMessage(port, signal);
      port.post({ identity: identityProof(keys, channel, options.name) });
      const data = confirmation.parse(await response);
      const peer = acceptIdentity(data.identity, channel);
      unbase64(data.rotation, 32);
      signal.throwIfAborted();
      await options.commit({
        publicKey: base64url(peer.publicKey),
        name: peer.name,
        rotation: data.rotation,
      });
      port.post({ paired: true });
      // Keep the response transport alive until the desktop confirms its durable commit.
      const committed = await receivePairMessage(port, signal);
      ack.parse(committed);
    } else {
      const peer = acceptIdentity(
        greeting.parse(await receivePairMessage(port, signal)).identity,
        channel,
      );
      const rotation = options.random(32);
      try {
        const response = receivePairMessage(port, signal);
        port.post({
          identity: identityProof(keys, channel, options.name),
          rotation: base64url(rotation),
        });
        ack.parse(await response);
        signal.throwIfAborted();
        await options.commit({
          publicKey: base64url(peer.publicKey),
          name: peer.name,
          rotation: base64url(rotation),
        });
        port.post({ paired: true });
      } finally {
        rotation.fill(0);
      }
    }
  } finally {
    clearInterval(bootstrapTimer);
    decoded.psk.fill(0);
    decoded.prologue.fill(0);
    port?.dispose?.();
    transport.close();
  }
}

export function runnerRoomKey(keys: EndpointKeys, peerPublic: string, rotation: string) {
  const shared = sharedSecret(keys, unbase64(peerPublic, 32));
  try {
    return deriveRoomKey(shared, unbase64(rotation, 32));
  } finally {
    shared.fill(0);
  }
}

export async function connectRunnerSession(options: {
  transport: BinaryTransport;
  keys: EndpointKeys;
  publicKey: string;
  role: "initiator" | "responder";
  random: RandomBytes;
  signal: AbortSignal;
  timeoutMs?: number;
  /** A distinct authenticated domain for delegated phone control. */
  authorizationSignature?: string;
}) {
  const channel = await establishNoise(options.transport, {
    role: options.role,
    staticSecret: options.keys.dhSecret,
    remoteStatic: dhPublic(unbase64(options.publicKey, 32)),
    random: options.random,
    prologue: utf8(
      options.authorizationSignature
        ? `pibot-phone-runner-session-v1:${options.authorizationSignature}`
        : "pibot-runner-session-v1",
    ),
    signal: options.signal,
    // A paired relay can be just as slow as the relay used to pair.
    timeoutMs: options.timeoutMs ?? RUNNER_HANDSHAKE_MS,
  });
  return encryptedPort(channel, options.transport, { signal: options.signal });
}
