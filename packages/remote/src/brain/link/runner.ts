import { randomBytes } from "node:crypto";
import {
  base64url,
  connectRunnerSession,
  createRunnerDrain,
  decodeRunnerPairCode,
  destroyEndpoint,
  drainRunnerConnection,
  endpointKeys,
  openRunnerRelay,
  pairRunnerSession,
  RunnerDrainError,
  resumeRunnerDrain,
  roomTicket,
  runnerDeviceId,
  runnerPairRoom,
  runnerRoomKey,
  safetyCode,
  unbase64,
} from "@pibot/link";
import type { RemoteLinkPort } from "./port.ts";
import { runnerNetwork } from "./runner-network.ts";
import type { LinkNetwork } from "./socket.ts";

function keys(identity: { privateKey: string; publicKey: string }) {
  const result = endpointKeys(unbase64(identity.privateKey, 32));
  if (base64url(result.signingPublic) !== identity.publicKey) {
    destroyEndpoint(result);
    throw new Error("remote_identity_mismatch");
  }
  return result;
}
export async function pairRunner(
  network: LinkNetwork,
  input: Parameters<NonNullable<RemoteLinkPort["pairRunner"]>>[0],
) {
  const identity = keys(input.identity);
  const sockets = runnerNetwork(network);
  const decoded = decodeRunnerPairCode(input.code);
  decoded.psk.fill(0);
  decoded.prologue.fill(0);
  if (decoded.relay && decoded.relay !== input.relayUrl) {
    destroyEndpoint(identity);
    // The runner waits on another relay; saying so beats a timeout or a generic "invalid code".
    throw new Error("pairing_relay_mismatch");
  }
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(input.generated ? 600_000 : 30_000),
  ]);
  let room: Awaited<ReturnType<typeof openRunnerRelay>> | undefined;
  let failed: unknown;
  try {
    room = await openRunnerRelay({
      WebSocket: sockets.WebSocket,
      relay: input.relayUrl,
      ticket: runnerPairRoom(decoded.hint),
      slot: runnerDeviceId(new TextEncoder().encode(decoded.hint.padEnd(32, ":"))),
      role: "desktop",
      signal,
    });
    input.onPeer?.();
    await pairRunnerSession({
      transport: room.transport,
      keys: identity,
      role: "initiator",
      code: input.code,
      name: input.name,
      random: randomBytes,
      signal: AbortSignal.any([signal, room.signal]),
      async commit(peer) {
        const key = runnerRoomKey(identity, peer.publicKey, peer.rotation);
        try {
          await input.commit({
            kind: "runner",
            name: peer.name,
            publicKey: peer.publicKey,
            room: peer.rotation,
            roomSecret: JSON.stringify({
              key: base64url(key),
              publicKey: peer.publicKey,
              rotation: peer.rotation,
            }),
            securityCode: safetyCode(identity.signingPublic, unbase64(peer.publicKey, 32)),
          });
        } finally {
          key.fill(0);
        }
      },
    });
  } catch (error) {
    failed = error;
    // Finally still owns drain; if it confirms success, only the failed connection remains.
    throw error instanceof RunnerDrainError ? new Error("transport_closed") : error;
  } finally {
    destroyEndpoint(identity);
    await drainRunnerConnection(
      [() => resumeRunnerDrain(failed), () => room?.close(), () => sockets.drain()],
      input.signal,
      () => {},
    );
  }
}
export async function connectPairedRunner(
  network: LinkNetwork,
  input: Parameters<RemoteLinkPort["connect"]>[0],
) {
  const identity = keys(input.identity);
  const sockets = runnerNetwork(network);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  let room: Awaited<ReturnType<typeof openRunnerRelay>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = runnerRoomKey(identity, input.publicKey, input.room);
    try {
      const ticket = roomTicket(key);
      timer = setTimeout(() => lifetime.abort(), 86_400_000 - (Date.now() % 86_400_000));
      room = await openRunnerRelay({
        WebSocket: sockets.WebSocket,
        relay: input.relayUrl,
        ticket,
        role: "desktop",
        peerTimeoutMs: 5000,
        slot: runnerDeviceId(unbase64(ticket.roomId, 32)),
        signal,
      });
    } finally {
      key.fill(0);
    }
    const active = AbortSignal.any([signal, room.signal]);
    const port = await connectRunnerSession({
      transport: room.transport,
      keys: identity,
      publicKey: input.publicKey,
      role: "responder",
      random: randomBytes,
      signal: active,
    });
    const drain = createRunnerDrain(
      [() => port.dispose?.(), () => room?.close(), () => sockets.drain()],
      input.signal,
      () => {},
    );
    const opened = room;
    return {
      port,
      signal: active,
      ended: () => opened.ended(),
      onPresence(fn: (online: boolean) => void) {
        fn(!active.aborted);
        const end = () => fn(false);
        active.addEventListener("abort", end, { once: true });
        return () => active.removeEventListener("abort", end);
      },
      async close() {
        clearTimeout(timer);
        lifetime.abort();
        await drain();
      },
    };
  } catch (error) {
    clearTimeout(timer);
    lifetime.abort();
    await drainRunnerConnection(
      [() => resumeRunnerDrain(error), () => room?.close(), () => sockets.drain()],
      input.signal,
      () => {},
    );
    // The old drain error has been discharged; a new drain failure above keeps its own owner.
    throw error instanceof RunnerDrainError ? new Error("transport_closed") : error;
  } finally {
    destroyEndpoint(identity);
  }
}
