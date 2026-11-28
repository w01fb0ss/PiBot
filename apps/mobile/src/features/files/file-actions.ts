import { Directory, File, Paths } from "expo-file-system";
import { startActivityAsync } from "expo-intent-launcher";
import { requestPermissionsAsync, saveToLibraryAsync } from "expo-media-library/legacy";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import { extensionOf } from "./source.ts";

// What leaves the app is exactly the cached copy (redacted text for text formats). Opening on
// the phone is allowed (2026-10-22); opening on the computer is not offered.
const types: Record<string, [mime: string, uti: string]> = {
  mp4: ["video/mp4", "public.mpeg-4"],
  webm: ["video/webm", "org.webmproject.webm"],
  mov: ["video/quicktime", "com.apple.quicktime-movie"],
  m4v: ["video/mp4", "com.apple.m4v-video"],
  m4a: ["audio/mp4", "public.mpeg-4-audio"],
  mp3: ["audio/mpeg", "public.mp3"],
  wav: ["audio/wav", "com.microsoft.waveform-audio"],
  ogg: ["audio/ogg", "org.xiph.ogg"],
  png: ["image/png", "public.png"],
  jpg: ["image/jpeg", "public.jpeg"],
  jpeg: ["image/jpeg", "public.jpeg"],
  gif: ["image/gif", "com.compuserve.gif"],
  webp: ["image/webp", "org.webmproject.webp"],
  svg: ["image/svg+xml", "public.svg-image"],
  pdf: ["application/pdf", "com.adobe.pdf"],
  md: ["text/markdown", "net.daringfireball.markdown"],
  markdown: ["text/markdown", "net.daringfireball.markdown"],
  csv: ["text/csv", "public.comma-separated-values-text"],
  json: ["application/json", "public.json"],
  html: ["text/html", "public.html"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "org.openxmlformats.wordprocessingml.document",
  ],
  xlsx: [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "org.openxmlformats.spreadsheetml.sheet",
  ],
  pptx: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "org.openxmlformats.presentationml.presentation",
  ],
};
function typeOf(name: string) {
  return types[extensionOf(name)] ?? ["text/plain", "public.plain-text"];
}
const isImage = (name: string) => ["png", "jpg", "jpeg", "gif", "webp"].includes(extensionOf(name));
/** Other apps see the original file name, not the cache's random one; the copy is reused. */
function namedCopy(uri: string, name: string) {
  const safe = name.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]/gu, "_").slice(-120) || "file";
  const folder = new Directory(Paths.cache, "pibot-share");
  folder.create({ intermediates: true, idempotent: true });
  const target = new File(folder, safe);
  if (target.exists) target.delete();
  new File(uri).copySync(target);
  return target;
}
async function share(uri: string, name: string) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("share_unavailable");
  const [mimeType, UTI] = typeOf(name);
  await Sharing.shareAsync(namedCopy(uri, name).uri, { mimeType, UTI, dialogTitle: name });
}
export type SaveOutcome = "photos" | "folder" | "sheet" | "cancelled";
/**
 * Images go to the photo library with add-only access (asked on the first save). Other files:
 * Android picks a folder through the system document UI; iOS uses the share sheet, whose
 * "Save to Files" is the system's own save dialog.
 */
export async function saveFile(uri: string, name: string): Promise<SaveOutcome> {
  if (isImage(name)) {
    const permission = await requestPermissionsAsync(true);
    if (!permission.granted) throw new Error("photos_denied");
    await saveToLibraryAsync(namedCopy(uri, name).uri);
    return "photos";
  }
  if (Platform.OS === "android") {
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch {
      // The picker throws when the user backs out; nothing was written.
      return "cancelled";
    }
    const [mimeType] = typeOf(name);
    const target = folder.createFile(name, mimeType);
    await target.write(await new File(uri).bytes());
    return "folder";
  }
  await share(uri, name);
  return "sheet";
}
/** "Open with another app": Android asks the system for a viewer, iOS shows "Open in…". */
export async function openWithApp(uri: string, name: string) {
  if (Platform.OS === "android") {
    try {
      const copy = namedCopy(uri, name);
      await startActivityAsync("android.intent.action.VIEW", {
        data: copy.contentUri,
        type: typeOf(name)[0],
        // FLAG_GRANT_READ_URI_PERMISSION: the viewer reads only this one file.
        flags: 1,
      });
      return;
    } catch {
      // No app handles this type; the share sheet still offers every app that accepts files.
    }
  }
  await share(uri, name);
}
export const shareFile = share;
