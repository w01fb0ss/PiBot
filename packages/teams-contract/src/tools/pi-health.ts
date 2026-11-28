import { type CapabilityToolSpec, IdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { optionalToolRef } from "./optional-ref.ts";

/**
 * The default Pi checks for and repairs stuck Bots and groups (owner decision 2026-11-25). Trigger:
 * a group stayed 「等你处理」 for good and the person let another AI tool hand-edit the data
 * directory. The check reads the services' own state; each repair goes through the same service
 * path the app's own buttons use, re-checks the item first and refuses when it changed.
 */
export const PI_HEALTH_KINDS = [
  "approval",
  "run",
  "topic",
  "plan",
  "task",
  "connection",
  "background",
] as const;
export type PiHealthKind = (typeof PI_HEALTH_KINDS)[number];

/** Fixed reason codes; the person reads the sentence for each (i18n `piHealth.reason.*`). */
export const PI_HEALTH_REASONS = [
  // A paused approval whose run can never resume (a newer turn, the group or its topic moved on).
  "approval_superseded",
  // A pending approval that no live run waits on.
  "approval_no_waiter",
  "run_no_worker",
  "run_queued_stuck",
  // Still has a live worker, but has run far longer than a turn normally does.
  "run_long_running",
  "topic_busy_no_run",
  "round_limit_reached",
  "plan_hold_replan_limit",
  "plan_hold_fix_skipped",
  "plan_step_blocked",
  "plan_manual_review",
  "plan_confirmation",
  "plan_running_no_worker",
  // A plan waits for the person on its card for something no repair answers (budget, attempts).
  "plan_waiting_you",
  "task_idle_open",
  "connection_failed",
  "background_process_gone",
] as const;
export type PiHealthReason = (typeof PI_HEALTH_REASONS)[number];

export const PI_REPAIR_ACTIONS = [
  "settle_approval",
  "stop_run",
  "release_topic",
  "rounds_reset",
  "rounds_raise",
  "plan_continue",
  "plan_accept_as_is",
  "plan_stop",
  "step_retry",
  "step_skip",
  "task_close",
  "connection_restart",
  "background_forget",
] as const;
export type PiRepairAction = (typeof PI_REPAIR_ACTIONS)[number];

/** A task counts as idle once nothing happened in it for this long (spec: e.g. 24 h). */
export const PI_HEALTH_IDLE_TASK_MS = 24 * 60 * 60 * 1000;
/** A run with a live worker is listed (stop on request) once it has run this long. */
export const PI_HEALTH_LONG_RUN_MS = 30 * 60 * 1000;
/** Rows younger than this are still being set up by their owner and never count as stuck. */
export const PI_HEALTH_GRACE_MS = 2 * 60 * 1000;
/** One check lists at most this many items; the rest are counted and paged with `after`. */
export const PI_HEALTH_PAGE = 30;

const scopeRef = optionalToolRef(z.string().trim().min(1).max(200));
const itemId = z
  .string()
  .regex(/^[a-z]+:[A-Za-z0-9_:-]{1,200}$/)
  .max(240);

const rule = {
  zh: "用户说某个 Bot 或群卡住了、一直「等你处理」、发不出消息、计划停着不动、连接连不上时，先用 pi_health_check 体检（可以只查一个 Bot 或群），它只读状态、不会改任何东西。用一两句大白话告诉用户查到了什么、为什么卡住、建议怎么修；什么都没查到就直说一切正常。用户点了体检卡片上某一项的修法时，会发来一条「修这一项：…」的消息，并由程序带上那一项和修法：这时直接调用 pi_repair，不带任何参数。用户用自己的话说要修哪一项时，再用 pi_repair 修那一项：check 填体检结果里的 checkId，item 填那一项的 id，action 只能选那一项列出的修法；这些 id 只在工具里用，不要写进回复。每次修都会弹卡片让用户确认；停止还有进程的运行、结束计划、关闭任务每次都必须确认。如果返回「状态已经变了」，重新体检再说。不要建议用户去改数据目录或数据库文件。",
  en: "When the person says a Bot or group is stuck, keeps saying it waits for them, will not take messages, has a plan that stopped moving, or a connection that will not connect, run pi_health_check first (optionally for one Bot or group); it only reads state and changes nothing. Tell the person in a sentence or two what it found, why it is stuck and the suggested fix; when nothing is wrong, say so. When the person taps a fix on the check card, a “Fix this: …” message arrives and the program carries that item and fix: call pi_repair with no arguments then. When the person names an item in their own words, call pi_repair for it: check = the result's checkId, item = that item's id, action = one of the fixes listed for it; these ids are for the tool only, never put them in your reply. Each repair shows the person a card; stopping a run that still has a live process, ending a plan and closing a task always ask. If it answers that the state changed, run the check again. Never suggest editing the data folder or database files.",
} as const;

export const piHealthTools = {
  pi_health_check: {
    mainBotOnly: true,
    rule,
    schema: z.strictObject({
      bot: scopeRef.describe(
        "One Bot ID or exact name. Omit bot and group to check everything; never pass placeholders.",
      ),
      group: scopeRef.describe(
        "One group ID or exact name. Omit bot and group to check everything; never pass placeholders.",
      ),
      after: z
        .unknown()
        .optional()
        .transform((value) =>
          typeof value === "string" && value.length <= 240 ? value : undefined,
        )
        .describe(
          "Use next from a previous page of this check. Omit after for the first page; never pass placeholders.",
        ),
    }),
    description:
      "Check the person's Bots and groups for stuck state: approvals nobody can answer, runs marked running with no live worker, topics that refuse messages with nothing running, group plans and steps waiting on the person, long-idle open tasks, failed connections, and background commands whose process is gone. Omit bot and group to check everything; never pass placeholders. To narrow the check, pass only bot or only group. Read-only metadata (names, states, times, reason codes, the fixes that apply); no message text, files or keys. No confirmation. Returns checkId and items; pass both to pi_repair. A group at its automatic round limit is reported as round_limit_reached.",
    policy: { category: "pi_repair", operation: "check" },
    attributes: { readOnly: true },
  },
  pi_repair: {
    mainBotOnly: true,
    // All three or none: none means "the fix the person tapped on the check card", which the
    // program carries with that message; the model never has to copy ids from it.
    schema: z
      .strictObject({
        /** checkId from the pi_health_check result the person saw. */
        check: optionalToolRef(IdSchema),
        /** The item's id from that result. */
        item: optionalToolRef(itemId),
        action: z.enum(PI_REPAIR_ACTIONS).optional(),
      })
      // Models that fill every field send the tapped fix's action with empty ids; that still
      // means "the tapped fix", and the executor checks the action matches it.
      .refine(
        (value) =>
          (value.check === undefined && value.item === undefined) ||
          [value.check, value.item, value.action].every((part) => part !== undefined),
        "pi_repair_arguments_all_or_none",
      ),
    description:
      "Repair one item from a pi_health_check result with one of the fixes listed for it, after the person confirms on a card. With no arguments it repairs the fix the person just tapped on the check card (that message carries it); otherwise pass check, item and action together. It uses the app's own path (stop a run, settle an approval, a plan's own choice, restart a connection, …), checks the item again first and refuses with state_changed when it is no longer the same; run the check again then. Nothing is deleted and no data file is edited. For round_limit_reached, use rounds_reset or rounds_raise when listed. Either continues the original work after confirmation.",
    policy: { category: "pi_repair", operation: "repair" },
    attributes: { readOnly: false },
  },
} as const satisfies Record<string, CapabilityToolSpec>;

/** The tools whose step shows the health check's list card under it. */
export const PI_HEALTH_CHECK_TOOL = "pi_health_check";
