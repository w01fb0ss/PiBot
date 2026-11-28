import {
  IdSchema,
  ImageDeliverySchema,
  imageGenerationResults,
  type Message,
} from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Card } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../chat.module.css";

export function MessageImageDelivery({
  message,
  actor,
  busy,
}: {
  message: Message;
  actor: { botId: string; conversationId: string; groupId?: string };
  busy: boolean;
}) {
  const t = useT(),
    { peer } = useRpc();
  const [pending, setPending] = useState(false),
    [error, setError] = useState(false),
    [unconfirmed, setUnconfirmed] = useState(false);
  const identity = JSON.stringify([actor, message.id]);
  const generation = useRef(0),
    pendingRun = useRef<string | undefined>(undefined),
    events = useRef(new Set<string>()),
    inFlight = useRef(false),
    checkStatus = useRef<(runId: string) => void>(() => {});
  useEffect(() => {
    const [scope] = JSON.parse(identity) as [typeof actor, string];
    const current = ++generation.current;
    inFlight.current = false;
    pendingRun.current = undefined;
    events.current.clear();
    setPending(false);
    setError(false);
    setUnconfirmed(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    const stopCheck = () => {
      ++revision;
      clearTimeout(timer);
    };
    const finish = (event: { runId: string; botId?: string; conversationId?: string }) => {
      if (event.botId !== scope.botId || event.conversationId !== scope.conversationId) return;
      if (generation.current !== current) return;
      events.current.add(event.runId);
      if (events.current.size > 32)
        events.current.delete(events.current.values().next().value as string);
      if (event.runId === pendingRun.current) {
        stopCheck();
        inFlight.current = false;
        setPending(false);
        setUnconfirmed(false);
      }
    };
    checkStatus.current = (runId) => {
      stopCheck();
      const check = revision;
      let remaining = 10;
      setUnconfirmed(false);
      const active = () => generation.current === current && revision === check && inFlight.current;
      const read = async () => {
        if (!peer || !active()) return;
        try {
          const runs = await peer.call(
            "chat.runs",
            scope.groupId
              ? { groupId: scope.groupId, limit: 200 }
              : { botId: scope.botId, limit: 200 },
            { timeoutMs: 5000 },
          );
          if (!active()) return;
          const run = runs.find((item) => item.id === runId);
          if (
            run?.botId === scope.botId &&
            run.conversationId === scope.conversationId &&
            run.groupId === (scope.groupId ?? null) &&
            ["done", "error", "aborted"].includes(run.status)
          ) {
            finish({ ...scope, runId });
            return;
          }
        } catch {
          // A missing/read-failed status is unknown; never treat it as a finished operation.
        }
        if (!active()) return;
        if (--remaining === 0) setUnconfirmed(true);
        else timer = setTimeout(() => void read(), 2000);
      };
      timer = setTimeout(() => void read(), 2000);
    };
    const offDone = peer?.on("chat.done", finish),
      offError = peer?.on("chat.error", finish);
    return () => {
      stopCheck();
      ++generation.current;
      offDone?.();
      offError?.();
      checkStatus.current = () => {};
    };
  }, [peer, identity]);
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  if (
    imageGenerationResults(usage) &&
    !message.attachments?.some((attachment) => attachment.kind === "image")
  )
    return null;
  const parsed = ImageDeliverySchema.safeParse(usage.imageDelivery);
  if (
    !parsed.success &&
    usage.imageGeneration !== true &&
    typeof usage.imageSourceRunId !== "string"
  )
    return null;
  const sourceRunId =
    typeof usage.imageArtifactSourceRunId === "string"
      ? usage.imageArtifactSourceRunId
      : typeof usage.imageSourceRunId === "string"
        ? usage.imageSourceRunId
        : message.runId;
  if (!sourceRunId) return null;
  const reuse = async (action: "save" | "resend") => {
    if (!peer || inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setPending(true);
    setError(false);
    try {
      const receipt = await peer.call("images.reuse", {
        botId: actor.botId,
        conversationId: actor.conversationId,
        sourceRunId,
        action,
      });
      if (generation.current !== current) return;
      pendingRun.current = receipt.runId;
      if (events.current.has(receipt.runId)) {
        inFlight.current = false;
        setPending(false);
      } else checkStatus.current(receipt.runId);
    } catch {
      if (generation.current === current) {
        inFlight.current = false;
        setPending(false);
        setError(true);
      }
    }
  };
  const settled = message.status !== "streaming";
  if (
    parsed.success &&
    parsed.data.workspace.every((item) => item.status === "saved") &&
    !pending &&
    !error &&
    !unconfirmed
  )
    return null;
  return (
    <Card className={styles.imageDelivery}>
      <p>{t("media.attachmentRetained")}</p>
      {parsed.success ? (
        parsed.data.workspace.map((item) => (
          <p key={item.attachmentId}>
            <span>{t(`media.delivery.${item.status}`)}</span>{" "}
            <span className={styles.imagePath}>
              {item.savedPath ?? item.targetPath ?? item.fileName}
            </span>
            {item.errorCode && <span> — {t(`media.deliveryError.${item.errorCode}`)}</span>}
          </p>
        ))
      ) : (
        <p>{t("media.deliveryUnknown")}</p>
      )}
      <div className={styles.actions}>
        {((parsed.success && parsed.data.workspace.some((item) => item.status !== "saved")) ||
          (!parsed.success && IdSchema.safeParse(usage.imageArtifactSourceRunId).success)) && (
          <Button
            variant="secondary"
            disabled={!peer || busy || pending || !settled}
            onClick={() => void reuse("save")}
          >
            {t("media.retrySaveOnly")}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={!peer || busy || pending || !settled}
          onClick={() => void reuse("resend")}
        >
          {t("media.resendExisting")}
        </Button>
      </div>
      <p className={styles.notice} role="status">
        {unconfirmed
          ? t("media.reuseUnconfirmed")
          : pending
            ? t("media.reusePending")
            : t("media.noRegeneration")}
      </p>
      {unconfirmed && (
        <Button
          variant="ghost"
          disabled={!peer}
          onClick={() => pendingRun.current && checkStatus.current(pendingRun.current)}
        >
          {t("media.recheckReuse")}
        </Button>
      )}
      {error && <p role="alert">{t("media.reuseFailed")}</p>}
    </Card>
  );
}
