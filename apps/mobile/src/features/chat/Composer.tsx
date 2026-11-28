import type { Bot } from "@pibot/protocol";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useText } from "../../runtime/context.tsx";
import { usePageTint } from "../../theme/page-tint.tsx";
import { cardShadow, popShadow, radius } from "../../theme/scale.ts";
import { tintOf, withAlpha } from "../../theme/tint.ts";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { Icon, type IconName, StopGlyph } from "../../ui/icons.tsx";
import { botLook } from "../conversations/model.ts";

function Round({
  label,
  icon,
  prim,
  disabled,
  onPress,
  children,
}: {
  label: string;
  icon?: IconName;
  prim?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  const colors = useColors(),
    tone = tintOf(colors, usePageTint());
  // Send and stop are solid in the page colour.
  const fg = prim ? tone.onFill : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 38,
        height: 38,
        borderRadius: 19,
        backgroundColor: prim ? tone.fill : pressed ? colors.hover : "transparent",
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.35 : 1,
      })}
    >
      {icon ? <Icon name={icon} color={fg} size={20} strokeWidth={prim ? 2 : 1.7} /> : children}
    </Pressable>
  );
}
/**
 * The desktop Combobox popover of group members, just above the composer. It stays in the
 * layout instead of floating over the thread: Android delivers no touches outside a parent.
 */
function MentionList({ bots, onPick }: { bots: readonly Bot[]; onPick?: (bot: Bot) => void }) {
  const colors = useColors(),
    t = useText();
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={t("mentionList")}
      style={[
        {
          marginBottom: 8,
          padding: 6,
          borderWidth: 1,
          borderColor: colors.b2,
          borderRadius: radius.row,
          backgroundColor: colors.card,
        },
        popShadow(colors),
      ]}
    >
      <Text
        style={{
          paddingTop: 4,
          paddingHorizontal: 10,
          paddingBottom: 6,
          fontSize: 12,
          color: colors.text2,
        }}
      >
        {t("mentionTitle")}
      </Text>
      {bots.map((bot, index) => (
        <Pressable
          key={bot.id}
          accessibilityRole="button"
          accessibilityLabel={t("mentionPick", { name: bot.name })}
          onPress={() => onPick?.(bot)}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            minHeight: 48,
            paddingVertical: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            // The first match is what a hardware Enter would pick, as on the desktop.
            backgroundColor: pressed || index === 0 ? colors.hover : "transparent",
          })}
        >
          <BotAvatar bot={botLook(bot)} size={28} />
          <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }} numberOfLines={1}>
            {bot.name}
          </Text>
          {!!bot.description && (
            <Text
              numberOfLines={1}
              style={{ flex: 1, textAlign: "right", fontSize: 12.5, color: colors.text2 }}
            >
              {bot.description}
            </Text>
          )}
        </Pressable>
      ))}
    </View>
  );
}
/**
 * The desktop composer pill: "+" menu, text, send mode (or "Fill in" for the next-reply
 * suggestion shown as the placeholder), and send that turns into stop while a reply runs.
 * Attached files sit above the pill, like the @ list.
 */
export function Composer({
  text,
  onChangeText,
  placeholder,
  modeLabel,
  running,
  sending,
  stopping,
  onPlus,
  onMode,
  onSend,
  onStop,
  onCaret,
  mentions = [],
  onMention,
  suggestion,
  tray,
  attached = false,
}: {
  text: string;
  /** Attached files above the input. */
  tray?: ReactNode;
  /** Files are attached: send works without text, and send never turns into stop. */
  attached?: boolean;
  onChangeText: (value: string) => void;
  onCaret?: (caret: number) => void;
  /** Group @ list for the `@query` before the caret. */
  mentions?: readonly Bot[];
  onMention?: (bot: Bot) => void;
  placeholder: string;
  modeLabel: string;
  running: boolean;
  sending: boolean;
  stopping: boolean;
  onPlus: () => void;
  onMode: () => void;
  onSend: () => void;
  onStop: () => void;
  /** The next-reply suggestion: its text becomes the placeholder; "Fill in" accepts it. */
  suggestion?: { text: string; label: string; onAccept: () => void };
}) {
  const colors = useColors(),
    t = useText(),
    insets = useSafeAreaInsets(),
    tone = tintOf(colors, usePageTint());
  const empty = !text.trim() && !attached;
  const suggestionPreview = !text && suggestion?.text;
  const inputText = {
    paddingHorizontal: 4,
    paddingVertical: 8,
    fontSize: 16,
    lineHeight: 22,
  };
  return (
    <View
      style={{
        paddingTop: 6,
        paddingHorizontal: 12,
        paddingBottom: Math.max(insets.bottom, 8),
        backgroundColor: colors.bg,
      }}
    >
      {mentions.length > 0 && <MentionList bots={mentions} onPick={onMention} />}
      {tray}
      <View
        style={[
          {
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 4,
            minHeight: 50,
            paddingVertical: 5,
            paddingLeft: 6,
            paddingRight: 5,
            // The input's rim is tinted with the Bot's colour.
            borderWidth: 1.5,
            borderColor: withAlpha(tone.wash, 0.45),
            borderRadius: radius.composer,
            backgroundColor: colors.card,
          },
          cardShadow(colors),
        ]}
      >
        <Round label={t("moreActions")} icon="plus" onPress={onPlus} />
        <View style={{ flex: 1, minWidth: 0 }}>
          {/* Android measures a multiline native hint as an empty input. Let the visible
              suggestion size the field so partial lines cannot be cut off by the pill. */}
          {!!suggestionPreview && (
            <Text accessible={false} numberOfLines={3} style={[inputText, { color: colors.text2 }]}>
              {suggestionPreview}
            </Text>
          )}
          <TextInput
            value={text}
            onChangeText={onChangeText}
            onSelectionChange={(event) => onCaret?.(event.nativeEvent.selection.end)}
            multiline
            maxLength={8000}
            placeholder={suggestionPreview ? undefined : placeholder}
            placeholderTextColor={colors.text2}
            accessibilityLabel={placeholder}
            style={[
              inputText,
              { minHeight: 38, maxHeight: 110, color: colors.text },
              suggestionPreview ? StyleSheet.absoluteFill : undefined,
            ]}
          />
        </View>
        {suggestion ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={suggestion.label}
            onPress={suggestion.onAccept}
            style={({ pressed }) => ({
              alignSelf: "center",
              height: 24,
              paddingHorizontal: 7,
              borderWidth: 1,
              borderColor: colors.b2,
              borderRadius: 6,
              justifyContent: "center",
              backgroundColor: pressed ? colors.hover : "transparent",
            })}
          >
            <Text style={{ fontSize: 12, color: colors.text2 }}>{t("suggestFill")}</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={modeLabel}
            onPress={onMode}
            style={({ pressed }) => ({
              height: 38,
              flexDirection: "row",
              alignItems: "center",
              gap: 2,
              paddingLeft: 8,
              paddingRight: 6,
              borderRadius: 19,
              backgroundColor: pressed ? colors.hover : "transparent",
            })}
          >
            <Text style={{ fontSize: 13, color: colors.text2 }}>{modeLabel}</Text>
            <Icon name="chevron" color={colors.text2} size={13} />
          </Pressable>
        )}
        {running && empty ? (
          <Round label={t("stop")} prim disabled={stopping} onPress={onStop}>
            <StopGlyph color={tone.onFill} />
          </Round>
        ) : (
          <Round label={t("send")} icon="up" prim disabled={empty || sending} onPress={onSend} />
        )}
      </View>
    </View>
  );
}
