import { appCapabilityTools, officeRenderOutputPath } from "@pibot/protocol-base";

/**
 * What repeating a tool call can do, which decides crash recovery, replay interception
 * and parallelism.
 *
 * - `read`: no side effect; rerun freely, never journalled.
 * - `idempotent`: the outcome is fixed by the arguments (a full-content write); a repeat with the
 *   same target state is a no-op, an uncertain one may be redone.
 * - `local_effect`: changes this machine with an outcome that depends on its state; an uncertain
 *   one is never redone automatically.
 * - `external`: leaves the machine (a send, a submission, a paid API); never repeated.
 *
 * A tool missing from this table is `external`.
 */
export type ToolEffectClass = "read" | "idempotent" | "local_effect" | "external";

const APP_READ_EFFECTS = Object.fromEntries(
  Object.entries(appCapabilityTools)
    .filter(([, definition]) => definition.policy.readOnly)
    .map(([name]) => [name, "read" as const]),
);

const TOOL_EFFECTS: Readonly<Record<string, ToolEffectClass>> = {
  // Reads of files, folders, the web and chats.
  read_file: "read",
  search_text: "read",
  list_dir: "read",
  find_files: "read",
  web_fetch: "read",
  web_search: "read",
  read_messages: "read",
  // A conflict instructs the Bot to reread the same ref for a fresh version.
  knowledge_read: "read",
  knowledge_search: "read",
  code_navigate: "read",
  code_outline: "read",
  code_symbols: "read",
  code_map: "read",
  review_read: "read",
  office_capabilities: "read",
  office_inspect: "read",
  office_read: "read",
  office_preview: "read",
  office_validate: "read",
  office_render: "read",
  // Bookkeeping reads and the tool catalog (discovery only changes what the session offers).
  todo_list: "read",
  task_status: "read",
  tool_discover: "read",
  local_network: "read",
  connection_needed: "read",
  connector_discover: "read",
  routine_query: "read",
  // Asking the user changes nothing; asking again only asks again.
  ask_user: "read",
  // Observing the Bot browser, the screen and the paired phone.
  browser_snapshot: "read",
  browser_network: "read",
  browser_secret: "read",
  browser_diagnostics: "read",
  browser_inspect: "read",
  browser_screenshot: "read",
  browser_tabs: "read",
  browser_download_list: "read",
  browser_wait: "read",
  screenshot: "read",
  ui_tree: "read",
  phone_media: "read",
  phone_media_get: "read",
  phone_sms_code: "read",
  phone_calls: "read",
  phone_notifications: "read",
  execution_targets: "read",
  // Only adds a card; the move is the user's own RPC.
  workplace_use_runner: "local_effect",
  memory_search: "read",
  memory_read: "read",
  ...APP_READ_EFFECTS,

  project_notes: "local_effect",
  write_file: "idempotent",
  office_create: "idempotent",
  todo_update: "idempotent",
  memory_update: "idempotent",
  memory_remove: "idempotent",

  edit_file: "local_effect",
  apply_patch: "local_effect",
  office_edit: "local_effect",
  office_convert: "local_effect",
  run_command: "local_effect",
  background_command: "local_effect",
  write_stdin: "local_effect",
  reveal_in_folder: "local_effect",
  memory_add: "local_effect",
  todo_pause: "local_effect",
  finish_task: "local_effect",
  personal_todo: "local_effect",
  check_command_propose: "local_effect",
  skill_propose: "local_effect",
  routine_propose: "local_effect",
  routine_flag_attention: "local_effect",
  review_start: "local_effect",
  review_finding: "local_effect",
  delivery_evidence: "local_effect",
  // Collaboration stays inside Pi Bot: other Bots on this machine get work, nothing leaves it.
  task_spawn: "local_effect",
  task_message: "local_effect",
  task_cancel: "local_effect",
  assign_task: "local_effect",
  group_plan: "local_effect",
  ask_bot: "local_effect",
  image_result: "local_effect",
  browser_open: "local_effect",
  browser_click: "local_effect",
  browser_type: "local_effect",
  browser_select: "local_effect",
  browser_scroll: "local_effect",
  browser_back: "local_effect",
  browser_close: "local_effect",
  ui_action: "local_effect",
  pointer: "local_effect",
  keys: "local_effect",
  open_app: "local_effect",
  open_file: "local_effect",

  // Leaves the machine: files handed out of the run, saved credentials submitted to a site, a
  // paid generation request, and connector writes (always a send draft, see connectorEffectClass).
  send_file: "external",
  browser_login: "external",
  image_generation: "external",
  connector_call: "external",
};

/**
 * Reviewed read operations pi may overlap. pi prepares every call (including approval)
 * before a parallel batch starts and one sequential tool serializes the whole batch, so this stays
 * a reviewed subset of the `read` class rather than the whole class. run_command is registered
 * parallel separately: LocalRun applies per-call barriers, without relaxing its recovery class.
 */
export const PARALLEL_READS: ReadonlySet<string> = new Set([
  "read_file",
  "search_text",
  "list_dir",
  "find_files",
  "web_fetch",
  "web_search",
  "read_messages",
]);
for (const tool of PARALLEL_READS)
  if (TOOL_EFFECTS[tool] !== "read") throw new Error(`Parallel tool ${tool} is not a read`);

/**
 * The class of one built-in call. A few tools change class with their arguments: a typed text
 * that submits the form leaves the machine, an image operation can only inspect, re-send or save.
 */
export function toolEffectClass(tool: string, input: Record<string, unknown>): ToolEffectClass {
  if (officeRenderOutputPath(tool, input) !== undefined) return "local_effect";
  if (
    tool === "browser_request" &&
    ["GET", "HEAD"].includes(String(input.method)) &&
    input.body === undefined
  )
    return "read";
  if (tool === "browser_type" && input.submit === true) return "external";
  if (tool === "image_result")
    return input.action === "inspect"
      ? "read"
      : input.action === "resend"
        ? "external"
        : "local_effect";
  if (tool === "personal_todo" && input.action === "list") return "read";
  return Object.hasOwn(TOOL_EFFECTS, tool) ? (TOOL_EFFECTS[tool] as ToolEffectClass) : "external";
}

/** MCP tool annotations as a server declares them (stored with the catalog). */
export interface ConnectorToolHints {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * A connector call is `read` only when the user classified the tool read-only (the policy
 * category); every other call is a send draft and `external`. Server annotations can only make
 * this stricter: a declared write or destructive tool is `external` even if classified read-only,
 * and `idempotentHint` never relaxes `external`.
 */
export function connectorEffectClass(
  readOnly: boolean,
  hints: ConnectorToolHints = {},
): ToolEffectClass {
  if (!readOnly) return "external";
  if (hints.readOnlyHint === false || hints.destructiveHint === true) return "external";
  return "read";
}
