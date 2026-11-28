import {
  approvalExplanation,
  approvalFactText,
  approvalText,
  isDirectRunApproval,
  isolationReasonText,
  isWindowsDirectRunApproval,
  systemServiceLabel,
} from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLanguage, useLinkState, useSharedText, useText } from "../../runtime/context.tsx";
import { BlurTarget, Glass, GlassScope, useGlassTarget } from "../../theme/glass.tsx";
import { PageTint } from "../../theme/page-tint.tsx";
import { radius, type } from "../../theme/scale.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Banner, Button, CheckMark, EmptyState, ErrorLine, ListCard } from "../../ui/controls.tsx";
import { NavBar, OfflineBanner } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { Sheet, SheetIcon, SheetText, SheetTitle } from "../../ui/sheet.tsx";
import { useTimeText } from "../../ui/time.ts";
import { useToast } from "../../ui/toast.tsx";
import { ApprovalHeader, CodeBlock, ConnectorNetworkDestination } from "../chat/messages/cards.tsx";
import { useApprovals } from "./approvals-context.tsx";
import { approvalLead, approvalTarget, isPiManagerApproval, piRememberText } from "./card-facts.ts";
import { RiskTag } from "./RiskTag.tsx";
import { useApprovalDeadline } from "./use-approval-deadline.ts";
import { canRemember, desktopOnly } from "./use-approvals.ts";
import { useApprovalSource } from "./where.ts";

