import { imageRunErrorText } from "@pibot/i18n";
import {
  type ImageGenerationResults,
  imageGenerationResultCounts,
  type Message,
} from "@pibot/protocol";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { CSSProperties } from "react";
import { ImagePreview } from "./MessageAttachments.tsx";
import styles from "./message-image-results.module.css";

const MODEL_FAILURE_CODES = new Set([
  "auth_failed",
  "billing",
  "quota_exhausted",
  "no_model",
  "model_unavailable",
  "provider_rejected",
  "image_unsupported",
  "image_mode_mismatch",
  "claude_subscription_unsupported",
  "subscription_unsupported",
]);

export function MessageImageResults({
  message,
  results,
}: {
  message: Message;
  results: ImageGenerationResults;
}) {
  const t = useT();
  const navigation = useNavigation();
  const attachments = new Map(message.attachments?.map((item) => [item.id, item]));
  const openLogs = () => {
    const botId = message.botId ?? undefined;
    if (typeof navigation.openAudit === "function") navigation.openAudit(botId);
    else navigation.navigate({ name: "audit", ...(botId ? { auditBotId: botId } : {}) });
  };
  return (
    <section className={styles.card} aria-label={t(`media.${results.kind}.title`)}>
      <header>
        <strong>{t(`media.${results.kind}.title`)}</strong>
        <span>{t("media.multi.summary", imageGenerationResultCounts(results))}</span>
      </header>
      <ol
        className={styles.results}
        data-kind={results.kind}
        style={{ "--model-count": results.items.length } as CSSProperties}
      >
        {results.items.map((item, index) => (
          <li
            className={styles.result}
            key={item.status === "success" ? item.attachmentId : `failure-${index}`}
          >
            <span className={styles.label}>
              {results.kind === "compare"
                ? item.model
                : t("media.multi.item", { index: index + 1 })}
            </span>
            {item.status === "failed" ? (
              <div className={styles.failureBox}>
                <span className={styles.failure}>
                  {t("media.multi.failure", {
                    code: imageRunErrorText(item.reasonCode, t),
                  })}
                </span>
                <Button
                  variant="ghost"
                  className={styles.failureAction}
                  onClick={() => {
                    if (MODEL_FAILURE_CODES.has(item.reasonCode)) navigation.openSettings("models");
                    else openLogs();
                  }}
                >
                  {t(
                    MODEL_FAILURE_CODES.has(item.reasonCode)
                      ? "media.multi.actionModels"
                      : "media.multi.actionLogs",
                  )}
                </Button>
              </div>
            ) : (
              <div>
                {[item.attachmentId, ...(item.additionalAttachmentIds ?? [])].map((id) => {
                  const attachment = attachments.get(id);
                  return attachment ? (
                    <div key={id} data-file-attachment-id={id}>
                      <ImagePreview
                        attachment={attachment}
                        messageId={message.id}
                        className={styles.image}
                      />
                    </div>
                  ) : (
                    <span key={id} className={styles.failure}>
                      {t("attachments.imageFailed")}
                    </span>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
