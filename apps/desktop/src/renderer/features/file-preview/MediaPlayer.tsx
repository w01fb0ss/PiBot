import { useEffect, useState } from "react";
import styles from "./media-player.module.css";

export function MediaPlayer({
  data,
  mime,
  name,
  onError,
  onReady,
}: {
  data: string;
  mime: string;
  name: string;
  onError(): void;
  onReady?(): void;
}) {
  const [loaded, setLoaded] = useState<{ data: string; mime: string; url: string }>();
  useEffect(() => {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setLoaded({ url, data, mime });
    return () => URL.revokeObjectURL(url);
  }, [data, mime]);
  if (loaded?.data !== data || loaded.mime !== mime) return null;
  const props = {
    src: loaded.url,
    controls: true,
    muted: true,
    preload: "metadata",
    "aria-label": name,
    onError,
    onLoadedMetadata: onReady,
    className: styles.player,
  } as const;
  if (mime.startsWith("video/")) {
    // Attachments may have no caption track. The original remains available to open or save.
    return <video {...props} playsInline />;
  }
  return <audio {...props} />;
}