const mono = new Set(["program", "read", "write", "cwd"]);
export function ApprovalDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const approvals = useApprovals(),
    router = useRouter(),
    t = useText();
  const approval = approvals.items.find((item) => item.id === id);
  if (!approval)
    return (
      <View style={{ flex: 1 }}>
        <NavBar title={t("approvalBar")} onBack={() => router.back()} />
        <EmptyState icon="inbox" title={t("approvalGone")} />
      </View>
    );
  return <Detail approval={approval} />;
}
/** The card's facts as a two-column list, keys muted (desktop `dl`). */
function Facts({ approval }: { approval: Approval }) {
  const colors = useColors(),
    language = useLanguage(),
    shared = useSharedText();
  const directRun = isDirectRunApproval(approval);
  const facts = approvalText(approval, language).facts.filter(
    (fact) =>
      !directRun ||
      fact.kind !== "warning" ||
      !(
        fact.value === "outside_sandbox" ||
        fact.value === shared("facts.value.outside_sandbox") ||
        /只放行这一次，不会记住$|Allowed this once only, never remembered$/.test(fact.value)
      ),
  );
  const systemTarget = approval.explanation?.some((step) => step.code === "system_service_once")
    ? approval.facts.findLast((fact) => fact.kind === "network")?.value
    : undefined;
  const [advanced, setAdvanced] = useState(false);
  if (!facts.length) return null;
  return (
    <View style={{ marginHorizontal: 16, marginBottom: 12, gap: 6 }}>
      {facts.map((fact) => (
        <View
          key={`${fact.label ?? fact.kind}:${fact.value}`}
          style={{ flexDirection: "row", alignItems: "baseline", gap: 14 }}
        >
          <Text style={{ width: 64, fontSize: 13, lineHeight: 20, color: colors.text2 }}>
            {fact.label ?? shared(`facts.${fact.labelKey ?? fact.kind}`)}
          </Text>
          <Text
            selectable
            style={{
              flex: 1,
              fontSize: mono.has(fact.kind) ? 13 : 14,
              lineHeight: 20,
              color: colors.text,
              fontFamily: mono.has(fact.kind) ? monoFont : undefined,
            }}
          >
            {systemTarget && fact.kind === "network" && fact.value === systemTarget
              ? systemServiceLabel(systemTarget, shared)
              : approvalFactText(fact, shared)}
          </Text>
        </View>
      ))}
      {systemTarget && (
        <>
          <Button
            variant="ghost"
            title={shared("approval.systemServiceDetails")}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced && <CodeBlock text={systemTarget} />}
        </>
      )}
      {!!approval.secretUses?.length && (
        <Text style={{ fontSize: 13, color: colors.text2 }}>
          {shared("approval.tokenInjection")}
        </Text>
      )}
    </View>
  );
}
/** "Why it needs you", amber (red when dangerous), with the policy steps folded. */
function Why({ approval }: { approval: Approval }) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  const [open, setOpen] = useState(false);
  const explanation = approvalExplanation(approval, shared);
  if (!explanation.summary && !explanation.steps.length) return null;
  const fg = approval.risk === "danger" ? colors.danger : colors.warn;
  return (
    <View
      style={{
        marginHorizontal: 16,
        marginBottom: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: radius.code,
        backgroundColor: approval.risk === "danger" ? colors.dangerBg : colors.warnBg,
        gap: 4,
      }}
    >
      {!!explanation.summary && (
        <Text style={{ fontSize: 13, lineHeight: 19, color: fg }}>{explanation.summary}</Text>
      )}
      {explanation.steps.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28 }}
        >
          <Icon name={open ? "chevron" : "chevronRight"} color={fg} size={13} />
          <Text style={[type.caption, { color: fg }]}>{t(open ? "hideSteps" : "showSteps")}</Text>
        </Pressable>
      )}
      {open && (
        // One numbered block: steps can repeat, so they have no stable identity of their own.
        <Text style={{ fontSize: 12.5, lineHeight: 19, color: fg }}>
          {explanation.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}
        </Text>
      )}
    </View>
  );
}
function Detail({ approval }: { approval: Approval }) {
  const colors = useColors(),
    t = useText(),
    language = useLanguage(),
    shared = useSharedText(),
    time = useTimeText(),
    toast = useToast(),
    router = useRouter(),
    navigation = useNavigation(),
    insets = useSafeAreaInsets(),
    mobile = useLinkState(),
    approvals = useApprovals(),
    source = useApprovalSource()(approval);
  const [face, setFace] = useState<"once" | "remember">();
  const deadline = useApprovalDeadline(approval);
  const online = mobile.status === "online";
  const desktop = desktopOnly(approval);
  const disabled = !online || desktop || approvals.action.busy || deadline.expired;
  const firstFact = approvalText(approval, language).facts[0];
  const target = approvalTarget(approval, language, shared);
  const windowsDirectRun = isWindowsDirectRunApproval(approval);
  const remembered = !deadline.paused && canRemember(approval) && !!approvals.remember[approval.id];
  const directRunRemember = deadline.paused ? undefined : approval.directRunRemember;
  const legacyDirectRun =
    approval.directRunRemember === undefined &&
    (approval.explanation?.some((step) => step.code === "outside_sandbox_once") ?? false);
  const decide = async (
    decision: "allow" | "deny",
    allowConversation = false,
    rememberDirectRun = false,
  ) => {
    setFace(undefined);
    const outcome = await approvals.resolve(approval, decision, {
      allowConversation,
      rememberDirectRun,
    });
    if (outcome === undefined) return;
    toast(
      t(
        outcome === "superseded"
          ? "supersededToast"
          : outcome === "allow"
            ? "allowedToast"
            : "deniedToast",
      ),
    );
    // Only while this page is still shown: after a back gesture during the decision, a second
    // back popped the page underneath too (or switched tabs).
    if (navigation.isFocused()) router.back();
  };
  return (
    <PageTint name={source.look?.color}>
      <GlassScope>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <BlurTarget name="approval">
            <NavBar title={t("approvalBar")} subtitle={source.where} onBack={() => router.back()} />
            <ErrorLine text={approvals.action.error && t(approvals.action.error)} />
            <ScrollView
              contentContainerStyle={{
                paddingTop: 12,
                paddingHorizontal: 16,
                // Room for the floating glass bar, so the last line can scroll clear of it.
                paddingBottom: 132 + insets.bottom,
                gap: 14,
              }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}
              >
                {source.look && <BotAvatar bot={source.look} size={28} state="waiting" />}
                <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
                  {source.botName}
                </Text>
                <Text style={{ fontSize: 13, color: colors.text2 }}>
                  {time.ago(approval.createdAt)}
                </Text>
                <RiskTag approval={approval} long />
              </View>
              <ListCard flush danger={approval.risk === "danger"}>
                <ApprovalHeader
                  approval={approval}
                  title={approvalText(approval, language).title}
                />
                {approval.connectorNetworkSite ? (
                  <ConnectorNetworkDestination host={approval.connectorNetworkSite} />
                ) : (
                  <>
                    {!!target && <CodeBlock text={target} />}
                    {!approval.isolation.available &&
                      approval.command &&
                      approval.isolation.reason === "windows_unisolated" && (
                        <Text style={{ marginHorizontal: 16, color: colors.text2 }}>
                          {isolationReasonText(
                            approval.isolation.reason,
                            shared,
                            approval.isolation.windowsYoloConsent,
                          )}
                        </Text>
                      )}
                    {!!approvalLead(approval, language) && (
                      <Text
                        style={{
                          marginHorizontal: 16,
                          fontSize: 13,
                          lineHeight: 19,
                          color: colors.text2,
                        }}
                      >
                        {approvalLead(approval, language)}
                      </Text>
                    )}
                    {isDirectRunApproval(approval) && (
                      <View style={{ marginHorizontal: 16, marginBottom: 12 }}>
                        <SheetText text={shared("facts.value.outside_sandbox")} />
                      </View>
                    )}
                    <Facts approval={approval} />
                    <Why approval={approval} />
                    {canRemember(approval) && !deadline.paused && !desktop ? (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: remembered, disabled }}
                        disabled={disabled}
                        onPress={() =>
                          approvals.setRemember((rows) => ({ ...rows, [approval.id]: !remembered }))
                        }
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 10,
                          paddingVertical: 12,
                          paddingHorizontal: 16,
                          borderTopWidth: 1,
                          borderTopColor: colors.b1,
                          backgroundColor: pressed ? colors.hover : "transparent",
                          opacity: disabled ? 0.5 : 1,
                        })}
                      >
                        <CheckMark on={remembered} />
                        <Text style={{ flex: 1, fontSize: 14, lineHeight: 21, color: colors.text }}>
                          {isPiManagerApproval(approval)
                            ? piRememberText(approval, shared)
                            : approval.grantScope?.kind === "paid_image"
                              ? shared("approval.rememberPaidImage", {
                                  model: `${approval.grantScopeProviderName || approval.grantScope.provider} / ${approval.grantScope.model}`,
                                })
                              : t("remember")}
                        </Text>
                      </Pressable>
                    ) : legacyDirectRun ? (
                      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                        <SheetText text={shared("approval.directRunLegacy")} />
                      </View>
                    ) : directRunRemember ? (
                      <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
                        <SheetText
                          text={shared("approval.directRunRememberHint", directRunRemember)}
                        />
                        <Button
                          title={shared("approval.directRunRemember")}
                          disabled={disabled}
                          onPress={() => setFace("remember")}
                        />
                      </View>
                    ) : (
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          paddingVertical: 12,
                          paddingHorizontal: 16,
                          borderTopWidth: 1,
                          borderTopColor: colors.b1,
                        }}
                      >
                        <Icon name="lock" color={colors.text2} size={16} />
                        <Text style={{ flex: 1, fontSize: 14, color: colors.text2 }}>
                          {t(approval.risk === "danger" ? "rememberDanger" : "rememberNo")}
                        </Text>
                      </View>
                    )}
                  </>
                )}
              </ListCard>
              {(approval.conversationWebDomain || approval.taskWebRead) &&
                !desktop &&
                !deadline.paused && (
                  <>
                    <Text style={{ color: colors.text2 }}>
                      {approval.taskWebRead
                        ? shared("approval.taskWebsiteHint")
                        : shared("approval.conversationWebsiteHint", {
                            domain: approval.conversationWebDomain ?? "",
                          })}
                    </Text>
                    <Button
                      title={shared(
                        approval.taskWebRead
                          ? "approval.allowTaskWeb"
                          : "approval.allowConversation",
                      )}
                      disabled={disabled}
                      onPress={() => void decide("allow", true)}
                    />
                  </>
                )}
              {!online && <OfflineBanner text={t("approvalDetailOffline")} />}
              {desktop && <Banner tone="warn" icon="laptop" text={t("desktopOnly")} />}
              {source.chat && (
                <Button
                  icon="message"
                  title={t("openContext")}
                  style={{ alignSelf: "flex-start" }}
                  onPress={() =>
                    router.push(`/conversation/${source.chat?.kind}/${source.chat?.id}`)
                  }
                />
              )}
            </ScrollView>
          </BlurTarget>
          <ApprovalBar>
            {windowsDirectRun && (
              <Text style={[type.caption, { color: colors.text, paddingBottom: 8 }]}>
                {shared("facts.value.windows_unisolated")}
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button
                size="lg"
                title={t("deny")}
                disabled={disabled}
                style={{ flex: 1 }}
                onPress={() => void decide("deny")}
              />
              <Button
                size="lg"
                variant="prim"
                icon={approval.risk === "danger" ? "face" : undefined}
                title={
                  approval.connectorNetworkSite
                    ? shared("connectors.network.allowRemember")
                    : t(remembered || deadline.paused || legacyDirectRun ? "allow" : "allowOnce")
                }
                disabled={disabled}
                style={{ flex: 1.4 }}
                onPress={() =>
                  approval.risk === "danger" ? setFace("once") : void decide("allow")
                }
              />
            </View>
            <Text
              style={{
                textAlign: "center",
                fontSize: 12,
                color: colors.text2,
                paddingTop: 4,
                fontVariant: ["tabular-nums"],
              }}
            >
              {deadline.label}
            </Text>
          </ApprovalBar>
          <Sheet visible={!!face} onClose={() => setFace(undefined)}>
            <SheetIcon name="face" />
            <SheetTitle center text={t("faceTitle")} />
            <SheetText
              center
              text={
                face === "remember" && directRunRemember
                  ? shared("approval.directRunRememberHint", directRunRemember)
                  : legacyDirectRun
                    ? shared("approval.directRunLegacy")
                    : t("faceHint", { fact: firstFact ? approvalFactText(firstFact, shared) : "" })
              }
            />
            <Button
              size="lg"
              variant="prim"
              title={face === "remember" ? shared("approval.directRunRemember") : t("faceConfirm")}
              disabled={disabled}
              onPress={() => void decide("allow", false, face === "remember")}
            />
            <Button
              size="lg"
              variant="ghost"
              title={t("cancel")}
              onPress={() => setFace(undefined)}
            />
          </Sheet>
        </View>
      </GlassScope>
    </PageTint>
  );
}
/** Deny / allow pinned to the bottom on glass; the details scroll beneath it. */
function ApprovalBar({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets(),
    target = useGlassTarget("approval");
  return (
    <Glass
      radius={24}
      target={target}
      style={{ position: "absolute", left: 10, right: 10, bottom: Math.max(insets.bottom, 10) }}
      innerStyle={{ paddingTop: 10, paddingHorizontal: 14, paddingBottom: 8 }}
    >
      {children}
    </Glass>
  );
}
