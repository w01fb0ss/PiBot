import { AgentBotProfile, AgentPanel } from "@pibot/external-agents/ui";
import { PendingImportedSkills, TargetConnections } from "@pibot/plugins/ui";
import {
  BotAvatar,
  botAvatarLook,
  botPanelStyles as styles,
  useNavigation,
  useT,
} from "@pibot/renderer-kit";
import { BotRoutines } from "@pibot/routines/ui";
import { SkillsSection } from "@pibot/skills/ui";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { UsedFolders } from "../../folders/UsedFolders.tsx";
import { MemoryPanel } from "../memory/MemoryPanel.tsx";
import { InlineBotField } from "../new-chat/InlineBotField.tsx";
import { Topics } from "../topics/Topics.tsx";
import { AvatarPicker } from "./AvatarPicker.tsx";
import { BotLimits } from "./BotLimits.tsx";
import { BotLogRetention } from "./BotLogRetention.tsx";
import { BotPanelFrame } from "./BotPanelFrame.tsx";
import { useBotPanelMenu } from "./BotPanelMenu.tsx";
import type { useCatalog } from "./catalog.ts";
import { ProfileDetails } from "./ProfileDetails.tsx";
import { ProfilePermissions } from "./ProfilePermissions.tsx";
import { type BotUpdate, useBotEditor } from "./use-bot-editor.ts";

// The pending list refreshes itself on `plugins.changed`; nothing here needs telling.
const settled = () => undefined;

export function BotProfile({
  botId,
  conversationId,
  draft,
  catalog,
  send,
}: {
  /** Sends an ordinary message into this Bot's open chat (skill trial runs). */
  send?(text: string): Promise<boolean>;
  botId: string;
  conversationId?: string;
  draft: boolean;
  catalog: ReturnType<typeof useCatalog>;
}) {
  const t = useT();
  const navigation = useNavigation();
  const editor = useBotEditor(botId);
  const [avatar, setAvatar] = useState(false);
  const bot = editor.bot;
  const actions = useBotPanelMenu(bot, editor.busy);
  // Internal tab ids stay stable for deep links; only the labels were renamed.
  const tab = navigation.botPanel?.tab ?? "details";
  const importedBatch = navigation.botPanel?.importedBatch;
  return (
    <BotPanelFrame
      agent={bot?.kind === "agent"}
      label={t("workspace.profile")}
      tone={bot ? botAvatarLook(bot).color : undefined}
      tab={tab}
      menu={actions.menu}
      changeTab={(next) => {
        setAvatar(false);
        navigation.openBotPanel(botId, next, true);
      }}
      close={navigation.closeBotPanel}
      header={
        bot ? (
          <>
            <button
              type="button"
              className={styles.avatar}
              aria-label={t("workspace.avatar")}
              title={t("panel.editAvatar")}
              aria-expanded={avatar}
              onClick={() => setAvatar((value) => !value)}
            >
              <BotAvatar bot={bot} size={72} />
            </button>
            {avatar && <span className={styles.avatarHint}>{t("panel.avatarCollapse")}</span>}
            {avatar && (
              <AvatarPicker
                bot={bot}
                disabled={editor.busy}
                change={(next) => {
                  const patch: BotUpdate = {};
                  for (const key of [
                    "avatarShape",
                    "avatarColor",
                    "avatarEyes",
                    "avatarImage",
                  ] as const) {
                    if (next[key] !== bot[key]) Object.assign(patch, { [key]: next[key] });
                  }
                  return Object.keys(patch).length ? editor.save(patch) : Promise.resolve(true);
                }}
              />
            )}
            <InlineBotField
              label={t("workspace.name")}
              hint={t("panel.editName")}
              value={bot.name}
              maxLength={200}
              required
              requiredMessage={t("workspace.nameRequired")}
              resetKey={bot.updatedAt}
              disabled={editor.busy}
              className={styles.name}
              save={async (name) => {
                const result = await editor.rename(name);
                return result === "name_taken" ? t("workspace.nameTaken", { name }) : result;
              }}
            />
            <InlineBotField
              multiline
              label={t("workspace.description")}
              hint={t("panel.editDescription")}
              placeholder={t("panel.addDescription")}
              value={bot.description ?? ""}
              maxLength={4000}
              disabled={editor.busy}
              className={styles.job}
              save={(description) => editor.save({ description })}
            />
          </>
        ) : (
          <span>{t("workspace.profile")}</span>
        )
      }
    >
      {editor.loading && !bot && (
        <p role="status" className={styles.note}>
          {t("common.loading")}
        </p>
      )}
      {editor.error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="pill" onClick={() => void editor.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {actions.notice}
      {bot && tab === "details" && bot.kind === "agent" && (
        <>
          <AgentBotProfile botId={bot.id} />
          <UsedFolders botId={bot.id} />
        </>
      )}
      {bot && tab === "agent" && bot.kind === "agent" && (
        <AgentPanel botId={bot.id} {...(conversationId && !draft ? { conversationId } : {})} />
      )}
      {bot && tab === "details" && bot.kind !== "agent" && (
        <>
          <ProfileDetails bot={bot} save={editor.save} busy={editor.busy} catalog={catalog} />
          <BotLogRetention botId={bot.id} />
          {conversationId && !draft && <BotLimits botId={bot.id} conversationId={conversationId} />}
        </>
      )}
      {bot && tab === "topics" && (
        <>
          <BotRoutines key={botId} botId={botId} />
          <Topics
            key={importedBatch?.key}
            botId={botId}
            conversationId={conversationId}
            draft={draft}
            importId={importedBatch?.id}
          />
        </>
      )}
      {bot && tab === "memory" && (
        <>
          <SkillsSection
            key={bot.id}
            botId={bot.id}
            botName={bot.name}
            archived={!!bot.archivedAt}
            send={send}
            conversationId={conversationId}
            focusSkillId={navigation.botPanel?.skillId}
            allowWorkflowRun
            connections={bot.category !== "image"}
            pendingImports={<PendingImportedSkills changed={settled} />}
            // The skills area's「教它做一次」opens the teach flow (image Bots have no browser).
            teach={
              bot.category === "image"
                ? undefined
                : () => navigation.navigate({ name: "teach", botId: bot.id })
            }
          />
          {/* Image Bots call no tools, so connections would never apply to them. */}
          {bot.category !== "image" && (
            <TargetConnections key={`connections:${bot.id}`} target={{ kind: "bot", id: bot.id }} />
          )}
          <MemoryPanel bot={bot} save={editor.save} busy={editor.busy} />
        </>
      )}
      {bot && tab === "permissions" && <ProfilePermissions bot={bot} />}
    </BotPanelFrame>
  );
}
