import type { Attachment } from "@pibot/protocol";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useMobileSelector, useRuntime, useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import { Icon } from "../../ui/icons.tsx";
import { fileHref, sourceKey } from "./source.ts";

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/**
 * Where each thumbnail's cached file was last found, by computer + source. A row scrolled back
 * into the virtualized thread draws its image at once instead of the file icon until the cache
 * index answers; the check below still corrects it.
 */
const knownUris = new Map<string, string | undefined>();
const KNOWN_LIMIT = 500;
function remember(key: string, uri: string | undefined) {
  knownUris.delete(key);
  knownUris.set(key, uri);
  if (knownUris.size > KNOWN_LIMIT) {
    const oldest = knownUris.keys().next().value;
    if (oldest !== undefined) knownUris.delete(oldest);
  }
}
/** The cached copy of one attachment, if any; re-checked whenever the cache changes. */
function useCachedUri(messageId: string, attachmentId: string) {
  const runtime = useRuntime(),
    selectedId = useMobileSelector((s) => s.selectedId);
  const known = `${selectedId}:${messageId}:${attachmentId}`;
  const [uri, setUri] = useState(() => knownUris.get(known));
  useEffect(() => {
    const computerId = selectedId;
    if (!computerId) return;
    let live = true;
    const check = () =>
      void runtime.storage.files
        .peek(computerId, sourceKey({ attachmentId, messageId }))
        .then((entry) => {
          const next = entry ? runtime.storage.files.uri(entry) : undefined;
          remember(known, next);
          if (live) setUri(next);
        })
        .catch(() => {
          // The index is unreadable: the chip simply shows no thumbnail.
        });
    check();
    const off = runtime.storage.files.subscribe(check);
    return () => {
      live = false;
      off();
    };
  }, [runtime, selectedId, messageId, attachmentId, known]);
  return uri;
}
export function ImageThumb({ messageId, item }: { messageId: string; item: Attachment }) {
  const colors = useColors(),
    t = useText(),
    router = useRouter();
  const uri = useCachedUri(messageId, item.id);
  const ratio = item.width && item.height ? item.width / item.height : 4 / 3;
  const width = Math.min(200, Math.max(90, 140 * ratio));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("fileImage", { name: item.name })}
      onPress={() => router.push(fileHref({ attachmentId: item.id, messageId }, item.name))}
      style={{
        width,
        height: width / ratio,
        maxHeight: 200,
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: colors.tert,
        borderWidth: 1,
        borderColor: colors.b1,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          resizeMode="cover"
          // Android decodes a phone photo at full size unless told to downsample to the thumb.
          resizeMethod="resize"
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <Icon name="file" color={colors.text2} size={22} />
      )}
    </Pressable>
  );
}
function FileChip({ messageId, item }: { messageId: string; item: Attachment }) {
  const colors = useColors(),
    router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(fileHref({ attachmentId: item.id, messageId }, item.name))}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        maxWidth: 260,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.b2,
        backgroundColor: pressed ? colors.hover : colors.card,
      })}
    >
      <Icon name="file" color={colors.text2} size={18} />
      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, color: colors.text }}>
          {item.name}
        </Text>
        <Text style={{ fontSize: 11.5, color: colors.text2 }}>{sizeText(item.size)}</Text>
      </View>
    </Pressable>
  );
}
/** Attachment thumbnails and file chips under a message; tapping opens the phone preview. */
export function Attachments({
  messageId,
  items,
  align = "flex-start",
}: {
  messageId: string;
  items: Attachment[];
  align?: "flex-start" | "flex-end";
}) {
  if (!items.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: align }}>
      {items.map((item) =>
        item.kind === "image" ? (
          <ImageThumb key={item.id} messageId={messageId} item={item} />
        ) : (
          <FileChip key={item.id} messageId={messageId} item={item} />
        ),
      )}
    </View>
  );
}
