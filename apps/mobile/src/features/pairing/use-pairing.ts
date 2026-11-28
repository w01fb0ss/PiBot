import { useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useFocusEffect, useIsFocused, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState, BackHandler } from "react-native";
import { useRuntime, useText } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import type { Computer } from "../../transport/link-port.ts";

/** The name the computer lists this phone under: the system device name when it is usable. */
function phoneName(fallback: string) {
  const name = (Device.deviceName ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 80);
  return name || fallback;
}
const pairingFailures = {
  invalid: "pairInvalid",
  invalid_pairing: "pairInvalid",
  invalid_encoding: "pairInvalid",
  invalid_relay: "pairInvalid",
  pair_expired: "pairExpired",
  pairing_expired: "pairExpired",
  relay_unavailable: "pairNetwork",
  remote_room_empty: "pairWaiting",
  remote_session_timeout: "pairWaiting",
  handshake_failed: "pairIdentityFailed",
  identity_mismatch: "pairIdentityFailed",
  invalid_identity: "pairIdentityFailed",
  pair_cancelled: "pairWaiting",
} as const;
export function usePairing() {
  const router = useRouter(),
    navigation = useNavigation();
  const runtime = useRuntime(),
    t = useText(),
    // Pairing belongs to no computer's link: saving it switches the selected computer, and an
    // action owned by that link was cancelled mid-save, so the page never moved on.
    action = useAction("pairing");
  const [permission, requestPermission, getPermission] = useCameraPermissions(),
    [qr, setQr] = useState(""),
    [name] = useState(() => phoneName(t("phone")));
  const [candidate, setCandidate] = useState<Computer>(),
    [pasting, setPasting] = useState(false);
  const focused = useIsFocused();
  // The camera follows the app's own foreground state. The link status stayed "suspended" after
  // the permission dialog backgrounded the app, because an unpaired phone has nothing to resume,
  // so the camera only started on the next launch.
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
      if (state === "active")
        void getPermission().catch(() => {
          // The existing camera permission state still offers a way to continue by pasting.
        });
    });
    return () => subscription.remove();
  }, [getPermission]);
  useEffect(() => () => runtime.cancelPair(), [runtime]);
  const pair = (code: string) =>
    action.run(async (signal) => {
      try {
        const value = await runtime.preparePair(code.trim(), name);
        signal.throwIfAborted();
        setQr("");
        setCandidate(value);
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof Error ? error.message : "";
        action.setError(
          Object.hasOwn(pairingFailures, reason)
            ? pairingFailures[reason as keyof typeof pairingFailures]
            : "pairTryAgain",
        );
      }
    });
  const cancel = () => {
    runtime.cancelPair();
    setCandidate(undefined);
    setQr("");
    action.setError(undefined);
  };
  // The code check is a step of this page: Android back returns to scanning, as "the code does
  // not match" does, instead of leaving (or, on a first pairing, closing the app) mid-pairing.
  // While the pairing is saved back waits, like that button.
  const checking = !!candidate,
    saving = action.busy;
  useFocusEffect(
    // biome-ignore lint/correctness/useExhaustiveDependencies: cancel only touches the runtime and state setters.
    useCallback(() => {
      if (!checking) return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!saving) cancel();
        return true;
      });
      return () => subscription.remove();
    }, [checking, saving]),
  );
  return {
    permission,
    requestPermission: () =>
      action.run(async (signal) => {
        await requestPermission();
        signal.throwIfAborted();
      }),
    qr,
    setQr,
    candidate,
    pasting,
    setPasting: (value: boolean) => {
      action.setError(undefined);
      if (!value) setQr("");
      setPasting(value);
    },
    action,
    /** The camera runs only while this page is visible and nothing else is in progress. */
    scanning:
      focused &&
      active &&
      !!permission?.granted &&
      !candidate &&
      !action.busy &&
      !pasting &&
      !action.error,
    read: (value: string) => {
      if (!action.busy) void pair(value);
    },
    pastePair: () => pair(qr),
    cancel,
    save: () =>
      action.run(async (signal) => {
        const computer = candidate;
        await runtime.savePair();
        signal.throwIfAborted();
        setCandidate(undefined);
        // Back to the existing tabs when a computer is added from Devices (a replace stacked a
        // second set of tabs, so back led to the old ones); a first pairing gets them fresh. A
        // page left while saving is not navigated for.
        if (navigation.isFocused()) router.dismissTo("/(tabs)/chat");
        return computer?.name;
      }),
  };
}
