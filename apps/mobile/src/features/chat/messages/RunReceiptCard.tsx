import {
  groupExecutionText,
  type ReceiptTone,
  receiptChips,
  receiptSections,
} from "@pibot/client-core";
import { GroupExecutionReceiptSchema, type Message, Methods } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRuntime, useSharedText, useText } from "../../../runtime/context.tsx";
import { useCachedValue } from "../../../runtime/use-cached-value.ts";
import { monoFont, useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard } from "../../../ui/controls.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { useRecords } from "../../records/records-context.tsx";
import type { Caller } from "../controls/scope.ts";

import { RelaxationDetails } from "./RelaxationDetails.tsx";

const SHOWN_UNVERIFIED = 3;
/** Plan completion messages have no model run and therefore no runs.receipt lookup. */
export function GroupExecutionMessageFact({ message }: { message: Message }) {
  const t = useSharedText();
  const colors = useColors();
  const parsed = GroupExecutionReceiptSchema.safeParse(
    !message.runId &&
      message.role === "assistant" &&
      message.status === "done" &&
      message.usage &&
      typeof message.usage === "object" &&
      !Array.isArray(message.usage)
      ? message.usage.groupExecution
      : undefined,
  );
  return parsed.success ? (
    <View>
      <Text style={{ fontSize: 12.5, color: colors.text2 }}>
        {groupExecutionText(parsed.data, t)}
      </Text>
      {parsed.data.kind === "plan" && !!parsed.data.relaxations?.length && (
        <RelaxationDetails items={parsed.data.relaxations} />
      )}
    </View>
  ) : null;
}
const ReceiptSchema = Methods["runs.receipt"].result;
export function readRunReceipt(c: Caller, runId: string, signal?: AbortSignal) {
  return c.call("runs.receipt", { runId }, signal, 30_000);
}
/** A reply whose run has ended: the only replies that carry a receipt. */
export function settledRun(message: Message): message is Message & { runId: string } {
  return message.role === "assistant" && message.status !== "streaming" && !!message.runId;
}
function useToneColor() {
  const colors = useColors();
  return (tone: ReceiptTone | undefined) =>
    tone === "danger"
      ? colors.danger
      : tone === "warn"
        ? colors.warn
        : tone === "ok"
          ? colors.ok
          : colors.text2;
}

export function RunRecordsLink({ runId }: { runId: string | null }) {
  const router = useRouter();
  const t = useText();
  const { rows } = useRecords();
  const record = rows.find((row) => row.type === "chat" && row.run.id === runId);
  return (
    <Button
      variant="ghost"
      title={t(record ? "viewRunRecord" : "viewRecords")}
      onPress={() =>
        router.push(record ? { pathname: "/record", params: { id: record.id } } : "/records")
      }
    />
  );
}

/**
 * Work receipt under a reply or in task detail, as on the desktop: chips that expand into
 * sections, unverified items listed up front. Cached per run, so it also shows offline.
 * `embedded` draws it as the footer of the run's changed-files card (one card per reply).
 */
export function RunReceiptCard({
  runId,
  messageId,
  embedded = false,
}: {
  runId: string;
  messageId?: string;
  embedded?: boolean;
}) {
  const runtime = useRuntime(),
    colors = useColors(),
    tone = useToneColor(),
    t = useSharedText();
  const [open, setOpen] = useState(false);
  const receipt = useCachedValue(`receipt:${runId}`, ReceiptSchema, (signal) =>
    readRunReceipt(runtime, runId, signal),
  );
  const data = receipt.value;
  if (!data || data.outcome === "running" || (messageId && data.messageId !== messageId))
    return null;
  const chips = receiptChips(data, t);
  const body = (
    <View style={{ paddingTop: 8, paddingHorizontal: 14, paddingBottom: 10, gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={t("receipt.title")}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 28 }}
      >
        <Icon name="audit" color={colors.text2} size={15} />
        <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", columnGap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
            {t("receipt.title")}
          </Text>
          {chips.map((chip) => (
            <Text key={chip.id} style={{ fontSize: 13, color: tone(chip.tone) }}>
              {chip.text}
            </Text>
          ))}
        </View>
        <Text style={{ fontSize: 13, color: colors.accent }}>
          {t(open ? "receipt.hide" : "receipt.details")}
        </Text>
      </Pressable>
      {data.groupExecution?.kind === "plan" && !!data.groupExecution.relaxations?.length && (
        <RelaxationDetails items={data.groupExecution.relaxations} />
      )}
      {!open &&
        data.unverified.items.slice(0, SHOWN_UNVERIFIED).map((item) => (
          <View key={item.label} style={{ flexDirection: "row", gap: 6 }}>
            <Icon name="warning" color={colors.warn} size={14} />
            <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{item.label}</Text>
          </View>
        ))}
      {!open && data.unverified.total > SHOWN_UNVERIFIED && (
        <Text style={{ fontSize: 12.5, color: colors.text2, paddingLeft: 20 }}>
          {t("receipt.unverified.more", { count: data.unverified.total - SHOWN_UNVERIFIED })}
        </Text>
      )}
      {open &&
        receiptSections(data, t, { files: !embedded }).map((section) => (
          <View key={section.id} style={{ gap: 3, paddingTop: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: colors.text2 }}>
              {section.title}
            </Text>
            {section.rows.length ? (
              section.rows.map((row) => (
                <View key={row.key} style={{ flexDirection: "row", gap: 10 }}>
                  {!!row.label && (
                    <Text style={{ width: 112, fontSize: 13, color: tone(row.tone) }}>
                      {row.label}
                    </Text>
                  )}
                  <Text
                    selectable
                    style={{
                      flex: 1,
                      fontSize: 13,
                      color:
                        row.tone === "warn" || row.tone === "danger" ? tone(row.tone) : colors.text,
                      ...(row.code ? { fontFamily: monoFont, fontSize: 12 } : {}),
                    }}
                  >
                    {row.value}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={{ fontSize: 13, color: colors.text2 }}>{section.empty}</Text>
            )}
          </View>
        ))}
      {open && data.outcome === "failed" && <RunRecordsLink runId={runId} />}
      {open && (
        <Text style={{ fontSize: 12, color: colors.text2, paddingTop: 4 }}>
          {t("receipt.footnote")}
        </Text>
      )}
    </View>
  );
  if (embedded) return <View style={{ borderTopWidth: 1, borderTopColor: colors.b1 }}>{body}</View>;
  return (
    <ListCard flush raised>
      {body}
    </ListCard>
  );
}
