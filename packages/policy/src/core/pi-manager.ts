import { SETTINGS_SECURITY_CONFIRM } from "./confirmation-reasons.ts";
import { deny } from "./deny.ts";
import type { PolicyTrace } from "./explain.ts";
import { effectiveLevel } from "./levels.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

/** A destructive repair: its card shows whatever Pi's level or the conversation's YOLO say. */
export const PI_REPAIR_CONFIRM = "pi_repair_confirm";

/**
 * The default Pi manages Bots and groups and hands work to them (owner decision 2026-11-24), and
 * checks for and repairs stuck Bots and groups (owner decision 2026-11-25).
 * Only a call the kernel marked `mainDirect` (Pi's own direct chat, typed by the person on this
 * computer) gets past the first step; every other caller is refused whatever its levels say.
 * Pi's own level then decides (never / ask / always). Listing reads names and states only and
 * needs no card. "Remember" on a card sets Pi's level to always, which the brain does; no grant
 * is created. What the receiving Bot then does is judged under its own permissions.
 */
export function piManagerPolicy(input: EvaluationInput, trace: PolicyTrace): PolicyResult {
  const request = input.request;
  const category =
    request.category === "work_dispatch" ||
    request.category === "pi_repair" ||
    request.category === "settings_change"
      ? request.category
      : "bot_management";
  const result: PolicyResult = {
    decision: "ask",
    reason: "permission_ask",
    risk: "normal",
    category,
    facts: [],
    canRemember: true,
    explanation: [],
  };
  const mainDirect =
    (request.category === "bot_management" ||
      request.category === "work_dispatch" ||
      request.category === "pi_repair" ||
      request.category === "settings_change") &&
    request.mainDirect === true;
  if (
    request.category === "settings_change" &&
    request.operation === "security" &&
    request.unattended
  )
    return deny(result, "settings_security_unattended", trace, "boundary");
  trace.step("boundary", "pi_manager_main_direct", mainDirect ? "info" : "deny");
  if (!mainDirect) return deny(result, "pi_manager_main_only", trace, "boundary");
  if (request.category === "bot_management" && request.operation === "list") {
    result.decision = "allow";
    result.reason = "pi_manager_list";
    result.canRemember = false;
    return trace.result(result, "category");
  }
  // The health check reads states and ids only, like listing; repairs are judged below.
  if (request.category === "pi_repair" && request.operation === "check") {
    result.decision = "allow";
    result.reason = "pi_repair_check";
    result.canRemember = false;
    return trace.result(result, "category");
  }
  if (request.category === "settings_change" && request.operation === "read") {
    result.canRemember = false;
    result.decision = "allow";
    result.reason = "settings_read";
    return trace.result(result, "boundary");
  }
  const level = effectiveLevel(input.settings.levels[category], input.botOverrides?.[category]);
  trace.step("level", "permission_level", "info", {
    level,
    source:
      input.permissionSources?.[category] ??
      (input.botOverrides?.[category] === undefined ? "default" : "bot"),
  });
  // "Never" refuses every settings change; only "always" is ignored for the security tier.
  if (level === "never") return deny(result, "permission_never", trace, "level");
  if (request.category === "settings_change" && request.operation === "security") {
    result.canRemember = false;
    result.reason = SETTINGS_SECURITY_CONFIRM;
    return trace.result(result, "boundary");
  }
  if (request.category === "pi_repair" && request.mustAsk !== false) {
    // Owner decision 2026-11-25: the destructive repairs always show their card, and the card
    // cannot be remembered (a remembered "always" would not skip it anyway).
    result.reason = PI_REPAIR_CONFIRM;
    result.canRemember = false;
    return trace.result(result, "boundary");
  }
  if (level === "always") {
    result.decision = "allow";
    result.reason = "permission_always";
    result.canRemember = false;
  }
  return trace.result(result, "level");
}
