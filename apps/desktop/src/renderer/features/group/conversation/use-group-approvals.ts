import { type ChatPeer, readGroupApprovals } from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { optional } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export function useGroupApprovals(
  peer: ChatPeer,
  groupId: string,
  topicId: string | undefined,
  since: string | undefined,
) {
  const [snapshot, setSnapshot] = useState<{
    peer: ChatPeer;
    topicId: string;
    approvals?: Approval[];
    error?: boolean;
  }>();
  const reload = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => reload.current(), []);
  useEffect(() => {
    if (!topicId) return;
    const lifetime = new AbortController();
    let revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const requested = ++revision;
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
      try {
        const approvals = await optional(
          readGroupApprovals(
            (params, signal) => peer.call("approvals.groupTimeline", params, { signal }),
            { groupId, topicId, since },
            signal,
          ),
        );
        if (!lifetime.signal.aborted && requested === revision)
          setSnapshot({ peer, topicId, approvals });
      } catch {
        if (!lifetime.signal.aborted && requested === revision)
          setSnapshot((old) => ({
            peer,
            topicId,
            approvals: peer === old?.peer && topicId === old.topicId ? old.approvals : undefined,
            error: true,
          }));
      }
    };
    const changed = () => {
      revision++;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 100);
    };
    const off = [peer.on("approval.requested", changed), peer.on("approval.resolved", changed)];
    reload.current = load;
    void load();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
      for (const unsubscribe of off) unsubscribe();
    };
  }, [peer, groupId, topicId, since]);
  const current = peer === snapshot?.peer && topicId === snapshot.topicId ? snapshot : undefined;
  return { approvals: current?.approvals, error: current?.error, refresh };
}
