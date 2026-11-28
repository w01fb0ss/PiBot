import type { DirectFailure } from "@pibot/link";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import Svg, { Line } from "react-native-svg";
import { useText } from "../../runtime/context.tsx";
import { useReducedMotion } from "../../theme/motion.ts";
import { radius, type } from "../../theme/scale.ts";
import { monoFont, useColors } from "../../theme/use-theme.ts";
import type { Computer } from "../../transport/link-port.ts";
import { Button } from "../../ui/controls.tsx";
import { Icon, type IconName } from "../../ui/icons.tsx";
import { useTimeText } from "../../ui/time.ts";

const DASH = 10,
  GAP = 14;
/** A looping 0→1 value that stands still (at 0) under reduce motion or when `on` is false. */
function useLoop(on: boolean, duration: number) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  const run = on && !reduced;
  useEffect(() => {
    value.setValue(0);
    if (!run) return;
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [run, duration, value]);
  return value;
}
function DeviceTile({ icon }: { icon: IconName }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: 46,
        height: 46,
        borderRadius: 14,
        backgroundColor: colors.tert,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={colors.text} size={22} />
    </View>
  );
}
/** The dashed wire between phone and computer; its dashes flow while the link is up. */
function Wire({ live, color }: { live: boolean; color: string }) {
  const progress = useLoop(live, 1000);
  const shift = progress.interpolate({ inputRange: [0, 1], outputRange: [-(DASH + GAP), 0] });
  return (
    <View style={{ flex: 1, height: 4, overflow: "hidden", borderRadius: 2 }}>
      <Animated.View
        style={{ position: "absolute", left: 0, right: -(DASH + GAP), top: 0, bottom: 0 }}
      >
        <Animated.View style={{ flex: 1, transform: [{ translateX: shift }] }}>
          <Svg width="100%" height={4}>
            <Line
              x1="0"
              y1="2"
              x2="100%"
              y2="2"
              stroke={color}
              strokeWidth={4}
              strokeDasharray={`${DASH} ${GAP}`}
            />
          </Svg>
        </Animated.View>
      </Animated.View>
    </View>
  );
}
function StatusDot({ color, live }: { color: string; live: boolean }) {
  const progress = useLoop(live, 1600);
  const scale = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.3, 1] });
  const opacity = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.6, 1] });
  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        transform: [{ scale }],
        opacity,
      }}
    />
  );
}
const connectionErrors = ["room_empty", "session_timeout", "relay_unavailable", "handshake_failed"];
/**
 * 「手机 ⟷ 电脑」: the two devices joined by a wire that flows while connected (green dot
 * breathing), grey when offline; how they are linked, the computer, and the safety code.
 */
export function LinkCard({
  computer,
  status,
  reconnecting,
  path,
  pathKind,
  directFailure,
  error,
  lastSeen,
  reconnect,
  busy,
}: {
  computer: Computer;
  status: string;
  reconnecting?: boolean;
  path?: "direct" | "relay" | "lan";
  pathKind?: "lan" | "punched";
  directFailure?: DirectFailure;
  error?: string;
  lastSeen?: number;
  reconnect(): void;
  busy: boolean;
}) {
  const colors = useColors(),
    t = useText(),
    time = useTimeText();
  const [showConnection, setShowConnection] = useState(false);
  const online = status === "online";
  const viaRelay = online && path !== "direct" && path !== "lan";
  const connecting = status === "connecting";
  // Offline while the session keeps retrying quietly (not paused in the background).
  const away = status === "offline" && error !== "unavailable";
  const color = online ? colors.ok : connecting ? colors.text2 : colors.b3;
  const state = online
    ? t("linkConnected")
    : connecting
      ? t(reconnecting ? "reconnecting" : "linkConnecting")
      : t("linkOffline");
  const how = online
    ? t(
        path === "lan" || (path === "direct" && pathKind === "lan")
          ? "pathLan"
          : path === "direct"
            ? pathKind === "punched"
              ? "pathTunnel"
              : "pathDirect"
            : "pathRelay",
      )
    : !connecting && lastSeen
      ? t("linkLastSeen", { time: time.ago(new Date(lastSeen).toISOString()) })
      : "";
  const connectionError =
    error && !online ? (connectionErrors.includes(error) ? error : "connection_failed") : undefined;
  const code = `${computer.safetyCode.slice(0, 3)} ${computer.safetyCode.slice(3)}`;
  const line = [type.caption, { color: colors.text2 }];
  return (
    <View
      style={{
        marginHorizontal: 16,
        borderRadius: radius.panel + 2,
        padding: 16,
        gap: 10,
        backgroundColor: colors.card,
        boxShadow: colors["shadow-soft"],
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        <DeviceTile icon="phone" />
        <Wire live={online} color={color} />
        <DeviceTile icon="laptop" />
      </View>
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <StatusDot color={online ? colors.ok : colors.warn} live={online} />
          <Text
            style={[type.caption, { color: online ? colors.ok : colors.warn, fontWeight: "600" }]}
          >
            {state}
          </Text>
          {viaRelay ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showConnection }}
              hitSlop={8}
              onPress={() => setShowConnection(!showConnection)}
            >
              <Text style={[...line, { textDecorationLine: "underline" }]}>{how}</Text>
            </Pressable>
          ) : (
            !!how && <Text style={line}>{`· ${how}`}</Text>
          )}
        </View>
        <Text numberOfLines={1} style={line}>
          {computer.name}
        </Text>
      </View>
      {online && !viaRelay && <Text style={line}>{t("pathDirectHint")}</Text>}
      {viaRelay && showConnection && (
        <Text style={line}>
          {t("pathRelayHint")}
          {directFailure ? ` ${t("directFallback")}` : ""}
        </Text>
      )}
      {away && <Text style={line}>{t("linkRetryQuiet")}</Text>}
      {connectionError && (
        <Text accessibilityRole="alert" style={[type.caption, { color: colors.warn }]}>
          {t(connectionError as Parameters<typeof t>[0])}
        </Text>
      )}
      {!online && !connecting && (
        <Button title={t("reconnectNow")} disabled={busy} onPress={reconnect} />
      )}
      <View
        accessible
        accessibilityLabel={`${t("code")} ${code}. ${t("codeHint")}`}
        style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}
      >
        <Text style={[type.caption, { color: colors.text }]}>
          {`${t("code")} `}
          <Text style={{ fontFamily: monoFont, letterSpacing: 1.2 }}>{code}</Text>
        </Text>
        <Text style={[line, { flexShrink: 1 }]}>{t("codeHint")}</Text>
      </View>
    </View>
  );
}
