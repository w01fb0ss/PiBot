import type { Message } from "@pibot/protocol";
import { Sheet } from "../../../ui/sheet.tsx";
import type { StripSheet } from "../ControlStrip.tsx";
import type { ChatPage } from "../use-chat-page.ts";
import {
  ChangesSheet,
  FolderSheet,
  PlanSheet,
  RestoreSheet,
  YoloSheet,
} from "./control-sheets.tsx";
import { GroupPlanSheet } from "./GroupPlanSheet.tsx";
import {
  type MenuSheet,
  ModeSheet,
  MoreSheet,
  PlusSheet,
  RunInfoSheet,
  TopicsSheet,
} from "./menu-sheets.tsx";
import { MessageSheet, RetrySheet } from "./message-sheets.tsx";

export type SheetState =
  | { kind: StripSheet | MenuSheet | "retry" }
  | { kind: "restore"; path: string; name: string }
  | { kind: "message"; message: Message };
/** The chat page's single bottom sheet; one is open at a time, and a sheet may hand over to another. */
export function ChatSheets({
  page,
  sheet,
  setSheet,
  onBrowser,
  onApproval,
}: {
  page: ChatPage;
  sheet: SheetState | undefined;
  setSheet: (sheet: SheetState | undefined) => void;
  onBrowser: () => void;
  onApproval: (id: string) => void;
}) {
  const close = () => {
    if (sheet?.kind === "retry") page.retry.dismiss();
    setSheet(undefined);
  };
  const open = (kind: StripSheet | MenuSheet) => setSheet({ kind });
  const retry = async (source: Message) => {
    if ((await page.retry.prepare(source.id)) !== undefined) setSheet({ kind: "retry" });
  };
  const body = () => {
    switch (sheet?.kind) {
      case "folder":
        return <FolderSheet page={page} onClose={close} />;
      case "plan":
        return <PlanSheet page={page} onClose={close} />;
      case "tasks":
        return <GroupPlanSheet page={page} onClose={close} onApproval={onApproval} />;
      case "changes":
        return (
          <ChangesSheet
            page={page}
            onClose={close}
            onRestore={(path, name) => setSheet({ kind: "restore", path, name })}
          />
        );
      case "restore":
        return <RestoreSheet page={page} path={sheet.path} name={sheet.name} onClose={close} />;
      case "yolo":
        return <YoloSheet page={page} onClose={close} />;
      case "topics":
        return <TopicsSheet page={page} onClose={close} />;
      case "mode":
        return <ModeSheet page={page} onClose={close} />;
      case "plus":
        return <PlusSheet page={page} open={open} onClose={close} />;
      case "more":
        return (
          <MoreSheet
            page={page}
            open={open}
            onClose={close}
            onBrowser={() => {
              close();
              onBrowser();
            }}
          />
        );
      case "runinfo":
        return <RunInfoSheet page={page} onClose={close} />;
      case "message":
        return (
          <MessageSheet
            page={page}
            message={sheet.message}
            onRetry={(source) => void retry(source)}
            onClose={close}
          />
        );
      case "retry":
        return <RetrySheet page={page} onClose={close} />;
      default:
        return null;
    }
  };
  return (
    <Sheet visible={!!sheet} onClose={close}>
      {body()}
    </Sheet>
  );
}
