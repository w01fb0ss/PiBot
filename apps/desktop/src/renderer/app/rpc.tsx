import { disposeChatControllers } from "@pibot/client-core";
import {
  createPeer,
  EventEnvelopeSchema,
  type EventPayloads,
  Events,
  Methods,
} from "@pibot/protocol";
import { type BrainState, type Peer, RpcContext, type RpcContextValue } from "@pibot/renderer-kit";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { businessPort } from "./business-port.ts";

/** Owns the renderer ↔ brain MessagePort. main re-sends a fresh port after every brain restart. */
export function RpcProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Omit<RpcContextValue, "consumeNavigation">>({
    peer: null,
    state: "starting",
  });
  const portRef = useRef<MessagePort | undefined>(undefined);

  useEffect(() => {
    let current: Peer | null = null;
    let offNavigation: (() => void) | undefined;
    const drop = () => {
      offNavigation?.();
      offNavigation = undefined;
      if (current) disposeChatControllers(current);
      current?.dispose();
      current = null;
      portRef.current?.close();
      portRef.current = undefined;
    };
    // brain.status comes from main over a private channel so it still arrives when the brain is down.
    const onStatus = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== "pibot:status") return;
      const parsed = EventEnvelopeSchema.safeParse(event.data.envelope);
      if (!parsed.success || parsed.data.method !== "brain.status") return;
      const state = parsed.data.params.payload.state as BrainState;
      if (state !== "ready") drop();
      setValue((prev) => ({
        ...prev,
        peer: state === "ready" ? prev.peer : null,
        state,
      }));
    };
    window.addEventListener("message", onStatus);
    const unsubscribe = window.pibot.onPort((port, options) => {
      drop();
      portRef.current = port;
      current = createPeer(businessPort(port, options?.scheduled), {
        methods: Methods,
        events: Events,
      });
      const receiving = current;
      offNavigation = current.on("ui.navigate", (navigation) => {
        if (current === receiving) setValue((previous) => ({ ...previous, navigation }));
      });
      setValue((previous) => ({ ...previous, peer: current, state: "ready" }));
    });
    return () => {
      unsubscribe();
      window.removeEventListener("message", onStatus);
      drop();
    };
  }, []);

  const consumeNavigation = useCallback((target: EventPayloads["ui.navigate"]) => {
    setValue((previous) =>
      previous.navigation === target ? { ...previous, navigation: undefined } : previous,
    );
  }, []);
  return (
    <RpcContext.Provider
      value={{
        ...value,
        consumeNavigation,
        registerSkillDrop: window.pibotSkillDrop,
      }}
    >
      {children}
    </RpcContext.Provider>
  );
}
