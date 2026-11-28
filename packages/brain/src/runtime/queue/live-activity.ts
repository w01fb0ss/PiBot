import { win32 } from "node:path";
import {
  KERNEL_TOOL_ATTRIBUTES,
  type KernelEventPayloads,
  type LiveActivity,
  type LiveActivityItem,
} from "@pibot/protocol-base";
import type { LiveActivityRepo } from "@pibot/storage";
import { auditText } from "../../core/audit-fields.ts";

/** At most two snapshots a second, even when tools or run state change rapidly. */
const MIN_INTERVAL_MS = 500;
const MAX_EXCERPT = 40;
const fileTools = new Set([
  "list_dir",
  "read_file",
  "write_file",
  "edit_file",
  "open_file",
  "reveal_in_folder",
  "office_inspect",
  "office_read",
  "office_create",
  "office_edit",
  "office_preview",
  "office_render",
  "office_validate",
  "office_convert",
  "office_template_fields",
  "office_template_fill",
]);
const excerptTools = new Set(["run_command", "find_files", "search_text", "web_search"]);

type Progress = Pick<LiveActivityItem, "step" | "replying">;
type RunActivity = { tools: Map<string, string>; progress: Progress };

function toolName(tool: string) {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(tool) ? tool : "unknown_tool";
}

function toolStep(
  event: KernelEventPayloads["chat.tool"],
  redactor: { redact(text: string): string },
) {
  const { tool, summary, toolCallId } = event;
  const name = toolName(tool);
  const prefix = `${name}: `;
  // ACP supplies its own prose titles. Only accept the kernel's toolSummary target format.
  if (tool !== name || toolCallId.startsWith("acp-") || !summary.startsWith(prefix)) return name;
  let target = summary.slice(prefix.length);
  if (fileTools.has(tool)) {
    // toolSummary caps its entire string at 1,000. A cut path can end in a directory name.
    if (summary.length >= 1000) return name;
    target = win32.basename(redactor.redact(target));
  } else if (tool === "web_fetch" || tool === "browser_open") {
    const url = URL.parse(target);
    target = url && ["http:", "https:"].includes(url.protocol) ? url.hostname : "";
  } else if (!excerptTools.has(tool)) return name;
  const excerpt = auditText(target, redactor, MAX_EXCERPT);
  return excerpt ? `${name}: ${excerpt}` : name;
}

/**
 * Project committed run, plan, routine and approval facts into the live island's busy-Bot list.
 * Reads happen after the publishing event's transaction (like the active-run count) and at most
 * every MIN_INTERVAL_MS; a snapshot equal to the last one is not sent again.
 */
export function createLiveActivity(
  repo: Pick<LiveActivityRepo, "list">,
  emit: (value: LiveActivity) => void,
  failed: () => void,
  redactor: { redact(text: string): string },
  isCapabilityTool: (name: string) => boolean = () => false,
) {
  const changes = new Set([
    "chat.status",
    "chat.done",
    "chat.error",
    "inbox.changed",
    "routines.changed",
    "approval.requested",
    "approval.resolved",
    "execution.todo.changed",
    "group.task",
    "groups.plan.changed",
    "bots.changed",
    "devices.changed",
  ]);
  const runs = new Map<string, RunActivity>();
  const activityFor = (runId: string) => {
    let activity = runs.get(runId);
    if (!activity) {
      activity = { tools: new Map(), progress: {} };
      runs.set(runId, activity);
    }
    return activity;
  };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  let lastAt = 0;
  // The owner starts from an empty island, so an empty first snapshot needs no event.
  let previous = "[]";
  const refresh = () => {
    if (disposed) return;
    lastAt = Date.now();
    const items = repo.list((runId) => {
      const activity = runs.get(runId);
      if (!activity) return undefined;
      const tool = [...activity.tools.values()].at(-1);
      return tool ? { step: tool } : activity.progress;
    });
    const snapshot = JSON.stringify(items);
    if (snapshot === previous) return;
    previous = snapshot;
    emit({ items });
  };
  const run = () => {
    timer = undefined;
    scheduled = false;
    try {
      refresh();
    } catch {
      // A failed read (database closing) leaves the island on its last snapshot; the next
      // change event tries again.
      failed();
    }
  };
  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    const wait = Math.max(0, lastAt + MIN_INTERVAL_MS - Date.now());
    // Even with no wait, read after the publisher's synchronous transaction has committed.
    if (wait === 0) queueMicrotask(run);
    else timer = setTimeout(run, wait);
  };
  const progress = (runId: string, next: Progress) => {
    const current = runs.get(runId)?.progress;
    if (current?.step === next.step && current?.replying === next.replying) return;
    activityFor(runId).progress = next;
    schedule();
  };
  return {
    refresh,
    schedule,
    replying(runId: string, replying: boolean) {
      if (disposed) return;
      const activity = runs.get(runId);
      if (replying && !activity?.tools.size) progress(runId, { replying: true });
      else if (activity?.progress.replying) progress(runId, {});
    },
    changed(method: string, payload: unknown) {
      if (disposed) return;
      // The shared peer has already validated these events before calling the projection.
      if (method === "chat.tool") {
        const event = payload as KernelEventPayloads["chat.tool"];
        if (event.phase === "start" && event.status === "running") {
          const activity = activityFor(event.runId);
          const step = toolStep(event, redactor);
          if (activity.tools.get(event.toolCallId) === step) return;
          activity.tools.set(event.toolCallId, step);
          activity.progress = {};
          schedule();
        } else if (event.phase === "end" && runs.get(event.runId)?.tools.delete(event.toolCallId)) {
          schedule();
        }
        return;
      }
      if (method === "chat.activity") {
        const event = payload as KernelEventPayloads["chat.activity"];
        const step =
          event.phase === "preparing_tool" || event.phase === "executing_tool"
            ? Object.hasOwn(KERNEL_TOOL_ATTRIBUTES, event.tool) || isCapabilityTool(event.tool)
              ? toolName(event.tool)
              : "unknown_tool"
            : event.phase === "waiting_model" && event.readingWindow
              ? "ui_tree"
              : undefined;
        // Once a tool has started, its call events own the label until it ends.
        if (event.phase !== "executing_tool" || !runs.get(event.runId)?.tools.size)
          progress(event.runId, step ? { step } : {});
        return;
      }
      if (method === "chat.done" || method === "chat.error") {
        runs.delete(
          (payload as KernelEventPayloads["chat.done"] | KernelEventPayloads["chat.error"]).runId,
        );
      } else if (method === "chat.status") {
        const { runId, state, compacting, reconnecting } =
          payload as KernelEventPayloads["chat.status"];
        if (runId && state === "idle") runs.delete(runId);
        else if (runId && (compacting || reconnecting)) progress(runId, {});
      }
      if (changes.has(method)) schedule();
    },
    dispose() {
      disposed = true;
      runs.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
