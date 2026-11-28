import { imageRunErrorText } from "@pibot/i18n";
import {
  type ImageGenerationResults,
  imageGenerationResultCounts,
  type Message,
} from "@pibot/protocol";
import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Button } from "../../../ui/controls.tsx";
import { ImageThumb } from "../../files/Attachments.tsx";

const MODEL_FAILURE_CODES = new Set([
  "auth_failed",
  "billing",
  "quota_exhausted",
  "no_model",
  "model_unavailable",
  "provider_rejected",
  "image_unsupported",
  "image_mode_mismatch",
  "claude_subscription_unsupported",
  "subscription_unsupported",
]);

export function MessageImageResults({
  message,
  results,
}: {
  message: Message;
  results: ImageGenerationResults;
}) {
  const t = useSharedText();
  const mobile = useText();
  const colors = useColors();
  const router = useRouter();
  const attachments = new Map(message.attachments?.map((item) => [item.id, item]));
  return (
    <View
      style={{
        maxWidth: "100%",
        gap: 8,
        padding: 12,
        borderRadius: 12,
        backgroundColor: colors.card,
      }}
    >
      <Text
        accessibilityRole="header"
        style={[type.body, { color: colors.text, fontWeight: "600" }]}
      >
        {t(`media.${results.kind}.title`)}
      </Text>
      <Text style={[type.small, { color: colors.text2 }]}>
        {t("media.multi.summary", imageGenerationResultCounts(results))}
      </Text>
      {results.items.map((item, index) => (
        <View
          key={item.status === "success" ? item.attachmentId : `failure-${index}`}
          style={{ gap: 4, borderTopWidth: 1, borderColor: colors.b1, paddingTop: 8 }}
        >
          <Text style={[type.small, { color: colors.text }]}>
            {results.kind === "compare" ? item.model : t("media.multi.item", { index: index + 1 })}
          </Text>
          {item.status === "failed" ? (
            <View style={{ gap: 6, alignItems: "flex-start" }}>
              <Text style={[type.small, { color: colors.warn }]}>
                {t("media.multi.failure", {
                  code: imageRunErrorText(item.reasonCode, t),
                })}
              </Text>
              {MODEL_FAILURE_CODES.has(item.reasonCode) && (
                <Text style={[type.small, { color: colors.text2 }]}>
                  {mobile("imageModelsOnComputer", { settings: t("settings.models") })}
                </Text>
              )}
              <Button
                variant="ghost"
                title={mobile("viewRecords")}
                onPress={() => router.push("/records")}
              />
            </View>
          ) : (
            [item.attachmentId, ...(item.additionalAttachmentIds ?? [])].map((id) => {
              const attachment = attachments.get(id);
              return attachment ? (
                <ImageThumb key={id} messageId={message.id} item={attachment} />
              ) : (
                <Text key={id} style={[type.small, { color: colors.warn }]}>
                  {t("attachments.imageFailed")}
                </Text>
              );
            })
          )}
        </View>
      ))}
    </View>
  );
}
