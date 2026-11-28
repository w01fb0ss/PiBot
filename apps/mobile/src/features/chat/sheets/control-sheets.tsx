import { isolationReasonText, yoloScopeUnavailable } from "@pibot/client-core";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { monoFont, onFill, useColors } from "../../../theme/use-theme.ts";
import { Button, ErrorLine, ListCard, Separator } from "../../../ui/controls.tsx";
import { OfflineBanner } from "../../../ui/headers.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { OptionRow, Radio, SheetIcon, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import { diffHref } from "../../changes/calls.ts";
import { FileTag, LineCounts } from "../../changes/FileTag.tsx";
import { changesTarget } from "../controls/scope.ts";
import { useYolo } from "../controls/use-yolo.ts";
import type { ChatPage } from "../use-chat-page.ts";
import { RunnerFolderSheet } from "./RunnerFolderSheet.tsx";

export function OfflineNote({ page }: { page: ChatPage }) {
  const t = useText();
  return page.online ? null : <OfflineBanner text={t("actionsOffline")} />;
}
export function CloseButton({ onClose }: { onClose: () => void }) {
  const t = useText();
  return <Button size="lg" title={t("close")} onPress={onClose} />;
}
export function FolderSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    shared = useSharedText(),
    toast = useToast();
  const value = page.workplace.value;
  const choose = async (folderId: string) => {
    if ((await page.workplace.choose(folderId)) === undefined) return;
    onClose();
    toast(t("folderChanged"));
  };
  return (
    <>
      <SheetTitle text={t("folderTitle")} />
      {!page.workplace.enabled ? (
        <SheetText text={t("folderGroup")} />
      ) : (
        <>
          <SheetText text={t("folderHint")} />
          {/* Why runs here fail, and that picking a folder on this computer fixes it (B7). */}
          {value?.runnerOffline && <SheetText text={shared("errors.runner_offline")} />}
          <OfflineNote page={page} />
          {value && (
            <ListCard flush>
              <OptionRow
                title={t("folderHome")}
                subtitle={`${value.home} · ${t("folderDefault")}`}
                selected={value.folderId === "home"}
                disabled={!page.online || page.workplace.write.busy}
                right={<Radio on={value.folderId === "home"} />}
                onPress={() => void choose("home")}
              />
              {value.folders.map((folder) => (
                <View key={folder.id}>
                  <Separator />
                  <OptionRow
                    title={folder.name}
                    subtitle={`${folder.path} · ${t(value.readonly.includes(folder.id) ? "folderReadonly" : "folderWritable")}`}
                    selected={value.folderId === folder.id}
                    disabled={!page.online || page.workplace.write.busy}
                    right={<Radio on={value.folderId === folder.id} />}
                    onPress={() => void choose(folder.id)}
                  />
                </View>
              ))}
            </ListCard>
          )}
          <RunnerFolderSheet page={page} done={onClose} />
        </>
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
/** Desktop plan card mark: green tick when done, a blue open ring for the step in progress. */
function PlanMark({ status }: { status: string }) {
  const colors = useColors();
  const done = status === "done";
  const running = status === "in_progress";
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: done ? colors.ok : running ? colors.accent : colors.b3,
        borderRightColor: running ? "transparent" : undefined,
        backgroundColor: done ? colors.ok : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {done && <Icon name="check" color={onFill(colors)} size={11} strokeWidth={3} />}
    </View>
  );
}
export function PlanSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    colors = useColors();
  return (
    <>
      <SheetTitle text={t("planTitle")} />
      <SheetText text={t("planHint", { name: page.entry?.name ?? "" })} />
      <ListCard flush style={{ paddingVertical: 4 }}>
        {page.plan.items.map((item) => {
          const done = item.status === "done";
          return (
            <View
              key={item.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                minHeight: 40,
                paddingVertical: 6,
                paddingHorizontal: 16,
              }}
            >
              <PlanMark status={item.status} />
              <Text
                style={{
                  flex: 1,
                  fontSize: 14.5,
                  lineHeight: 21,
                  color: done ? colors.text2 : colors.text,
                  textDecorationLine: done ? "line-through" : "none",
                  textDecorationColor: colors.b3,
                }}
              >
                {item.title}
              </Text>
            </View>
          );
        })}
      </ListCard>
      <CloseButton onClose={onClose} />
    </>
  );
}
export function ChangesSheet({
  page,
  onRestore,
  onClose,
}: {
  page: ChatPage;
  onRestore: (path: string, name: string) => void;
  onClose: () => void;
}) {
  const t = useText(),
    colors = useColors(),
    router = useRouter();
  const files = page.changes.files;
  const runId = page.changes.value?.runId;
  // Each row opens that file's line diff; restoring stays a separate button.
  const openDiff = (file: (typeof files)[number]) => {
    if (!runId || !page.scope) return;
    onClose();
    router.push(diffHref(runId, changesTarget(page.scope), file));
  };
  return (
    <>
      <SheetTitle text={t("changesTitle")} />
      {files.length ? (
        <>
          <SheetText text={t("changesHint")} />
          <OfflineNote page={page} />
          <ListCard flush>
            {files.map((file, index) => (
              <View key={file.path}>
                {index > 0 && <Separator />}
                <OptionRow
                  title={file.displayPath}
                  mono={monoFont}
                  lead={<FileTag kind={file.kind} />}
                  onPress={runId ? () => openDiff(file) : undefined}
                  subtitle={page.changes.restorable ? undefined : t("restoreUnavailable")}
                  right={
                    <>
                      <LineCounts added={file.added} removed={file.removed} />
                      <Button
                        variant="danger"
                        title={t("restore")}
                        disabled={
                          !page.online || !page.changes.restorable || page.changes.write.busy
                        }
                        onPress={() => onRestore(file.path, file.displayPath)}
                      />
                    </>
                  }
                />
              </View>
            ))}
          </ListCard>
          <Text style={{ fontSize: 13.5, color: colors.text2 }}>{t("changesDesktop")}</Text>
        </>
      ) : (
        <SheetText text={t("changesEmpty")} />
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
export function RestoreSheet({
  page,
  path,
  name,
  onClose,
}: {
  page: ChatPage;
  path: string;
  name: string;
  onClose: () => void;
}) {
  const t = useText(),
    toast = useToast();
  const confirm = async () => {
    const outcome = await page.changes.restore(path);
    if (outcome === undefined) return;
    onClose();
    toast(t(outcome === "done" ? "restored" : "restorePartial"));
  };
  return (
    <>
      <SheetIcon name="face" />
      <SheetTitle center text={t("restoreTitle", { name })} />
      <SheetText center text={t("restoreHint")} />
      <OfflineNote page={page} />
      <Button
        size="lg"
        variant="danger"
        title={t("restoreConfirm")}
        disabled={!page.online || page.changes.write.busy}
        onPress={() => void confirm()}
      />
      <Button size="lg" variant="ghost" title={t("cancel")} onPress={onClose} />
    </>
  );
}
export function YoloSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    shared = useSharedText(),
    colors = useColors(),
    toast = useToast();
  const [details, setDetails] = useState(false);
  // The disclosure needs its own fresh read when it opens, independent of the chat badge.
  const yolo = useYolo(page.scope, page.workplace.value?.folderId);
  const change = async (on: boolean) => {
    const result = await (on ? yolo.turnOn() : yolo.turnOff());
    if (result === undefined) return;
    onClose();
    toast(t(result ? "yoloEnabled" : "yoloDisabled"));
  };
  const readError = yolo.action.error;
  const scopeUnavailable = yolo.value && yoloScopeUnavailable(yolo.value);
  const disabled =
    !page.online || !!readError || yolo.action.busy || yolo.write.busy || !yolo.value;
  const status = (
    <>
      <OfflineNote page={page} />
      <ErrorLine text={yolo.write.error && t(yolo.write.error)} />
      {page.online && (readError || scopeUnavailable) && (
        <>
          <ErrorLine
            text={scopeUnavailable ? shared("yolo.scopeUnavailable") : t("yoloScopeFailed")}
          />
          <Button
            title={t("retry")}
            disabled={yolo.action.busy || yolo.write.busy}
            onPress={() => void yolo.load()}
          />
        </>
      )}
    </>
  );
  if (!yolo.value || (!yolo.enabled && (readError || scopeUnavailable)))
    return (
      <>
        <SheetTitle text={t("yoloAskTitle")} />
        {page.online && !readError && !scopeUnavailable && (
          <SheetText text={shared("common.loading")} />
        )}
        {status}
        <CloseButton onClose={onClose} />
      </>
    );
  const isolation = yolo.value.isolation;
  const windowsDirectRun = yolo.value.windowsDirectRun;
  const windows = !isolation.available && isolation.reason === "windows_unisolated";
  const commandNote =
    scopeUnavailable || readError
      ? undefined
      : windows
        ? windowsDirectRun === "consented"
          ? shared("yolo.windowsReminder")
          : windowsDirectRun === undefined
            ? shared("yolo.windowsConsentUnknown")
            : shared("yolo.windowsWithoutConsent")
        : !isolation.available
          ? t("yoloAskIsolation")
          : undefined;
  if (yolo.enabled)
    return (
      <>
        <SheetTitle text={t("yoloOnTitle")} />
        <SheetText text={t("yoloOnHint")} />
        {commandNote && <SheetText text={commandNote} />}
        {status}
        <Button
          size="lg"
          variant="prim"
          title={t("yoloTurnOff")}
          disabled={!page.online || yolo.write.busy}
          onPress={() => void change(false)}
        />
        <CloseButton onClose={onClose} />
      </>
    );
  const isolationDetail = !isolation.available && isolationReasonText(isolation.reason, shared);
  const skips = [
    isolation.available
      ? t("yoloAskFilesAndCommands")
      : windowsDirectRun === "consented"
        ? shared("yolo.filesAndCommands.windows")
        : t("yoloAskFilesOnly"),
    ...t("yoloAskSkipsList").split("\n"),
  ];
  const keeps = shared(windows ? "yolo.keepsList.windows" : "yolo.keepsList").split("\n");
  return (
    <>
      <SheetIcon name="warning" tone="warn" />
      <SheetTitle center text={t("yoloAskTitle")} />
      {page.scope?.kind === "group" && <SheetText text={t("yoloAskGroup")} />}
      <SheetText text={t("yoloAskPrivacy")} />
      {isolation.available && <SheetText text={shared("yolo.savedDirectRuns")} />}
      <ListCard flush style={{ paddingVertical: 10, paddingHorizontal: 14, gap: 6 }}>
        <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.ok }}>
          {t("yoloAskSkipsTitle")}
        </Text>
        {skips.map((line) => (
          <Text key={line} style={{ fontSize: 13.5, lineHeight: 20, color: colors.text }}>
            · {line}
          </Text>
        ))}
        <Separator />
        <Text style={{ fontSize: 13.5, fontWeight: "600", color: colors.danger, marginTop: 2 }}>
          {t("yoloAskKeepsTitle")}
        </Text>
        {keeps.map((line) => (
          <Text key={line} style={{ fontSize: 13.5, lineHeight: 20, color: colors.text }}>
            · {line}
          </Text>
        ))}
      </ListCard>
      {commandNote && <SheetText text={commandNote} />}
      <SheetText small text={t("yoloAskHint")} />
      <SheetText
        small
        text={shared(
          windowsDirectRun === "consented"
            ? "yolo.nothingRemembered.windows"
            : "yolo.nothingRemembered",
        )}
      />
      <Button
        variant="ghost"
        title={t(details ? "yoloHideDetails" : "yoloShowDetails")}
        onPress={() => setDetails((open) => !open)}
      />
      {details && (
        <>
          <SheetText small text={shared(windows ? "yolo.details.windows" : "yolo.details")} />
          {!windows && isolationDetail && <SheetText small text={isolationDetail} />}
        </>
      )}
      {status}
      <Button
        size="lg"
        variant="prim"
        icon="face"
        title={t("yoloTurnOn")}
        disabled={disabled}
        onPress={() => void change(true)}
      />
      <Button size="lg" variant="ghost" title={t("cancel")} onPress={onClose} />
    </>
  );
}
