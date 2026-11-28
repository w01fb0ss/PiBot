// Keep the conversation switch in sync with the brain and other windows.
import type { ChatPeer } from "@pibot/client-core";
import type { ConversationYolo } from "@pibot/protocol";
import { useCallback, useEffect, useState } from "react";

/**
 * The YOLO switch of one conversation (DM topic or group conversation). `state` is null
 * while unknown or when the conversation cannot have one (a draft, a routine's topic), in which
 * case no control is shown. Other windows follow through `conversations.yolo.changed`.
 */
export function useConversationYolo(peer: ChatPeer | null | undefined, conversationId?: string) {
  const [state, setState] = useState<ConversationYolo | null>(null);
  useEffect(() => {
    setState(null);
    if (!peer || !conversationId) return;
    let request: AbortController | undefined;
    const load = () => {
      request?.abort();
      request = new AbortController();
      const { signal } = request;
      return peer.call("conversations.yolo.get", { conversationId }, { signal }).then(
        (value) => {
          if (!signal.aborted) setState(value);
        },
        () => {
          // Unavailable here (routine topic, archived, older brain): show no switch.
          if (!signal.aborted) setState(null);
        },
      );
    };
    const offs = [
      peer.on("conversations.yolo.changed", (event) => {
        if (event.conversationId !== conversationId) return;
        setState((current) => (current ? { ...current, ...event } : current));
      }),
      // A restarted brain may have answered changes this window missed.
      peer.on("brain.status", (event) => {
        if (event.state === "ready") void load();
      }),
      peer.on("changes.changed", (event) => {
        if (event.reason === "folder" && event.topicId === conversationId) void load();
      }),
      peer.on("devices.changed", () => void load()),
    ];
    void load();
    return () => {
      request?.abort();
      for (const off of offs) off();
    };
  }, [peer, conversationId]);
  const set = useCallback(
    async (enabled: boolean, signal: AbortSignal, acknowledged = false) => {
      if (!peer || !conversationId) return undefined;
      const value =
        enabled && acknowledged
          ? await peer.call(
              "conversations.yolo.enableOnWindows",
              { conversationId, acknowledged: true },
              { signal },
            )
          : await peer.call("conversations.yolo.set", { conversationId, enabled }, { signal });
      if (!signal.aborted)
        setState((current) => (current?.conversationId === conversationId ? value : current));
      return value;
    },
    [peer, conversationId],
  );
  return { state: state?.conversationId === conversationId ? state : null, set };
}
