import { computerToolKey } from "@pibot/client-core";
import {
  BOT_BROWSER_APP_ID,
  type ComputerState,
  type ComputerStep,
  RpcError,
  RpcErrorCodes,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import type { TranslationKey } from "@pibot/i18n";

/**
 * brain handlers for `computer.*` land in parallel tasks; a missing handler is a temporary
 * "not ready" state the user can retry, never a silent empty list.
 */
const INSTALLED_APPS_UNAVAILABLE: Record<string, TranslationKey> = {
  unsupported_platform: "computerUse.unavailable.unsupported_platform",
  helper_unavailable: "computerUse.unavailable.helper_unavailable",
  osascript_unavailable: "computerUse.unavailable.helper_unavailable",
  non_interactive_session: "computerUse.unavailable.non_interactive_session",
  wayland_limited: "computerUse.unavailable.wayland_limited",
  driver_missing: "computerUse.unavailable.driver_missing",
  permission_missing: "computerUse.unavailable.permission_missing",
  permission_missing_desktop: "computerUse.unavailable.permission_missing_desktop",
  runner: "computerUse.unavailable.runner",
};

/** Permanent platform limits stay explicit; transient driver/session/permission issues offer Retry. */
export function isInstalledAppsRetryable(reason: string | undefined): boolean {
  // Older runners can return "unsupported" for both a platform limit and a helper failure.
  return reason !== "unsupported_platform";
}

/** Maps driver/service reason codes to localized copy; never echoes raw OS/driver strings. */
export function installedAppsUnavailableText(reason: string | undefined, t: Translate) {
  const key =
    reason && Object.hasOwn(INSTALLED_APPS_UNAVAILABLE, reason)
      ? INSTALLED_APPS_UNAVAILABLE[reason]
      : undefined;
  return key
    ? t("computerUse.picker.unsupported", { reason: t(key) })
    : t("computerUse.picker.unsupportedGeneric");
}

export function computerErrorKey(error: unknown): TranslationKey {
  return error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound
    ? "computerUse.error.notReady"
    : "computerUse.error.failed";
}

export { computerToolKey } from "@pibot/client-core";
export const isComputerTool = (tool: string) => computerToolKey(tool) !== undefined;

/** Operating the desktop, not the Bot browser (whose tools share the computer step log). */
export const isDesktopComputerTool = (tool: string) =>
  isComputerTool(tool) && !tool.startsWith("browser_");

/**
 * The tool call of the run's latest desktop step (steps are grouped in creation order). A stop
 * cuts in right after it, so that is where the run's "stopped" notice belongs.
 */
export function lastDesktopToolCall(
  byToolCall: ReadonlyMap<string, readonly ComputerStep[]>,
): string | undefined {
  let last: string | undefined;
  for (const [toolCallId, steps] of byToolCall)
    if (steps.some((step) => step.method !== "browser")) last = toolCallId;
  return last;
}

/** The Bot browser belongs to the website category, so grant UIs list desktop apps only. */
export const isDesktopApp = (appId: string) => !sameAppId(appId, BOT_BROWSER_APP_ID);

export function stepMethodKey(step: ComputerStep): TranslationKey {
  return `computerUse.method.${step.method}`;
}
export function stepTone(step: ComputerStep): "background" | "foreground" | "browser" {
  if (step.method === "browser") return "browser";
  return step.stage;
}
/** "x,y" in screenshot pixels for coordinate steps (protocol `ComputerStepSchema.target`). */
export function clickPoint(step: ComputerStep): { x: number; y: number } | undefined {
  if (step.method !== "coordinates") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(step.target);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;
export function stepTitle(step: ComputerStep, t: Translate) {
  const point = clickPoint(step);
  if (point) return t("computerUse.step.click", { x: point.x, y: point.y });
  // Phrased now, in the interface language; older rows only have the saved text.
  const action = step.action;
  if (action) {
    const subject = action.subject ?? "";
    switch (action.kind) {
      case "type":
        return t(action.submit ? "computerUse.action.typeSubmit" : "computerUse.action.type", {
          subject,
          chars: action.chars ?? 0,
        });
      case "scroll":
        return t(`computerUse.action.scroll.${action.direction ?? "down"}`);
      default:
        return t(`computerUse.action.${action.kind}`, { subject });
    }
  }
  return step.target.trim() || t(stepMethodKey(step));
}
/** A step that waited on a "come help" card says so instead of its bare result. */
export function stepStatusKey(step: ComputerStep): TranslationKey {
  if (step.handoff === "waiting") return "computerUse.stepHandoff.waiting";
  if (step.handoff === "not_handled") return "computerUse.stepHandoff.notHandled";
  if (step.handoff === "continued")
    return step.result === "done"
      ? "computerUse.stepHandoff.continuedDone"
      : "computerUse.stepHandoff.continuedError";
  return `computerUse.stepResult.${step.result}`;
}
export function stepStatusTone(step: ComputerStep): string {
  if (step.handoff === "waiting") return "waiting";
  if (step.handoff === "not_handled") return "skipped";
  return step.result;
}
/** The icon a step without a picture shows: neutral, never the "hidden" eye. */
export function stepIcon(step: ComputerStep): "globe" | "file" {
  return step.method === "browser" ? "globe" : "file";
}

/** States worth showing outside the chat (sidebar row, settings "in use"). */
export function activeComputerState(state: ComputerState | undefined) {
  return state && ["background", "foreground", "paused"].includes(state.state) ? state : undefined;
}
export function computerStateText(state: ComputerState, t: Translate) {
  const waiting = state.foreground && state.foreground.status !== "running";
  if (state.state === "paused") return t("computerUse.state.paused");
  if (waiting && state.foreground?.status === "queued") return t("computerUse.state.queued");
  if (waiting) return t("computerUse.state.waiting");
  return state.app
    ? t("computerUse.state.working", { app: state.app.name })
    : t("computerUse.state.workingNoApp");
}
