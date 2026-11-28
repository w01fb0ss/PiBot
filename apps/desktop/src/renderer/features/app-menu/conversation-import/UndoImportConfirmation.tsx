import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "./conversation-import.module.css";
import type { Status } from "./import-state.ts";

export function UndoImportConfirmation({
  status,
  disabled,
  cancel,
  confirm,
}: {
  status: Status;
  disabled: boolean;
  cancel(): void;
  confirm(): void;
}) {
  const t = useT();
  return (
    <>
      <p className={styles.intro}>
        {t("conversationImport.undoConfirm.intro", {
          source: t(`conversationImport.source.${status.source}`),
        })}
      </p>
      <ul className={styles.undoItems}>
        {(!!status.topics || !!status.messages) && (
          <li>
            {t("conversationImport.undoConfirm.chats", {
              messages: status.messages,
            })}
          </li>
        )}
        {!!status.topics && <li>{t("conversationImport.undoConfirm.continued")}</li>}
        {!!status.memories && (
          <li>{t("conversationImport.undoConfirm.memories", { count: status.memories })}</li>
        )}
        {!!status.projectFiles && (
          <li>{t("conversationImport.undoConfirm.notes", { count: status.projectFiles })}</li>
        )}
        {!!status.folders && (
          <li>{t("conversationImport.undoConfirm.folders", { count: status.folders })}</li>
        )}
        {status.persona && <li>{t("conversationImport.undoConfirm.role")}</li>}
      </ul>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button disabled={disabled} onClick={confirm}>
          {t("conversationImport.undo")}
        </Button>
      </div>
    </>
  );
}
