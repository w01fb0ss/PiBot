import {
  type Message,
  Methods,
  nextGroupRoundLimit,
  PI_HEALTH_CHECK_TOOL,
  type PiHealthItem,
  type PiHealthReport,
} from "@pibot/protocol";
import { useState } from "react";
import { Text, View } from "react-native";
import { useRuntime, useSharedText } from "../../../runtime/context.tsx";
import { useCachedValue } from "../../../runtime/use-cached-value.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard } from "../../../ui/controls.tsx";
import { Icon } from "../../../ui/icons.tsx";

const ListSchema = Methods["teams.healthReports"].result;

/** Whether this reply ran the default Pi's health check (only then is there a list to read). */
export function checkedHealth(message: Message) {
  return (
    message.role === "assistant" &&
    !!message.tools?.some((tool) => tool.tool === PI_HEALTH_CHECK_TOOL)
  );
}

/**
 * The default Pi's health check under its reply, as on the desktop: one row per stuck item with
 * its suggested fix, marked once a repair fixed it. The repairs themselves are approval cards.
 */
export function HealthReportCards({ messageId }: { messageId: string }) {
  const runtime = useRuntime();
  const list = useCachedValue(
    `health:${messageId}`,
    ListSchema,
    (signal) => runtime.call("teams.healthReports", { messageId }, signal),
    ["teams.health.changed"],
  );
  if (!list.value?.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {list.value.map((report) => (
        <HealthReportCard key={report.id} report={report} />
      ))}
    </View>
  );
}

function HealthReportCard({ report }: { report: PiHealthReport }) {
  const colors = useColors(),
    t = useSharedText();
  const runtime = useRuntime();
  const [busy, setBusy] = useState(false);
  const tap = async (item: string, action: PiHealthItem["actions"][number]) => {
    if (busy) return;
    setBusy(true);
    try {
      await runtime.call(
        "teams.healthRepair",
        { check: report.id, item, action },
        AbortSignal.timeout(15_000),
      );
    } catch {
      // The chat shows nothing new; the buttons come back so the person can tap again.
    } finally {
      setBusy(false);
    }
  };
  const outcomes = new Map(report.resolutions.map((value) => [value.itemId, value.outcome]));
  const total = report.items.length + report.more;
  return (
    <ListCard flush>
      <View
        accessibilityLabel={t("piHealth.label")}
        style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 12, gap: 10 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="shield" color={total ? colors.text2 : colors.ok} size={16} />
          <Text style={{ flex: 1, fontSize: 15, fontWeight: "600", color: colors.text }}>
            {total ? t("piHealth.title.found", { count: total }) : t("piHealth.title.ok")}
          </Text>
        </View>
        {report.items.map((item) => {
          const outcome = outcomes.get(item.id);
          const raiseTo =
            item.roundLimit === undefined ? undefined : nextGroupRoundLimit(item.roundLimit);
          const where = [item.where.botName, item.where.groupName, item.where.title]
            .filter(Boolean)
            .join(" · ");
          return (
            <View key={item.id} style={{ gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: colors.text }}>
                {where || t(`piHealth.kind.${item.kind}`)}
              </Text>
              <Text style={{ fontSize: 13, lineHeight: 19, color: colors.text }}>
                {t(`piHealth.reason.${item.reason}`)}
              </Text>
              {outcome || !item.actions.length ? (
                <Text
                  style={{
                    fontSize: 13,
                    lineHeight: 19,
                    color: outcome === "fixed" ? colors.ok : colors.text2,
                  }}
                >
                  {outcome ? t(`piHealth.outcome.${outcome}`) : t("piHealth.noFix")}
                </Text>
              ) : (
                // A tap asks Pi for exactly this fix (carried by the program, never ids in text).
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {item.actions.slice(0, 3).map((action) => (
                    <Button
                      key={action}
                      title={
                        action === "rounds_raise" && raiseTo !== undefined
                          ? t("piHealth.roundsRaiseTo", { limit: raiseTo })
                          : t(`piHealth.action.${action}`)
                      }
                      disabled={busy}
                      onPress={() => void tap(item.id, action)}
                    />
                  ))}
                </View>
              )}
            </View>
          );
        })}
        {report.more > 0 && (
          <Text style={{ fontSize: 12, color: colors.text2 }}>
            {t("piHealth.more", { count: report.more })}
          </Text>
        )}
      </View>
    </ListCard>
  );
}
