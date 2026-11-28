import { forwardCard } from "@pibot/client-core";
import type { MessageTransferReceipt, MethodParams, MethodResults } from "@pibot/protocol";
import { useNavigation, useRpc, useSettings, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button, CloseButton, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import type { SelectedMessage } from "./MessageActionsContext.tsx";
import { HandoffPreview, TransferRecipients } from "./MessageTransferParts.tsx";
import styles from "./message-actions.module.css";

export function MessageTransferDialog({
  items,
  createGroup,
  close,
  done,
}: {
  items: SelectedMessage[];
  createGroup: boolean;
  close(): void;
  done(): void;
}) {
  const { peer } = useRpc(),
    data = useWorkspace(),
    { navigate } = useNavigation(),
    t = useT(),
    { language } = useSettings();
  const dialog = useRef<HTMLDialogElement>(null),
    lifetime = useRef<AbortController | undefined>(undefined);
  const [selection, setSelection] = useState<MethodResults["messages.selection"]>();
  // Which selection failure to show: an over-long selection says so instead of "could not read".
  const [selectionFailure, setSelectionFailure] = useState<
    "messages.selectionFailed" | "messages.selectionTooLarge"
  >("messages.selectionFailed");
  const [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const [target, setTarget] = useState(""),
    [picked, setPicked] = useState<string[]>([]),
    [name, setName] = useState("");
  const [coordinator, setCoordinator] = useState(""),
    [note, setNote] = useState("");
  const [summary, setSummary] = useState<MethodResults["messages.handoff"]>(),
    [summarizing, setSummarizing] = useState(false);
  const [receipt, setReceipt] = useState<MessageTransferReceipt>();
  const requestId = useRef(crypto.randomUUID());
  const [source] = useState(() => ({
    conversationId: items[0]?.message.conversationId ?? "",
    messageIds: items.map(({ message }) => message.id),
  }));
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const element = dialog.current;
    element?.showModal();
    if (peer)
      void peer
        .call("messages.selection", source, { signal: controller.signal, timeoutMs: 10000 })
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            setSelection(result);
            setPicked(result.defaultBotIds);
          },
          (failure: unknown) => {
            if (controller.signal.aborted) return;
            setSelectionFailure(
              failure instanceof Error && failure.message === "message_selection_too_large"
                ? "messages.selectionTooLarge"
                : "messages.selectionFailed",
            );
            setError(true);
          },
        );
    return () => {
      controller.abort();
      element?.close();
    };
  }, [peer, source]);
  const bots = data.bots.filter((b) => !b.archivedAt),
    groups = data.groups;
  const members = bots.filter((b) => picked.includes(b.id)),
    coordinators = members.filter((b) => b.category !== "image" && b.kind !== "agent");
  const coordinatorId = coordinators.some((b) => b.id === coordinator)
    ? coordinator
    : (coordinators[0]?.id ?? "");
  const openDestination = (value: MessageTransferReceipt) => {
    if (value.groupId)
      navigate({ name: "chat", groupId: value.groupId, topicId: value.conversationId });
    else if (value.botId)
      navigate({ name: "chat", botId: value.botId, topicId: value.conversationId });
    done();
  };
  const acceptReceipt = (value: MessageTransferReceipt) => {
    setReceipt(value);
    if (value.state === "done") openDestination(value);
  };
  const status = async () => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted) return;
    setBusy(true);
    try {
      const value = await peer.call(
        "messages.transferStatus",
        { requestId: requestId.current },
        { signal, timeoutMs: 10000 },
      );
      if (!signal.aborted) {
        if (value) acceptReceipt(value);
        else setError(true);
      }
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const submit = async () => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || !selection || busy || receipt) return;
    let destination: MethodParams["messages.transfer"]["destination"];
    if (createGroup)
      destination = {
        kind: "newGroup",
        name:
          name.trim() ||
          members
            .map((b) => b.name)
            .join("、")
            .slice(0, 200),
        botIds: picked,
        coordinatorBotId: coordinatorId,
      };
    else if (target.startsWith("bot:")) destination = { kind: "bot", botId: target.slice(4) };
    else {
      const group = groups.find((g) => `group:${g.id}` === target);
      if (!group) return;
      destination = { kind: "group", groupId: group.id, topicId: group.conversationId };
    }
    setBusy(true);
    setError(false);
    try {
      const value = await peer.call(
        "messages.transfer",
        {
          ...source,
          requestId: requestId.current,
          selectionHash: selection.hash,
          destination,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(summary ? { handoffSummary: summary.text } : {}),
        },
        { signal, timeoutMs: 95000 },
      );
      if (!signal.aborted) acceptReceipt(value);
    } catch {
      // The write may have committed. Retain its ID and query the receipt; never resend on timeout.
      if (!signal.aborted) {
        setReceipt({ requestId: requestId.current, state: "uncertain" });
        setError(true);
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  const handoff = async () => {
    const signal = lifetime.current?.signal;
    if (!peer || !signal || signal.aborted || summarizing) return;
    setSummarizing(true);
    setError(false);
    try {
      const result = await peer.call(
        "messages.handoff",
        { ...source, language },
        { signal, timeoutMs: 95000 },
      );
      if (!signal.aborted) setSummary(result);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setSummarizing(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="message-transfer-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy && !summarizing) close();
      }}
    >
      <header>
        <h2 id="message-transfer-title">
          <IconTile
            icon={createGroup ? "users" : "send"}
            tone={createGroup ? "teal" : "pink"}
            size="lg"
          />
          {t(createGroup ? "messages.createGroup" : "messages.forward")}
        </h2>
        <CloseButton label={t("messages.close")} disabled={busy || summarizing} onClick={close} />
      </header>
      <div className={styles.dialogBody}>
        {!selection ? (
          <p
            role={error ? "alert" : "status"}
            className={error ? styles.banner : undefined}
            data-tone={error ? "danger" : undefined}
          >
            {t(error ? selectionFailure : "common.loading")}
          </p>
        ) : (
          <>
            <details className={styles.preview} open>
              <summary>{t("messages.preview", { count: selection.count })}</summary>
              <pre>
                {selection.previewForward
                  ? (() => {
                      const card = forwardCard(selection.previewForward, t, (iso) =>
                        new Date(iso).toLocaleString(language === "zh" ? "zh-CN" : "en"),
                      );
                      return [
                        card.title,
                        ...card.items.map((item) =>
                          [`${item.sender} · ${item.time}`, item.quote, item.body]
                            .filter(Boolean)
                            .join("\n"),
                        ),
                        card.truncatedNote,
                      ]
                        .filter(Boolean)
                        .join("\n\n")
                        .slice(0, 4000);
                    })()
                  : selection.preview}
              </pre>
              {selection.attachmentCount > 0 && (
                <p>{t("messages.attachments", { count: selection.attachmentCount })}</p>
              )}
            </details>
            <TransferRecipients
              data={data}
              createGroup={createGroup}
              busy={busy || !!receipt}
              query={query}
              setQuery={setQuery}
              picked={picked}
              setPicked={setPicked}
              target={target}
              setTarget={setTarget}
            />
            {createGroup && (
              <>
                <p className={styles.hint}>{t("messages.groupMembers")}</p>
                <label>
                  {t("messages.groupName")}
                  <input
                    className={styles.input}
                    value={name}
                    maxLength={200}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy || !!receipt}
                  />
                </label>
                <label>
                  {t("messages.coordinator")}
                  <select
                    className={styles.input}
                    value={coordinatorId}
                    onChange={(e) => setCoordinator(e.target.value)}
                    disabled={busy || !!receipt}
                  >
                    {coordinators.map((b) => (
                      <option value={b.id} key={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              {t("messages.note")}
              <textarea
                className={styles.input}
                value={note}
                maxLength={4000}
                rows={3}
                disabled={busy || !!receipt}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <HandoffPreview
              summary={summary}
              busy={busy || !!receipt}
              summarizing={summarizing}
              generate={() => void handoff()}
              remove={() => setSummary(undefined)}
            />
          </>
        )}
        {error && selection && (
          <p className={`${styles.error} ${styles.banner}`} data-tone="danger" role="alert">
            {t("messages.operationFailed")}
          </p>
        )}
        {receipt && (
          <p
            role="status"
            className={styles.banner}
            data-tone={
              receipt.state === "pending" ? "info" : receipt.state === "failed" ? "danger" : "warn"
            }
          >
            {t(
              receipt.state === "pending"
                ? "messages.pending"
                : receipt.state === "failed"
                  ? "messages.transferFailed"
                  : "messages.uncertain",
            )}
          </p>
        )}
      </div>
      <footer>
        <Button variant="ghost" disabled={busy || summarizing} onClick={close}>
          {t("common.cancel")}
        </Button>
        {receipt ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void status()}>
              {t("messages.checkStatus")}
            </Button>
            {(receipt.botId || receipt.groupId) && (
              <Button onClick={() => openDestination(receipt)}>
                {t("messages.openDestination")}
              </Button>
            )}
          </>
        ) : (
          <Button
            disabled={
              !selection ||
              busy ||
              summarizing ||
              (createGroup ? picked.length < 2 || !coordinatorId : !target)
            }
            onClick={() => void submit()}
          >
            {t(
              busy ? "messages.sending" : createGroup ? "messages.createAndSend" : "messages.send",
            )}
          </Button>
        )}
      </footer>
    </dialog>
  );
}
