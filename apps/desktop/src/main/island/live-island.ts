import { activeToolLabel, toolTarget } from "@pibot/client-core";
import { createTranslator, type Language } from "@pibot/i18n";
import type { Logger } from "@pibot/observability";
import {
  LIVE_ISLAND_KINDS,
  type LiveActivity,
  type LiveActivityItem,
  type Settings,
  type UiNavigation,
} from "@pibot/protocol";
import { type IslandPresentation, liveIslandSupport } from "../../shared/live-island.ts";
import { createIslandWindow } from "./island-window.ts";

type Translate = ReturnType<typeof createTranslator>;

function compactApprovalTitle(title: string, botName: string) {
  // The card can prefix the request with a routine name. The island already labels its Bot.
  const divider = " · ";
  const dividerAt = title.indexOf(divider);
  const nestedStart = dividerAt + divider.length;
  const start = dividerAt >= 0 && title.startsWith(botName, nestedStart) ? nestedStart : 0;
  if (!title.startsWith(botName, start)) return title;
  const suffix = title.slice(start + botName.length);
  return /^(?:\s|想|请求)/u.test(suffix) ? title.slice(0, start) + suffix.trimStart() : title;
}

function statusText(item: LiveActivityItem, language: Language, t: Translate) {
  const title = item.localizedTitle?.[language] ?? item.title;
  if (item.kind === "waiting")
    return title
      ? t("liveIsland.status.waitingNamed", { title: compactApprovalTitle(title, item.botName) })
      : t("liveIsland.status.waiting");
  if (item.step) {
    const [tool = "unknown_tool"] = item.step.split(": ", 1);
    return activeToolLabel(tool, toolTarget(tool, item.step), t);
  }
  if (item.replying) return t("liveIsland.status.replying");
  if (item.kind === "routine")
    return title ? t("liveIsland.status.routineNamed", { title }) : t("liveIsland.status.routine");
  return title ?? t(item.kind === "group" ? "liveIsland.status.group" : "liveIsland.status.chat");
}

/**
 * Decides when the live island shows and what it says. Inputs arrive from the brain (busy Bots,
 * settings), the GUI (whether the Pi Bot window is in front) and the computer-use guard (its bar
 * takes the top of the screen while it shows). The brain owner can keep a window of its own
 * while the GUI is closed. Wayland cannot place the window and has no presenter.
 */
export function createLiveIsland(options: {
  outputDir: string;
  logger: Logger;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Bring the main window forward and open this place. */
  open(target: UiNavigation): void;
}) {
  const support = liveIslandSupport(options.platform, options.env);
  if (support !== "supported")
    options.logger.info(JSON.stringify({ module: "live-island", event: "unsupported", support }));
  let window: ReturnType<typeof createIslandWindow> | undefined;
  let items: LiveActivityItem[] = [];
  let settings: Settings | undefined;
  let language: Language = "zh";
  let foreground = false;
  let guardVisible = false;
  let disposed = false;
  let shown: LiveActivityItem[] = [];
  let presentInGui: ((value: IslandPresentation | null) => void) | undefined;
  let reported: string | undefined;
  const target = (key: string) => shown.find((entry) => entry.key === key)?.target;

  const render = () => {
    if (disposed || support !== "supported") return;
    const kinds = new Set(settings?.liveIslandKinds ?? LIVE_ISLAND_KINDS);
    shown = items.filter((item) => kinds.has(item.kind));
    const hidden = !settings
      ? "settings_pending"
      : settings.liveIsland === false
        ? "disabled"
        : !shown.length
          ? "activity_filtered"
          : guardVisible
            ? "computer_guard_visible"
            : // The GUI decides using its own window's focus when it hosts the presenter.
              foreground && !presentInGui
              ? "gui_focused"
              : undefined;
    const reason = items.length
      ? (hidden ?? (presentInGui ? "gui_presenter" : "owner_presenter"))
      : undefined;
    if (reason && reason !== reported && options.platform === "win32")
      options.logger.info(
        JSON.stringify({
          module: "live-island",
          event: hidden ? "hidden" : "present",
          platform: options.platform,
          reason,
        }),
      );
    reported = reason;
    if (hidden) {
      if (presentInGui) presentInGui(null);
      else window?.hide();
      return;
    }
    const t = createTranslator(language);
    const view: IslandPresentation["view"] = {
      mode: settings?.liveIslandContent ?? "full",
      labels: {
        previous: t("liveIsland.previous"),
        next: t("liveIsland.next"),
        // Templates: the window fills in the count and the running time itself.
        working: t("liveIsland.working"),
        seconds: t("liveIsland.seconds"),
        minutes: t("liveIsland.minutes"),
        hours: t("liveIsland.hours"),
      },
      items: shown.map((item) => ({
        key: item.key,
        name: item.botName,
        text: statusText(item, language, t),
        ...(item.runnerName ? { runner: t("liveIsland.onRunner", { name: item.runnerName }) } : {}),
        open: t("liveIsland.open", { bot: item.botName }),
        avatar: item.avatar,
        startedAt: Math.max(0, Date.parse(item.startedAt) || 0),
      })),
    };
    const presentation = { title: t("liveIsland.windowTitle"), view };
    if (presentInGui) {
      presentInGui(presentation);
      return;
    }
    window ??= createIslandWindow({
      outputDir: options.outputDir,
      logger: options.logger,
      open: (key) => {
        const navigation = target(key);
        if (navigation) options.open(navigation);
      },
    });
    window.show(presentation);
  };

  return {
    support,
    target,
    presentThrough(present?: typeof presentInGui) {
      presentInGui = present;
      window?.destroy();
      window = undefined;
      render();
    },
    activity(value: LiveActivity) {
      items = value.items;
      render();
    },
    settings(next: Settings, nextLanguage: Language) {
      settings = next;
      language = nextLanguage;
      render();
    },
    foreground(value: boolean) {
      if (foreground === value) return;
      foreground = value;
      if (!presentInGui) render();
    },
    guardVisible(value: boolean) {
      if (guardVisible === value) return;
      guardVisible = value;
      render();
    },
    dispose() {
      disposed = true;
      window?.destroy();
      window = undefined;
    },
  };
}
