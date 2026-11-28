import type { createPeer, EventPayloads, Events, Methods } from "@pibot/protocol";
import { createContext, useContext, useEffect, useRef } from "react";

export type Peer = ReturnType<typeof createPeer<typeof Methods, typeof Events>>;
export type BrainState = "starting" | "ready" | "restarting" | "failed";

export interface RpcContextValue {
  /** null until the brain port arrives, and again while the brain restarts. */
  peer: Peer | null;
  state: BrainState;
  registerSkillDrop?(files: File[]): Promise<string | null>;
  navigation?: EventPayloads["ui.navigate"];
  consumeNavigation(target: EventPayloads["ui.navigate"]): void;
}

/** Filled by the desktop `RpcProvider`, which owns the renderer ↔ brain MessagePort. */
export const RpcContext = createContext<RpcContextValue>({
  peer: null,
  state: "starting",
  consumeNavigation: () => {},
});

export function useRpc(): RpcContextValue {
  return useContext(RpcContext);
}

/** Subscribe to a brain event for the lifetime of the component (re-subscribes after reconnect). */
export function useRpcEvent<K extends keyof EventPayloads>(
  event: K,
  handler: (payload: EventPayloads[K]) => void,
): void {
  const { peer } = useRpc();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!peer) return;
    return peer.on(event, (payload) => ref.current(payload as EventPayloads[K]));
  }, [peer, event]);
}
