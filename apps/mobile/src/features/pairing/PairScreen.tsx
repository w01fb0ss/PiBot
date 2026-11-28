import { CameraView } from "expo-camera";
import { useRouter } from "expo-router";
import { KeyboardAvoidingView, Linking, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Button, ErrorLine, Field } from "../../ui/controls.tsx";
import { IconButton } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useToast } from "../../ui/toast.tsx";
import { usePairing } from "./use-pairing.ts";

function Finder({ pair }: { pair: ReturnType<typeof usePairing> }) {
  const colors = useColors();
  return (
    <View
      style={{
        width: 230,
        height: 230,
        borderRadius: 28,
        overflow: "hidden",
        backgroundColor: colors["tray-ink"],
        alignItems: "center",
        justifyContent: "center",
        marginTop: 4,
      }}
    >
      {pair.scanning ? (
        <CameraView
          style={{ width: 230, height: 230 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(result) => pair.read(result.data)}
        />
      ) : (
        <View style={{ opacity: 0.35 }}>
          <Icon name="qr" color={colors["tray-paper"]} size={120} strokeWidth={1} />
        </View>
      )}
    </View>
  );
}
function Steps() {
  const colors = useColors(),
    t = useText();
  return (
    <View style={{ gap: 6, width: "100%", maxWidth: 300 }}>
      {(["pairStep1", "pairStep2", "pairStep3"] as const).map((key, index) => (
        <View key={key} style={{ flexDirection: "row", gap: 6 }}>
          <Text style={{ width: 20, fontSize: 13, fontWeight: "600", color: colors.text }}>
            {index + 1}
          </Text>
          <Text style={{ flex: 1, fontSize: 13, color: colors.text2 }}>{t(key)}</Text>
        </View>
      ))}
    </View>
  );
}
function CodeBoxes({ code }: { code: string }) {
  const colors = useColors();
  return (
    <View
      accessible
      accessibilityLabel={code}
      style={{ flexDirection: "row", gap: 8, marginVertical: 6 }}
    >
      {[...code]
        .map((digit, position) => ({ id: `cell${position}`, digit, position }))
        .map((cell) => (
          <View
            key={cell.id}
            style={{
              width: 40,
              height: 52,
              borderRadius: 12,
              backgroundColor: colors.tert,
              alignItems: "center",
              justifyContent: "center",
              marginRight: cell.position === 2 ? 10 : 0,
            }}
          >
            <Text style={{ fontSize: 26, fontWeight: "600", color: colors.text }}>
              {cell.digit}
            </Text>
          </View>
        ))}
    </View>
  );
}
export function PairScreen() {
  const colors = useColors(),
    t = useText(),
    toast = useToast(),
    insets = useSafeAreaInsets(),
    router = useRouter(),
    pair = usePairing();
  const permission = pair.permission;
  const denied = permission && !permission.granted && !permission.canAskAgain;
  const title = {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "600" as const,
    letterSpacing: -0.2,
    color: colors.text,
    textAlign: "center" as const,
    marginTop: 6,
  };
  const body = { fontSize: 14, color: colors.text2, textAlign: "center" as const, maxWidth: 300 };
  const save = async () => {
    const name = await pair.save();
    if (name) toast(t("connectedToast", { name }));
  };
  // Opened from Devices (another computer is already paired) there is a page to return to: the
  // same round back button as every NavBar, where a NavBar's would sit, so the centred layout
  // stays as it is. A first pairing has nowhere to go back to and shows none.
  const canLeave = !pair.candidate && router.canGoBack();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      // Android 15+ draws edge-to-edge, so the system no longer resizes the window for the
      // keyboard; the composer must be lifted on both platforms.
      behavior="padding"
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          gap: 14,
          paddingTop: insets.top + 18,
          paddingHorizontal: 28,
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        {!pair.candidate ? (
          <>
            <Text accessibilityRole="header" style={title}>
              {t("pairTitle")}
            </Text>
            <Text style={body}>{t("pairHint")}</Text>
            <Finder pair={pair} />
            {denied && <Text style={{ ...body, color: colors.warn }}>{t("cameraDenied")}</Text>}
            <Steps />
            <ErrorLine text={pair.action.error && t(pair.action.error)} />

            <View style={{ flex: 1 }} />
            <View style={{ width: "100%", gap: 8 }}>
              {pair.action.busy && <Text style={body}>{t("pairing")}</Text>}
              {!permission?.granted && !denied && (
                <Button
                  size="lg"
                  variant="prim"
                  title={t("allowCamera")}
                  disabled={pair.action.busy}
                  onPress={() => void pair.requestPermission()}
                />
              )}
              {denied && (
                <Button
                  size="lg"
                  variant="prim"
                  title={t("cameraOpenSettings")}
                  disabled={pair.action.busy}
                  onPress={() =>
                    void Linking.openSettings().catch(() => toast(t("cameraSettingsFailed")))
                  }
                />
              )}
              {pair.pasting ? (
                <>
                  <Text style={body}>{t("pasteWarning")}</Text>
                  <Field
                    value={pair.qr}
                    onChangeText={pair.setQr}
                    placeholder={t("pastePlaceholder")}
                    maxLength={8192}
                    autoCorrect={false}
                    autoCapitalize="none"
                    autoComplete="off"
                    importantForAutofill="no"
                    accessibilityLabel={t("pasteCode")}
                  />
                  <Button
                    size="lg"
                    variant="prim"
                    title={t("startPair")}
                    disabled={!pair.qr.trim() || pair.action.busy}
                    onPress={() => void pair.pastePair()}
                  />
                </>
              ) : (
                <Button size="lg" title={t("pasteCode")} onPress={() => pair.setPasting(true)} />
              )}
              {permission?.granted && (pair.pasting || pair.action.error) && (
                <Button
                  size="lg"
                  title={t("pairScan")}
                  disabled={pair.action.busy}
                  onPress={() => pair.setPasting(false)}
                />
              )}
            </View>
          </>
        ) : (
          <>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 18,
                backgroundColor: colors.tert,
                alignItems: "center",
                justifyContent: "center",
                marginTop: 20,
              }}
            >
              <Icon name="laptop" color={colors.text} size={32} />
            </View>
            <Text accessibilityRole="header" style={title}>
              {t("checkTitle")}
            </Text>
            <Text style={body}>{t("checkHint", { name: pair.candidate.name })}</Text>
            <CodeBoxes code={pair.candidate.safetyCode} />
            <Text style={{ ...body, fontSize: 12.5 }}>{t("checkNote")}</Text>
            <ErrorLine text={pair.action.error && t(pair.action.error)} />
            <View style={{ flex: 1 }} />
            <View style={{ width: "100%", gap: 8 }}>
              <Button
                size="lg"
                variant="prim"
                title={t("codeMatches")}
                disabled={pair.action.busy}
                onPress={() => void save()}
              />
              <Button
                size="lg"
                title={t("codeMismatch")}
                disabled={pair.action.busy}
                onPress={pair.cancel}
              />
            </View>
          </>
        )}
      </ScrollView>
      {canLeave && (
        <View style={{ position: "absolute", top: insets.top + 6, left: 2 }}>
          <IconButton icon="back" label={t("back")} onPress={() => router.back()} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
