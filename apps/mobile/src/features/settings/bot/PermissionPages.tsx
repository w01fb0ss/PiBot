import { topicGrantLabel } from "@pibot/client-core";
import { commandNetworkNoteKey } from "@pibot/i18n";
import type { Category, GrantListItem, Level } from "@pibot/protocol";
import { useState } from "react";
import { View } from "react-native";
import { useMobileSelector, useSharedText, useText } from "../../../runtime/context.tsx";
import { Button, ListCard, Separator, Switch } from "../../../ui/controls.tsx";
import { OptionRow, Radio, Sheet, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import { Group, Note, SettingsPage } from "../fields.tsx";
import type { BotSettingsState } from "../use-bot-settings.ts";

type Props = { state: BotSettingsState };
const levels: Level[] = ["never", "ask", "always"];
// Same grouping and choices as the desktop profile (PermissionsContent.tsx).
const sections: {
  title: "permissionsOperations" | "permissionsNetwork" | "permissionsSending";
  categories: Category[];
}[] = [
  {
    title: "permissionsOperations",
    categories: ["run_command", "read_file", "list_dir", "write_file"],
  },
  { title: "permissionsNetwork", categories: ["web"] },
  {
    title: "permissionsSending",
    categories: ["connector", "send_out", "read_ai_config", "read_messages"],
  },
];
const choices = (category: Category): Level[] =>
  category === "send_out" || category === "read_ai_config" ? ["never", "ask"] : levels;

function scopeText(
  grant: GrantListItem,
  connectorName: (id: string) => string | undefined,
  shared: ReturnType<typeof useSharedText>,
) {
  const scope = grant.scope;
  const topic = topicGrantLabel(grant, shared);
  if (topic) return topic;
  switch (scope.kind) {
    case "web_read":
      return shared("permissions.webReadScope");
    case "paid_image":
      return shared("permissions.paidImageScope", {
        model: `${grant.providerName || scope.provider} / ${scope.model}`,
      });
    case "send_target":
      return scope.target;
    case "secret":
      return scope.name;
    case "connector_tool":
      return scope.tool;
    case "connector":
      return connectorName(scope.connectorId) ?? scope.connectorId;
    case "programs":
      return `${scope.programs.join(", ")} · ${shared("permissions.singleRootScope", { root: scope.root })}`;
    case "folder":
      return scope.path;
    case "workplace":
      return shared("permissions.singleRootScope", { root: scope.root });
    case "apps":
      return scope.apps.join(", ");
    case "login":
      return scope.site;
    default:
      return scope.domain;
  }
}
export function PermissionsPage({ state }: Props) {
  const t = useText(),
    shared = useSharedText(),
    toast = useToast();
  const [editing, setEditing] = useState<Category>();
  const [networkDetails, setNetworkDetails] = useState(false);
  const desktopPlatform = useMobileSelector((state) =>
    state.desktop?.computerId === state.selectedId ? state.desktop?.platform : undefined,
  );
  const permissions = state.data?.permissions;
  const image = state.bot?.category === "image";
  const effective = permissions && (permissions.scoped.effective ?? permissions.scoped);
  const overrides = permissions?.scoped.overrides;
  const name = (id: string) =>
    state.data?.connectors?.find((row) => row.connector.id === id)?.connector.name;
  const shown = image
    ? [{ title: "permissionsSending" as const, categories: ["read_messages" as Category] }]
    : sections;
  const choose = async (category: Category, level: Level | null) => {
    setEditing(undefined);
    if (await state.setPermissions({ levels: { [category]: level } })) toast(t("settingsSaved"));
  };
  return (
    <SettingsPage title={t("permissions")} state={state} footer={t("widenNote")}>
      {state.data && !effective && <Note text={t("sectionUnavailable")} />}
      {effective &&
        shown.map((section) => (
          <Group key={section.title} title={t(section.title)}>
            {section.categories.map((category, index) => (
              <View key={category}>
                {index > 0 && <Separator />}
                <OptionRow
                  strong
                  title={shared(`permissions.category.${category}`)}
                  subtitle={t(overrides?.[category] !== undefined ? "overridden" : "followGlobal")}
                  disabled={!state.editable}
                  value={shared(`permissions.level.${effective.levels[category]}`)}
                  onPress={() => setEditing(category)}
                />
              </View>
            ))}
            {section.title === "permissionsNetwork" && (
              <>
                <Separator />
                <OptionRow
                  strong
                  title={shared("permissions.allowNetwork")}
                  subtitle={`${shared(effective.network.allowAll ? "permissions.webNetworkOn" : "permissions.webNetworkOff")} ${shared(commandNetworkNoteKey(desktopPlatform, effective.network.allowAll))}`}
                  right={
                    <Switch
                      label={shared("permissions.allowNetwork")}
                      value={effective.network.allowAll}
                      disabled={!state.editable}
                      onValueChange={(allowAll) =>
                        void state.setPermissions({ network: { allowAll } })
                      }
                    />
                  }
                />
                <OptionRow
                  title={shared(
                    networkDetails
                      ? "permissions.networkHideDetails"
                      : "permissions.networkDetails",
                  )}
                  subtitle={networkDetails ? shared("permissions.networkExceptions") : undefined}
                  onPress={() => setNetworkDetails((open) => !open)}
                />
                {!effective.network.allowAll && (
                  <>
                    <Separator />
                    <OptionRow
                      title={shared("permissions.domains")}
                      subtitle={
                        effective.network.domains.length
                          ? effective.network.domains.join(shared("tool.group.separator"))
                          : shared("permissions.noDomains")
                      }
                    />
                  </>
                )}
                {overrides?.network && (
                  <>
                    <Separator />
                    <OptionRow
                      title={t("followGlobal")}
                      disabled={!state.editable}
                      onPress={() => void state.setPermissions({ network: null })}
                    />
                  </>
                )}
              </>
            )}
          </Group>
        ))}
      {state.data && (
        <Group title={t("grants")}>
          {state.data.grants?.length ? (
            state.data.grants.map((grant, index) => (
              <View key={grant.id}>
                {index > 0 && <Separator />}
                <OptionRow
                  strong
                  title={shared(`permissions.category.${grant.category}`)}
                  subtitle={scopeText(grant, name, shared)}
                  right={
                    <Button
                      variant="danger"
                      title={t("revoke")}
                      disabled={!state.editable}
                      onPress={() =>
                        void state.revokeGrant(grant.id).then((ok) => {
                          if (ok) toast(t("revoked"));
                        })
                      }
                    />
                  }
                />
              </View>
            ))
          ) : (
            <Note text={t(state.data.grants ? "noGrants" : "sectionUnavailable")} />
          )}
        </Group>
      )}
      <Sheet visible={!!editing} onClose={() => setEditing(undefined)}>
        {editing && effective && (
          <>
            <SheetTitle text={shared(`permissions.category.${editing}`)} />
            <ListCard flush>
              {choices(editing).map((level, index) => (
                <View key={level}>
                  {index > 0 && <Separator />}
                  <OptionRow
                    title={shared(`permissions.level.${level}`)}
                    selected={effective.levels[editing] === level}
                    right={<Radio on={effective.levels[editing] === level} />}
                    onPress={() => void choose(editing, level)}
                  />
                </View>
              ))}
              {overrides?.[editing] !== undefined && (
                <>
                  <Separator />
                  <OptionRow title={t("followGlobal")} onPress={() => void choose(editing, null)} />
                </>
              )}
            </ListCard>
            <SheetText small text={t("permissionsHint")} />
          </>
        )}
      </Sheet>
    </SettingsPage>
  );
}
export function ConnectorsPage({ state }: Props) {
  const t = useText(),
    shared = useSharedText(),
    toast = useToast();
  const botId = state.bot?.id;
  const rows = state.data?.connectors;
  return (
    <SettingsPage title={t("connectors")} state={state} footer={t("connectorsNote")}>
      {state.data && (
        <Group>
          {!rows ? (
            <Note text={t("sectionUnavailable")} />
          ) : rows.length ? (
            rows.map(({ connector, access }, index) => (
              <View key={connector.id}>
                {index > 0 && <Separator />}
                <OptionRow
                  strong
                  title={connector.name}
                  subtitle={`${shared(`connectors.access.${access.mode}`)} · ${shared(
                    `connectors.status.${connector.status}`,
                  )}`}
                  right={
                    // "Ask first" has no per-Bot narrowing; that choice stays on the computer.
                    access.mode !== "ask_first" && botId ? (
                      <Button
                        variant="danger"
                        title={t("revoke")}
                        disabled={!state.editable}
                        onPress={() =>
                          void state.revokeConnector(connector.id).then((ok) => {
                            if (ok) toast(t("revoked"));
                          })
                        }
                      />
                    ) : undefined
                  }
                />
              </View>
            ))
          ) : (
            <Note text={t("noConnectors")} />
          )}
        </Group>
      )}
    </SettingsPage>
  );
}
