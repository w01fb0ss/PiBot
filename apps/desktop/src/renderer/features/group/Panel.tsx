import type { ChatPeer } from "@pibot/client-core";
import type { GroupTopic, Workplaces } from "@pibot/protocol";
import { BotAvatar, botPanelStyles as panelStyles, useNavigation, useT } from "@pibot/renderer-kit";
import { GroupAvatar } from "@pibot/ui";
import { UsedFolders } from "../folders/UsedFolders.tsx";
import { PanelFrame } from "../workspace/profile/BotPanelFrame.tsx";
import { PanelMenu } from "../workspace/profile/PanelMenu.tsx";
import type { GroupSnapshot } from "./data.ts";
import styles from "./group.module.css";
import { GroupPermissions } from "./members/GroupPermissions.tsx";
import { GroupMembers } from "./members/Members.tsx";
import { GroupResources } from "./resources/GroupResources.tsx";
import { GroupSettings } from "./Settings.tsx";
import { GroupTopics } from "./topics/GroupTopics.tsx";
export const groupTabs = ["details", "topics", "capabilities", "permissions"] as const;
export type GroupTab = (typeof groupTabs)[number];
export function GroupPanel({
  peer,
  data,
  tab,
  changeTab,
  close,
  places,
  refresh,
  selectTopic,
  conversationId,
  selectedTopic,
  draft = false,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  tab: GroupTab;
  changeTab(tab: GroupTab): void;
  close(): void;
  places?: Map<string, Workplaces>;
  refresh(): Promise<void>;
  selectTopic(topic?: GroupTopic): void;
  conversationId?: string;
  selectedTopic?: GroupTopic;
  draft?: boolean;
}) {
  const t = useT(),
    { openWorkspace } = useNavigation(),
    group = data.group;
  if (!group) return null;
  return (
    <PanelFrame
      tone="teal"
      id="group-panel"
      label={t("group.panel")}
      menu={
        <PanelMenu
          label={t("panel.more")}
          items={[
            {
              id: "export",
              label: t("panel.exportGroup"),
              run: () => openWorkspace({ name: "share", target: { groupId: group.id } }),
            },
          ]}
        />
      }
      tab={tab}
      changeTab={(value) => {
        const chosen = groupTabs.find((tab) => tab === value);
        if (chosen) changeTab(chosen);
      }}
      close={close}
      items={groupTabs.map((value) => ({ value, label: t(`group.${value}`) }))}
      header={
        <>
          {/* The member collage sits on a soft round card. */}
          <span className={styles.panelAvatar}>
            <GroupAvatar size={60}>
              {data.bots.map((bot) => (
                <BotAvatar key={bot.id} bot={bot} label={bot.name} size={30} />
              ))}
            </GroupAvatar>
          </span>
          <strong className={styles.panelName}>{group.name}</strong>
          <span className={styles.panelLine}>
            {t("group.memberCount", {
              count: group.members.length,
              name:
                data.bots.find((bot) => bot.id === group.coordinatorBotId)?.name ??
                t("group.member"),
            })}
          </span>
        </>
      }
    >
      {tab === "details" && (
        <GroupSettings key={group.id} peer={peer} data={{ ...data, group }} refresh={refresh}>
          <section className={panelStyles.section} aria-label={t("group.members")}>
            <h2>{t("group.members")}</h2>
            <GroupMembers peer={peer} data={data} places={places} refresh={refresh} />
          </section>
          <UsedFolders groupId={group.id} />
        </GroupSettings>
      )}
      {tab === "topics" && (
        <GroupTopics
          peer={peer}
          group={group}
          selected={selectedTopic}
          conversationId={conversationId}
          inline
          draft={draft}
          select={selectTopic}
          refresh={refresh}
          running={data.runs.some((run) => run.status === "queued" || run.status === "running")}
        />
      )}
      {tab === "capabilities" && <GroupResources key={group.id} data={data} />}
      {tab === "permissions" && <GroupPermissions groupId={group.id} groupName={group.name} />}
    </PanelFrame>
  );
}
