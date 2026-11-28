import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { z } from "zod";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { GroupAvatar } from "../../ui/avatar.tsx";
import { EmptyState, ListCard, Separator } from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { OptionRow, Radio, Sheet, SheetTitle } from "../../ui/sheet.tsx";
import { botLook } from "../conversations/model.ts";
import { Group, LinkRow, Note, Rows, SettingsPage, TextField } from "./fields.tsx";
import { GroupMemoryPage, MembersPage } from "./group/GroupPages.tsx";
import { type GroupSettingsState, useGroupSettings } from "./use-group-settings.ts";

const ParamsSchema = z.object({
  id: z.uuid(),
  page: z.enum(["members", "memory"]).optional(),
});
/** Route: /settings/group/<id>[?page=members|memory]. */
export function GroupSettingsScreen() {
  const params = ParamsSchema.safeParse(useLocalSearchParams());
  const router = useRouter(),
    t = useText();
  if (!params.success)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title="" onBack={() => router.back()} />
        <EmptyState icon="message" title={t("stale")} />
      </View>
    );
  const { id, page } = params.data;
  return <GroupSettingsView key={`${id}:${page}`} groupId={id} page={page} />;
}
function GroupSettingsView({ groupId, page }: { groupId: string; page?: "members" | "memory" }) {
  const state = useGroupSettings(groupId);
  const router = useRouter();
  if (page === "members") return <MembersPage state={state} />;
  if (page === "memory") return <GroupMemoryPage state={state} />;
  return (
    <GroupOverview
      state={state}
      open={(next) => router.push(`/settings/group/${groupId}?page=${next}`)}
    />
  );
}
type Picker = "coordinator" | "rounds" | "mode";
function GroupOverview({
  state,
  open,
}: {
  state: GroupSettingsState;
  open: (page: "members" | "memory") => void;
}) {
  const t = useText(),
    colors = useColors();
  const [picker, setPicker] = useState<Picker>();
  const { group, data } = state;
  const names = new Map(data?.bots.map((bot) => [bot.id, bot]));
  const execution = data?.execution;
  // Coordinators need Pi Bot's group planning tools.
  const coordinators =
    group?.members.filter(({ botId }) => {
      const bot = names.get(botId);
      return !!bot && bot.category !== "image" && bot.kind !== "agent";
    }) ?? [];
  const options: { key: string; title: string; on: boolean; pick: () => void }[] =
    !group || !picker
      ? []
      : picker === "coordinator"
        ? coordinators.map(({ botId }) => ({
            key: botId,
            title: names.get(botId)?.name ?? botId,
            on: group.coordinatorBotId === botId,
            pick: () => void state.update({ coordinatorBotId: botId }),
          }))
        : picker === "rounds"
          ? Array.from({ length: 10 }, (_, index) => index + 1).map((count) => ({
              key: String(count),
              title: t("rounds", { count }),
              on: group.autoRoundLimit === count,
              pick: () => void state.update({ autoRoundLimit: count }),
            }))
          : (["execute", "plan"] as const).map((mode) => ({
              key: mode,
              title: t(mode === "execute" ? "modeExecute" : "modePlan"),
              on: execution?.mode === mode,
              pick: () => void state.setMode(mode),
            }));
  return (
    <SettingsPage
      title={group?.name ?? t("groupSettings")}
      state={state}
      footer={t("groupDesktopOnly")}
    >
      {group && data && (
        <>
          <View
            style={{
              alignItems: "center",
              gap: 6,
              paddingTop: 18,
              paddingHorizontal: 24,
              paddingBottom: 6,
            }}
          >
            <GroupAvatar
              size={72}
              members={group.members.flatMap(({ botId }) => {
                const bot = names.get(botId);
                return bot ? [botLook(bot)] : [];
              })}
            />
            <Text
              style={{
                marginTop: 6,
                fontSize: 18,
                lineHeight: 24,
                fontWeight: "600",
                color: colors.text,
              }}
            >
              {group.name}
            </Text>
            <Text
              numberOfLines={2}
              style={{ fontSize: 13, lineHeight: 19, color: colors.text2, textAlign: "center" }}
            >
              {[t("membersCount", { count: group.members.length }), group.announcement]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
          <Group title={t("groupProfile")}>
            <Rows>
              {[
                <TextField
                  key="name"
                  label={t("groupName")}
                  value={group.name}
                  maxLength={200}
                  editable={state.editable}
                  onSave={(name) => (name.trim() ? state.update({ name: name.trim() }) : undefined)}
                />,
                <TextField
                  key="announcement"
                  label={t("groupAnnouncement")}
                  value={group.announcement}
                  placeholder={t("announcementPlaceholder")}
                  maxLength={8000}
                  multiline
                  editable={state.editable}
                  onSave={(announcement) => state.update({ announcement })}
                />,
              ]}
            </Rows>
          </Group>
          <Group title={t("members")}>
            <Rows>
              {[
                <LinkRow
                  key="members"
                  title={t("members")}
                  value={t("membersCount", { count: group.members.length })}
                  onPress={() => open("members")}
                />,
                <LinkRow
                  key="memory"
                  title={t("groupMemory")}
                  value={
                    data.memory
                      ? t("memoryCount", { count: data.memory.memories.length })
                      : undefined
                  }
                  subtitle={data.memory ? undefined : t("sectionUnavailable")}
                  onPress={() => open("memory")}
                />,
              ]}
            </Rows>
          </Group>
          <Group title={t("groupExecution")}>
            <Rows>
              {[
                <LinkRow
                  key="coordinator"
                  title={t("coordinator")}
                  value={names.get(group.coordinatorBotId)?.name}
                  disabled={!state.editable}
                  onPress={() => setPicker("coordinator")}
                />,
                <LinkRow
                  key="rounds"
                  title={t("roundLimit")}
                  value={t("rounds", { count: group.autoRoundLimit })}
                  disabled={!state.editable}
                  onPress={() => setPicker("rounds")}
                />,
                execution && (
                  <LinkRow
                    key="mode"
                    title={t("groupMode")}
                    value={t(execution.mode === "execute" ? "modeExecute" : "modePlan")}
                    disabled={!state.editable}
                    onPress={() => setPicker("mode")}
                  />
                ),
              ]}
            </Rows>
          </Group>
          {execution && (
            <Note
              text={t("limitsSummary", {
                minutes: Math.round(execution.limits.activeSeconds / 60),
                requests: execution.limits.modelRequests,
              })}
            />
          )}
          <Group title={t("resources")}>
            {group.folders?.length ? (
              group.folders.map((folder, index) => (
                <View key={folder.id}>
                  {index > 0 && <Separator />}
                  <OptionRow
                    strong
                    title={folder.name}
                    subtitle={folder.displayPath}
                    lead={<Icon name="folder" color={colors.text} size={18} />}
                    value={
                      folder.id === group.primaryFolderId || folder.role
                        ? t(
                            folder.id === group.primaryFolderId || folder.role === "primary"
                              ? "primaryFolder"
                              : "readonlyFolder",
                          )
                        : undefined
                    }
                  />
                </View>
              ))
            ) : (
              <Note text={t("noFolders")} />
            )}
          </Group>
          <Note text={t("resourcesNote")} />
        </>
      )}
      <Sheet visible={!!picker} onClose={() => setPicker(undefined)}>
        {picker && (
          <>
            <SheetTitle
              text={t(
                picker === "coordinator"
                  ? "coordinator"
                  : picker === "rounds"
                    ? "roundLimit"
                    : "groupMode",
              )}
            />
            <ListCard flush>
              {options.map((option, index) => (
                <View key={option.key}>
                  {index > 0 && <Separator />}
                  <OptionRow
                    title={option.title}
                    selected={option.on}
                    right={<Radio on={option.on} />}
                    onPress={() => {
                      setPicker(undefined);
                      if (!option.on) option.pick();
                    }}
                  />
                </View>
              ))}
            </ListCard>
          </>
        )}
      </Sheet>
    </SettingsPage>
  );
}
