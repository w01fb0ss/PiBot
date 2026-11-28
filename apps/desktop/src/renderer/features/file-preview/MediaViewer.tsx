import { mediaMime } from "@pibot/protocol";
import { useEffect } from "react";
import type { ViewerProps } from "./engine.ts";
import { MediaPlayer } from "./MediaPlayer.tsx";

export default function MediaViewer({ file, result, fail, ready }: ViewerProps) {
  const mime = mediaMime(file.name);
  useEffect(() => {
    if (!mime) fail();
  }, [mime, fail]);
  return mime ? (
    <MediaPlayer data={result.data} mime={mime} name={file.name} onError={fail} onReady={ready} />
  ) : null;
}
