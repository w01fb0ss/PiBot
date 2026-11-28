import type { Bot, Group, MethodResults } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { groupDraftKey, useDraftFill } from "../../chat/composer/composer-drafts.tsx";
import { GroupPlanCard } from "./GroupPlanCard.tsx";

/** The task panel reads the same durable card as chat, rather than the coordinator's separate TODO. */
export function CurrentGroupPlan({
  group,
  bots,
  onCurrent,
}: {
  group: Group;
  bots: Bot[];
  onCurrent?(messageId: string | undefined): void;
}) {
  const { peer } = useRpc(),
    t = useT();
  const [entry, setEntry] = useState<MethodResults["groups.plan.current"]>();
  const fill = useDraftFill();
  const [error, setError] = useState(false),
    [revision, refresh] = useState(0);
  useEffect(() => {
    if (!peer) return;
    const off = peer.on("groups.changed", (event) => {
      if (event.groupId === group.id) refresh((n) => n + 1);
    });
    return off;
  }, [peer, group.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 群周期变化和刷新计数用于主动重取持久计划。
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void peer
      .call(
        "groups.plan.current",
        { groupId: group.id },
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then(
        (next) => {
          if (!controller.signal.aborted) {
            setEntry(next);
            onCurrent?.(next?.messageId);
            setError(false);
          }
        },
        () => {
          if (!controller.signal.aborted) setError(true);
        },
      );
    return () => controller.abort();
  }, [peer, group.id, group.conversationId, revision]);
  return (
    <section>
      {error && (
        <p role="alert">
          {t("group.plan.progressFailed")}{" "}
          <Button variant="ghost" onClick={() => refresh((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {entry && entry.card.groupId === group.id && (
        <GroupPlanCard
          key={entry.messageId}
          message={{ id: entry.messageId, usage: { groupPlan: entry.card } }}
          bots={bots}
          // The group's input sits beside this panel; 「新开计划」 leaves the old goal there.
          fillComposer={(text) =>
            peer && fill(peer, groupDraftKey(group.id, group.conversationId), text)
          }
        />
      )}
    </section>
  );
}
