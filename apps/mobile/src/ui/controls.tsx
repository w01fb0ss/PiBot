import { type ReactNode, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { usePageTint } from "../theme/page-tint.tsx";
import { cardShadow, radius, slopFor, space, type } from "../theme/scale.ts";
import { type Tint, tintOf } from "../theme/tint.ts";
import { type Colors, useColors } from "../theme/use-theme.ts";
import { Icon, type IconName } from "./icons.tsx";

// Buttons and controls of packages/ui components.module.css at touch sizes (design mapping):
// primary / secondary 44, pill 36 (touch area widened to 44), switch 42×26, segments 36.
export type ButtonVariant = "default" | "prim" | "ghost" | "danger" | "dangerFill";
const heights = { small: 36, lg: 44 } as const;
function buttonTone(colors: Colors, variant: ButtonVariant, lg: boolean, tint: Tint) {
  // Maintainers 2026-11-12: primary buttons take the page colour; the deepened fill keeps its
  // paired text colour readable in both themes.
  if (variant === "prim") return { bg: tint.fill, fg: tint.onFill, border: tint.fill };
  if (variant === "dangerFill")
    return { bg: colors.danger, fg: colors.onUser, border: colors.danger };
  if (variant === "ghost") return { bg: "transparent", fg: colors.text, border: "transparent" };
  // Secondary at full size has the strong border; pills the regular one, as on the desktop.
  const border = lg ? colors.b3 : colors.b2;
  return { bg: colors.card, fg: variant === "danger" ? colors.danger : colors.text, border };
}
/** Hover tint over any fill while pressed (the desktop's inset hover shadow). */
function PressTint({ pressed }: { pressed: boolean }) {
  const colors = useColors();
  if (!pressed) return null;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: colors.hover,
      }}
    />
  );
}
export function Button({
  title,
  onPress,
  variant = "default",
  size = "small",
  icon,
  disabled,
  wrapTitle = false,
  style,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** `small` is the desktop pill; `lg` the full-size primary / secondary button. */
  size?: keyof typeof heights;
  icon?: IconName;
  disabled?: boolean;
  wrapTitle?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors(),
    pageTint = tintOf(colors, usePageTint());
  const lg = size === "lg";
  const tone = buttonTone(colors, variant, lg, pageTint);
  const strong = variant === "prim" || variant === "dangerFill" || (lg && variant !== "ghost");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={lg ? undefined : slopFor(heights.small)}
      style={[
        {
          minHeight: heights[size],
          paddingHorizontal: lg ? 20 : 14,
          borderRadius: radius.pill,
          backgroundColor: tone.bg,
          borderWidth: 1,
          borderColor: tone.border,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: lg ? 8 : 6,
          overflow: "hidden",
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {({ pressed }) => (
        <>
          <PressTint pressed={pressed && !disabled} />
          {icon && <Icon name={icon} color={tone.fg} size={lg ? 18 : 15} />}
          <Text
            numberOfLines={wrapTitle ? undefined : 1}
            style={[
              lg ? type.button : type.pill,
              { color: tone.fg, fontWeight: strong ? "600" : "500" },
              wrapTitle && { flexShrink: 1, textAlign: "center" },
            ]}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}
/**
 * Control-strip chip (desktop chat strip): hover fill; `hot` marks a removed safeguard (YOLO on),
 * `live` something running on the computer right now (the Bot browser in use).
 */
export function Chip({
  label,
  icon,
  trailing,
  hot,
  live,
  disabled,
  onPress,
}: {
  label: string;
  icon?: IconName;
  trailing?: IconName;
  hot?: boolean;
  live?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const colors = useColors();
  const fg = hot ? colors.warn : live ? colors.accent : colors.text;
  const bg = hot ? colors.warnBg : live ? colors.accentBg : colors.hover;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={slopFor(32)}
      style={{
        height: 32,
        flexShrink: 0,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        backgroundColor: bg,
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        overflow: "hidden",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {({ pressed }) => (
        <>
          <PressTint pressed={pressed} />
          {icon && <Icon name={icon} color={fg} size={15} />}
          <Text
            numberOfLines={1}
            style={[type.chip, { color: fg, fontWeight: hot || live ? "600" : "400" }]}
          >
            {label}
          </Text>
          {trailing && <Icon name={trailing} color={fg} size={13} />}
        </>
      )}
    </Pressable>
  );
}
export type StateKind = "run" | "wait" | "fail" | "done" | "paused";
export function stateColor(colors: Colors, kind: StateKind) {
  return {
    run: colors.accent,
    wait: colors.warn,
    fail: colors.danger,
    done: colors.ok,
    paused: colors.text2,
  }[kind];
}
/** Task-panel status: a coloured dot and the word in the same colour, never a filled tag. */
export function StateTag({ kind, label }: { kind: StateKind; label: string }) {
  const colors = useColors();
  const color = stateColor(colors, kind);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={[type.caption, { color }]}>{label}</Text>
    </View>
  );
}
/** The sidebar's unread mark: a 7pt blue dot after the name (never a red count). */
export function UnreadDot({ label }: { label?: string }) {
  const colors = useColors();
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.accent }}
    />
  );
}
/**
 * Tab-bar marks, ringed in the page colour: a count is the brand-violet pill of the desktop's
 * "waiting for you" dot; without a count it is the blue unread dot.
 */
export function Badge({ count, style }: { count?: number; style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const dot = !count;
  return (
    <View
      style={[
        {
          position: "absolute",
          minWidth: dot ? 11 : 22,
          height: dot ? 11 : 22,
          paddingHorizontal: dot ? 0 : 5,
          borderRadius: 11,
          backgroundColor: dot ? colors.accent : colors.brand,
          borderWidth: 2,
          borderColor: colors.bg,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      {!dot && (
        <Text
          style={{
            color: colors["avatar-eye"],
            fontSize: 11,
            lineHeight: 14,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
          }}
        >
          {count > 99 ? "99+" : count}
        </Text>
      )}
    </View>
  );
}
export type BannerTone = "plain" | "warn" | "danger" | "accent";
/** Notice strip: `tert` by default, tinted for warnings, errors and progress; radius 12. */
export function Banner({
  text,
  tone = "plain",
  icon = "clock",
  action,
  singleLine,
}: {
  text: string;
  tone?: BannerTone;
  icon?: IconName | "spinner";
  /** One short text action at the end of the line (e.g. "Download"). */
  singleLine?: boolean;
  action?: { title: string; onPress: () => void };
}) {
  const colors = useColors();
  const { fg, bg } = {
    plain: { fg: colors.text2, bg: colors.tert },
    warn: { fg: colors.warn, bg: colors.warnBg },
    danger: { fg: colors.danger, bg: colors.dangerBg },
    accent: { fg: colors.accent, bg: colors.accentBg },
  }[tone];
  return (
    <View
      style={{
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: radius.row,
        backgroundColor: bg,
        flexDirection: "row",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <View style={{ marginTop: 1 }}>
        {icon === "spinner" ? (
          <ActivityIndicator size="small" color={fg} style={{ transform: [{ scale: 0.75 }] }} />
        ) : (
          <Icon name={icon} color={fg} size={16} />
        )}
      </View>
      <Text
        numberOfLines={singleLine ? 1 : undefined}
        style={[type.caption, { color: fg, flex: 1 }]}
      >
        {text}
      </Text>
      {action && (
        <Pressable accessibilityRole="button" hitSlop={slopFor(20)} onPress={action.onPress}>
          <Text style={[type.caption, { color: fg, fontWeight: "600" }]}>{action.title}</Text>
        </Pressable>
      )}
    </View>
  );
}
/** The desktop switch: `prim` track when on (not green), knob with the card shadow. */
export function Switch({
  value,
  onValueChange,
  disabled,
  label,
}: {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const colors = useColors();
  const offset = useRef(new Animated.Value(value ? 16 : 0)).current;
  useEffect(() => {
    Animated.timing(offset, {
      toValue: value ? 16 : 0,
      duration: 150,
      useNativeDriver: true,
    }).start();
  }, [value, offset]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      hitSlop={slopFor(26)}
      onPress={() => onValueChange?.(!value)}
      style={{
        width: 42,
        height: 26,
        borderRadius: 13,
        padding: 3,
        backgroundColor: value ? colors.prim : colors.b2,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Animated.View
        style={[
          {
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: value ? colors["switch-knob-on"] : colors["switch-knob"],
            transform: [{ translateX: offset }],
          },
          cardShadow(colors),
        ]}
      />
    </Pressable>
  );
}
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Shown after the label, e.g. the unlock mark on an option that widens a permission. */
  icon?: IconName;
}
/** Desktop segmented control: `hover` track, the chosen segment on `card` with the shadow. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly SegmentOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        gap: 3,
        padding: 3,
        borderRadius: radius.pill,
        backgroundColor: colors.hover,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: !!disabled }}
            disabled={disabled}
            onPress={() => {
              if (!on) onChange(option.value);
            }}
            style={[
              {
                flex: 1,
                minHeight: 36,
                paddingHorizontal: 12,
                borderRadius: radius.pill,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                backgroundColor: on ? colors.card : "transparent",
              },
              on && cardShadow(colors),
            ]}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: 14,
                lineHeight: 19,
                color: colors.text,
                fontWeight: on ? "600" : "400",
              }}
            >
              {option.label}
            </Text>
            {option.icon && <Icon name={option.icon} color={colors.text2} size={14} />}
          </Pressable>
        );
      })}
    </View>
  );
}
export function SectionTitle({ title, right }: { title: string; right?: ReactNode }) {
  const colors = useColors();
  return (
    <View
      style={{
        paddingTop: 18,
        paddingHorizontal: 20,
        paddingBottom: 8,
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Text accessibilityRole="header" style={[type.section, { color: colors.text2 }]}>
        {title}
      </Text>
      {right}
    </View>
  );
}
/** Margins place the card; everything else lays out its rows inside the clipped panel. */
function splitCardStyle(style: StyleProp<ViewStyle>) {
  const outer: ViewStyle = {},
    inner: ViewStyle = {};
  for (const [key, value] of Object.entries(StyleSheet.flatten(style) ?? {}))
    Object.assign(key.startsWith("margin") ? outer : inner, { [key]: value });
  return { outer, inner };
}
/**
 * The card holding rows: no outline, radius 20, the soft shadow; rows are divided by `b1`
 * lines. The shadow sits on a wrapper because a view that clips its children clips its own
 * shadow on iOS. `raised` is kept for the chat cards, which now share the same look.
 */
export function ListCard({
  children,
  flush,
  danger,
  style,
}: {
  children: ReactNode;
  flush?: boolean;
  raised?: boolean;
  /** A dangerous request's card: red border, as on the desktop. */
  danger?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const { outer, inner } = splitCardStyle(style);
  return (
    <View
      style={[
        { marginHorizontal: flush ? 0 : space.page, borderRadius: radius.panel },
        { boxShadow: colors["shadow-soft"] },
        outer,
      ]}
    >
      <View
        style={[
          {
            borderRadius: radius.panel,
            backgroundColor: colors.card,
            overflow: "hidden",
          },
          danger && { borderWidth: 1, borderColor: colors.danger },
          inner,
        ]}
      >
        {children}
      </View>
    </View>
  );
}
export function Separator() {
  const colors = useColors();
  return <View style={{ height: 1, backgroundColor: colors.b1 }} />;
}
/** Centred small print under a page or a card group. */
export function FootNote({ text }: { text: string }) {
  const colors = useColors();
  return (
    <Text
      style={{
        textAlign: "center",
        fontSize: 12,
        lineHeight: 19,
        color: colors.text2,
        paddingTop: 18,
        paddingHorizontal: 28,
        paddingBottom: 24,
      }}
    >
      {text}
    </Text>
  );
}
export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: IconName;
  title: string;
  hint?: string;
}) {
  const colors = useColors();
  return (
    <View style={{ alignItems: "center", gap: 8, paddingVertical: 72, paddingHorizontal: 32 }}>
      <Icon name={icon} color={colors.text2} size={40} strokeWidth={1.4} />
      <Text style={[type.emptyTitle, { color: colors.text, textAlign: "center" }]}>{title}</Text>
      {!!hint && (
        <Text style={{ color: colors.text2, fontSize: 14, lineHeight: 21, textAlign: "center" }}>
          {hint}
        </Text>
      )}
    </View>
  );
}
export function ErrorLine({ text }: { text?: string }) {
  const colors = useColors();
  if (!text) return null;
  return (
    <Text
      accessibilityRole="alert"
      style={[type.caption, { color: colors.danger, paddingHorizontal: 16, paddingVertical: 6 }]}
    >
      {text}
    </Text>
  );
}
/** Round check of the pickers: filled with the page colour and a white tick when chosen. */
export function CheckMark({ on }: { on: boolean }) {
  const colors = useColors(),
    tone = tintOf(colors, usePageTint());
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: on ? tone.fill : colors.b3,
        backgroundColor: on ? tone.fill : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on && <Icon name="check" color={tone.onFill} size={13} strokeWidth={2.4} />}
    </View>
  );
}
/** The sidebar search box: a borderless `card` pill-box with the soft shadow. */
export function SearchField({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        height: 40,
        marginHorizontal: space.page,
        marginTop: 2,
        marginBottom: 10,
        paddingHorizontal: 12,
        borderRadius: radius.soft,
        boxShadow: colors["shadow-soft"],
        backgroundColor: colors.card,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
      }}
    >
      <Icon name="search" color={colors.text2} size={17} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text2}
        accessibilityLabel={placeholder}
        style={{ flex: 1, color: colors.text, fontSize: 15, paddingVertical: 0 }}
      />
    </View>
  );
}
/** Desktop text field: a pill with a `b2` border; multi-line drafts get the card radius. */
export function Field({
  multiline,
  style,
  ...props
}: TextInputProps & { style?: StyleProp<TextStyle> }) {
  const colors = useColors();
  return (
    <TextInput
      placeholderTextColor={colors.text2}
      multiline={multiline}
      {...props}
      style={[
        {
          minHeight: multiline ? 120 : 44,
          paddingHorizontal: multiline ? 14 : 16,
          paddingVertical: multiline ? 12 : 0,
          borderWidth: 1,
          borderColor: colors.b2,
          borderRadius: multiline ? radius.card : radius.pill,
          backgroundColor: colors.card,
          color: props.editable === false ? colors.text2 : colors.text,
          fontSize: multiline ? 15 : 16,
          lineHeight: multiline ? 23 : undefined,
          textAlignVertical: multiline ? "top" : "center",
        },
        style,
      ]}
    />
  );
}
