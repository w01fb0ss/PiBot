import type { Logger } from "@pibot/observability";
import { type IslandPresentation, IslandPresentationSchema } from "../../shared/live-island.ts";
import { createIslandWindow } from "./island-window.ts";

export function createGuiIsland(options: {
  outputDir: string;
  logger: Logger;
  inForeground(): boolean;
  open(key: string): void;
}) {
  let window: ReturnType<typeof createIslandWindow> | undefined;
  let presentation: IslandPresentation | undefined;
  let foregroundReported = false;
  const refresh = () => {
    if (!presentation || options.inForeground()) {
      if (presentation && !foregroundReported)
        options.logger.info(
          JSON.stringify({
            module: "live-island",
            event: "hidden",
            platform: process.platform,
            reason: "gui_focused",
          }),
        );
      foregroundReported = !!presentation;
      window?.hide();
      return;
    }
    foregroundReported = false;
    window ??= createIslandWindow(options);
    window.show(presentation);
  };
  return {
    refresh,
    receive(raw: unknown) {
      const parsed = IslandPresentationSchema.nullable().safeParse(raw);
      if (!parsed.success) {
        options.logger.warn(
          JSON.stringify({
            module: "live-island",
            event: "failed",
            platform: process.platform,
            reason: "invalid_presentation",
          }),
        );
        return;
      }
      presentation = parsed.data ?? undefined;
      refresh();
    },
    dispose() {
      presentation = undefined;
      foregroundReported = false;
      window?.destroy();
      window = undefined;
    },
  };
}
