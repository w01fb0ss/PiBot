import { approvalDeadline } from "@pibot/client-core";
import { type Approval, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { confirmLocally } from "../../runtime/local-auth.ts";
import { useAction } from "../../runtime/use-action.ts";
import { STORED_APPROVALS, StoredApprovalsSchema, storeKeys } from "../../storage/phone-store.ts";

/** No answer came back because the link went away, not because the computer refused. */
function lostWithLink(error: unknown) {
  if (error instanceof RpcError)
    return error.code === RpcErrorCodes.closed || error.code === RpcErrorCodes.timeout;
  return (
    (error instanceof Error && (error.message === "offline" || error.name === "AbortError")) ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}
export function desktopOnly(approval: Approval) {
  return !!(approval.computer || approval.login || approval.draft);
}
export function canRemember(approval: Approval) {
  return approval.canRemember && !approval.rememberOnly && !approval.secretUses?.length;
}
export interface ApprovalDecisionOptions {
  allowConversation?: boolean;
  remember?: boolean;
  rememberDirectRun?: boolean;
}

/** State behind ApprovalsProvider: one pending list shared by the tab badge, list, detail and chat. */
export function useApprovalsState() {
  const runtime = useRuntime(),
    mobile = useLinkState(),
    t = useText();
  const store = runtime.storage.store;
  const copy = (id: string | undefined) =>
    id ? (store.peek(storeKeys.approvals(id), StoredApprovalsSchema) ?? []) : [];
  // Proposal 4/10: the last pending list opens at once (read-only until the computer answers).
  const [items, setItems] = useState<Approval[]>(() => copy(mobile.selectedId)),
    [hasMore, setHasMore] = useState(false),
    [total, setTotal] = useState<number>();
  const [remember, setRemember] = useState<Record<string, boolean>>({});
  const [unsent, setUnsent] = useState<{
    approval: Approval;
    decision: "allow" | "deny";
    options: ApprovalDecisionOptions;
  }>();
  const action = useAction(mobile.selectedId, mobile.peer);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const shownFor = useRef(mobile.selectedId);
  const show = (next: Approval[]) => {
    itemsRef.current = next;
    setItems(next);
    const id = mobile.selectedId;
    // Only the first page is kept: it is what the tab, the badge and the chat cards show.
    if (id)
      void store
        .write(
          storeKeys.approvals(id),
          StoredApprovalsSchema.parse(next.slice(0, STORED_APPROVALS)),
        )
        .catch(() => {
          /* A copy for the next start only; the list on screen is current. */
        });
  };
  const load = (more = false) =>
    action.read(async (signal) => {
      const id = mobile.selectedId;
      if (!id) return;
      if (mobile.status !== "online") {
        const stored = await store.read(storeKeys.approvals(id), StoredApprovalsSchema);
        signal.throwIfAborted();
        if (stored) {
          itemsRef.current = stored;
          setItems(stored);
        }
        return;
      }
      const [page, counts] = await Promise.all([
        runtime.call(
          "approvals.pending",
          { before: more ? itemsRef.current.at(-1)?.id : undefined, limit: 50 },
          signal,
        ),
        more
          ? undefined
          : runtime.call("inbox.counts", undefined, signal).catch((error: unknown) => {
              // Earlier peers can still supply cards even if they do not expose an inbox total.
              if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
                return undefined;
              throw error;
            }),
      ]);
      signal.throwIfAborted();
      show(more ? [...itemsRef.current, ...page].slice(-500) : page);
      setHasMore(page.length === 50);
      if (counts) setTotal(counts.approval + (counts.routine_approval ?? 0));
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: effects own the canonical device/peer/route, not transient request state.
  useEffect(() => {
    // A reconnect keeps the cards on screen; only another computer starts from its own copy.
    if (shownFor.current !== mobile.selectedId) {
      shownFor.current = mobile.selectedId;
      itemsRef.current = copy(mobile.selectedId);
      setItems(itemsRef.current);
      setTotal(undefined);
      setHasMore(false);
      setRemember({});
      setUnsent(undefined);
    }
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    const off = [
      // A new card is read from the list (the computer decides what a phone may see and in which
      // order); a settled one is simply gone, so it is removed in place without a re-read.
      mobile.peer?.on("approval.requested", refresh),
      mobile.peer?.on("approval.resolved", (event) => {
        if (itemsRef.current.some((item) => item.id === event.id))
          show(itemsRef.current.filter((item) => item.id !== event.id));
        refresh();
      }),
      mobile.peer?.on("inbox.changed", refresh),
    ];
    return () => {
      clearTimeout(timer);
      for (const fn of off) fn?.();
    };
  }, [mobile.selectedId, mobile.peer, mobile.refreshVersion]);
  async function currentApproval(original: Approval, signal: AbortSignal) {
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await runtime.call(
        "approvals.pending",
        { botId: original.botId, before, limit: 100 },
        signal,
      );
      const found = rows.find((a) => a.id === original.id);
      if (found) {
        if (
          JSON.stringify(found) !== JSON.stringify(original) ||
          approvalDeadline(found, Date.now()).expired ||
          desktopOnly(found)
        )
          throw new Error("approval_changed");
        return found;
      }
      if (rows.length < 100) break;
      before = rows.at(-1)?.id;
    }
    throw new Error("approval_changed");
  }
  const resolve = (
    approval: Approval,
    decision: "allow" | "deny",
    options?: ApprovalDecisionOptions,
  ) =>
    action.run(async (signal) => {
      const allowConversation = options?.allowConversation;
      const rememberDirectRun = options?.rememberDirectRun;
      const rememberChoice = options?.remember ?? !!remember[approval.id];
      // The re-read guards an allow against a card that changed on the computer. A deny is safe
      // on any version of it, and right after a reconnect that read queued behind every screen's
      // reload (v0.0.2: 14 s from the tap to the computer).
      if (desktopOnly(approval)) throw new Error("approval_changed");
      if (decision === "allow") await currentApproval(approval, signal);
      if (decision === "allow" && approval.risk === "danger") {
        await confirmLocally(t("unlockApproval"), t("cancel"), signal);
        // A native unlock may take long enough for a desktop action to replace the card.
        await currentApproval(approval, signal);
      }
      // A resumed run accepts a one-time decision. A stale Remember switch must never grant
      // authority to future calls after the original run has stopped.
      const { paused, expired } = approvalDeadline(approval, Date.now());
      if (
        expired ||
        (paused && allowConversation) ||
        (rememberDirectRun && (paused || !approval.directRunRemember || decision !== "allow"))
      )
        throw new Error("approval_changed");
      setUnsent((current) => (current?.approval.id === approval.id ? undefined : current));
      let result: { superseded?: true };
      try {
        result = await runtime.call(
          "approvals.resolve",
          {
            id: approval.id,
            decision,
            remember:
              !paused &&
              !allowConversation &&
              decision === "allow" &&
              canRemember(approval) &&
              rememberChoice,
            ...(rememberDirectRun ? { rememberDirectRun: true } : {}),
            ...(allowConversation
              ? approval.taskWebRead
                ? { allowTaskWeb: true }
                : { allowConversation: true }
              : {}),
            ...(approval.conversationId ? { conversationId: approval.conversationId } : {}),
          },
          signal,
          30_000,
        );
      } catch (error) {
        // Proposal 5: an answer lost with the link is never queued (the card may change on the
        // computer meanwhile); the card says it was not sent and offers the same answer again.
        if (lostWithLink(error))
          setUnsent({
            approval,
            decision,
            options: { allowConversation, remember: rememberChoice, rememberDirectRun },
          });
        throw error;
      }
      signal.throwIfAborted();
      show(itemsRef.current.filter((a) => a.id !== approval.id));
      // The computer closed a paused card whose conversation moved on; nothing ran.
      return result.superseded ? ("superseded" as const) : decision;
    });
  return {
    items,
    total: total ?? items.length,
    hasMore,
    load,
    resolve,
    action,
    remember,
    setRemember,
    /** The answer the link lost, shown on its card with a retry. */
    unsent,
    retryUnsent: () =>
      unsent ? resolve(unsent.approval, unsent.decision, unsent.options) : undefined,
  };
}
