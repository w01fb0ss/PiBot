import { localizedPlanStepTitle } from "@pibot/i18n";
import { GroupPlanCardSchema, type Message, visibleTaskText } from "@pibot/protocol";
import { useState } from "react";
import { Text, View } from "react-native";
import { useLanguage, useSharedText, useText } from "../../../runtime/context.tsx";
import { type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard } from "../../../ui/controls.tsx";
import { Sheet, SheetLabel, SheetText, SheetTitle } from "../../../ui/sheet.tsx";

export function GroupPlanMessageCard({ message }: { message: Message }) {
  const t = useText(),
    shared = useSharedText(),
    language = useLanguage(),
    colors = useColors();
  const [open, setOpen] = useState(false);
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage) || !usage.groupPlan) return null;
  const parsed = GroupPlanCardSchema.safeParse(usage.groupPlan);
  if (!parsed.success) return null;
  const { plan, status } = parsed.data;
  const state = t(
    status === "pending"
      ? "gpPlanPending"
      : status === "ready"
        ? "gpPlanReady"
        : status === "starting"
          ? "gpPlanStarting"
          : status === "modify"
            ? "gpPlanModify"
            : "gpPlanStarted",
  );
  return (
    <ListCard flush raised style={{ alignSelf: "stretch", padding: 12, gap: 6 }}>
      <Text style={[type.rowTitle, { color: colors.text }]} numberOfLines={2}>
        {shared("group.plan.title")} · {plan.name}
      </Text>
      <Text style={[type.caption, { color: colors.text2 }]}>{state}</Text>
      <Button
        title={t("gpOpenPlan")}
        style={{ alignSelf: "flex-end" }}
        onPress={() => setOpen(true)}
      />
      {open && (
        <Sheet visible onClose={() => setOpen(false)}>
          <SheetTitle text={plan.name} />
          <SheetText text={state} />
          {/* History can contain more than one plan; show the steps from this message. */}
          {plan.steps.map((step) => (
            <View key={step.id}>
              <SheetLabel text={localizedPlanStepTitle(step.title, language)} />
              <SheetText text={visibleTaskText(step.task)} />
            </View>
          ))}
          <Button title={t("close")} onPress={() => setOpen(false)} />
        </Sheet>
      )}
    </ListCard>
  );
}
