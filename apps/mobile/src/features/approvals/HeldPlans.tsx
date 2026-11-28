import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import type { MobileKey } from "../../i18n/messages.ts";
import { useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ErrorLine, ListCard } from "../../ui/controls.tsx";
import { useToast } from "../../ui/toast.tsx";
import { useApprovals } from "./approvals-context.tsx";
import type { HeldChoice, HeldPlan } from "./held-plans.ts";

type Choice = HeldChoice;
/** The desktop card's options for each kind of wait, in the same order. */
const OPTIONS: Record<HeldPlan["progress"]["choice"]["kind"], readonly Choice[]> = {
  replan_limit: ["continue", "new_plan"],
  fix_skipped: ["accept", "stop"],
};
const LABEL: Record<Choice, MobileKey> = {
  continue: "gpHeldContinue",
  new_plan: "gpHeldNewPlan",
  accept: "gpHeldAccept",
  stop: "gpHeldStop",
};
const DONE: Record<Choice, MobileKey> = {
  continue: "gpHeldContinued",
  new_plan: "gpHeldNewPlanDone",
  accept: "gpHeldAccepted",
  stop: "gpHeldStopped",
};

/** The phone's inbox part for held plans: what happened and the desktop card's choices. */
export function HeldPlans({ online }: { online: boolean }) {
  const t = useText(),
    colors = useColors(),
    toast = useToast(),
    router = useRouter(),
    held = useApprovals().held;
  if (!held.plans.length) return null;
  const choose = async (plan: HeldPlan, choice: Choice) => {
    const goal = await held.choose(plan, choice);
    if (goal === undefined) return;
    toast(t(DONE[choice]));
    // 新开计划: the group chat opens with the old goal in its input, to edit and send.
    if (choice === "new_plan")
      router.push({
        pathname: "/conversation/[kind]/[id]",
        params: { kind: "group", id: plan.groupId, ...(goal ? { draft: goal } : {}) },
      });
  };
  return (
    <>
      {held.plans.map((plan) => {
        const titles = new Map(plan.card.plan.steps.map((step) => [step.id, step.title]));
        const steps = plan.progress.choice.stepIds.map((id) => titles.get(id) ?? id).join(" · ");
        const kind = plan.progress.choice.kind;
        return (
          <ListCard key={plan.progress.workflowRunId}>
            <View style={{ padding: 14, gap: 8 }}>
              <Text style={[type.small, { color: colors.warn }]}>{t("gpHeldTitle")}</Text>
              <Text style={[type.rowTitle, { color: colors.text }]} numberOfLines={2}>
                {plan.card.plan.name}
              </Text>
              <Text style={[type.preview, { color: colors.text2 }]}>
                {kind === "replan_limit"
                  ? t("gpHeldReplanLimit")
                  : t("gpHeldFixSkipped", { steps })}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                {OPTIONS[kind].map((choice, index) => (
                  <Button
                    key={choice}
                    variant={index === 0 ? "prim" : "default"}
                    title={t(LABEL[choice])}
                    disabled={!online || held.write.busy}
                    onPress={() => void choose(plan, choice)}
                  />
                ))}
                <Button
                  variant="ghost"
                  title={t("gpHeldOpen")}
                  onPress={() => router.push(`/conversation/group/${plan.groupId}`)}
                />
              </View>
            </View>
          </ListCard>
        );
      })}
      <ErrorLine text={held.write.error && t(held.write.error)} />
    </>
  );
}
