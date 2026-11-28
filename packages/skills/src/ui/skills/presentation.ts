import type { TranslationKey, TranslationVars } from "@pibot/i18n";
import {
  RpcError,
  RpcErrorCodes,
  type Skill,
  type SkillParam,
  type SkillSource,
  type WorkflowSummary,
} from "@pibot/skills-contract/full";

type T = (key: TranslationKey, vars?: TranslationVars) => string;

const known = new Set([
  "skill_name_exists",
  "skill_invalid",
  "skill_file_unavailable",
  "skill_not_found",
  "skill_bot_unavailable",
  "skill_import_invalid",
  "skill_import_unsupported",
  "skill_import_too_large",
  "skill_import_file_too_large",
  "skill_attachment_too_large",
  "skill_import_too_many_files",
  "skill_import_unsafe",
  "skill_import_unreadable",
  "skill_import_cancelled",
  "skill_import_timeout",
  "skill_preview_expired",
  "skill_picker_unavailable",
  "skill_picker_busy",
  "skill_proposal_closed",
  "skill_proposal_unavailable",
  "skill_files_invalid",
  "skill_upload_expired",
  "skill_upload_batch_too_large",
  "skill_upload_full",
  "skill_upload_empty",
  "skill_upload_skill_file",
  "skill_secret_invalid",
  "skill_secret_windows",
]);
/** Brain sends stable codes as the RPC message; anything else is shown as a generic failure. */
export function skillError(error: unknown): TranslationKey {
  if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
    return "workspace.unavailable";
  // Some codes carry a detail line (the file that broke a rule); only the first line is the code.
  const code = error instanceof RpcError ? (error.message.split("\n")[0] ?? "") : "";
  if (code === "skill_runtime_plan_changed") return "skills.runtime.error.planChanged";
  if (error instanceof RpcError && known.has(code)) return `skills.error.${code}` as TranslationKey;
  return "skills.error.failed";
}

/**
 * A failed runtime read keeps its own block with a fixed reason, so the reason stays a
 * closed vocabulary (no error text from the brain reaches the UI) and the retry can follow it.
 */
export type RuntimeLoadFailure = "timeout" | "verifying" | "other" | "unsupported";

export function runtimeLoadFailure(error: unknown): RuntimeLoadFailure {
  // An older brain has no skills.runtime at all: there is no block to show and nothing to retry.
  if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound)
    return "unsupported";
  if (!(error instanceof RpcError)) return "other";
  if (error.code === RpcErrorCodes.timeout) return "timeout";
  // readLocation answers skill_file_unavailable while a freshly imported package is still being
  // verified in the background; that wait ends on its own, so it gets its own wording.
  const code = (error.message.split("\n")[0] ?? "").trim();
  return code === "skill_file_unavailable" ? "verifying" : "other";
}

export function sourceKey(source: SkillSource): TranslationKey {
  return `skills.source.${source}`;
}

/**
 * `language` is the app's, not the system's: a Chinese UI on an English Mac read 10/14/2026.
 * `short` (list rows, 「10/23 用过」) drops the year while it is the current one.
 */
export function usedText(t: T, lastUsedAt: string | null, language: string, short = false) {
  if (!lastUsedAt) return t("skills.usedNever");
  const date = new Date(lastUsedAt);
  const when =
    short && date.getFullYear() === new Date().getFullYear()
      ? date.toLocaleDateString(language, { month: "numeric", day: "numeric" })
      : date.toLocaleDateString(language);
  return t("skills.usedAt", { when });
}

/**
 * One muted line under a skill's name (chips wrapped a character per line in the
 * narrow panel). A built-in label distinguishes read-only planning references from user skills.
 */
export function skillMeta(
  t: T,
  skill: Skill,
  workflow: WorkflowSummary | undefined,
  language: string,
  roleName?: string,
): string {
  const parts: string[] = [];
  if (workflow?.contract && !skill.builtinKey)
    parts.push(
      workflow.version
        ? t("workflows.version", { version: workflow.version })
        : t("workflows.badge"),
    );
  if (workflow?.verified) parts.push(t("workflows.verified"));
  if (!skill.savedFromPlan)
    parts.push(
      skill.builtinKey
        ? t("skills.pick.builtin")
        : skill.source === "team"
          ? roleName
            ? t("skills.meta.fromRole", { name: roleName })
            : t("skills.meta.fromTeam")
          : t(sourceKey(skill.source)),
    );
  parts.push(usedText(t, skill.lastUsedAt, language, true));
  return parts.join(" · ");
}

function paramText(t: T, params: readonly SkillParam[]): string {
  if (!params.length) return "";
  const list = params
    .map((p) => (p.default !== undefined && p.default !== "" ? `${p.name}=${p.default}` : p.name))
    .join(t("skills.message.paramSeparator"));
  return t("skills.message.params", { list });
}

/** 「试运行一次」 is an ordinary chat message, so the run, its approvals and result stay visible. */
export function skillTrialMessage(t: T, name: string, params: readonly SkillParam[]): string {
  return t("skills.message.trial", { name, params: paramText(t, params) });
}

/** Prefill for 「做成调度任务」 ("按技能 X 做，参数 …"); routine names are ≤40. */
export function skillRoutineInitial(t: T, name: string, params: readonly SkillParam[]) {
  return {
    name: Array.from(name).slice(0, 40).join(""),
    instructions: t("skills.message.routine", { name, params: paramText(t, params) }).trim(),
  };
}

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FileRow {
  path: string;
  bytes: number;
  script: boolean;
  text?: boolean;
}
export type TreeRow =
  | { kind: "dir"; path: string; name: string; depth: number }
  | (FileRow & {
      kind: "file";
      name: string;
      depth: number;
    });
/**
 * Sorted `/` paths as an indented tree: each folder appears once, right before its first file.
 * Linear in the number of files (sorted input), so 500-file packages stay cheap to render.
 */
export function fileTree(files: readonly FileRow[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const shown = new Set<string>();
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const parts = file.path.split("/");
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const path = parts.slice(0, depth + 1).join("/");
      if (shown.has(path)) continue;
      shown.add(path);
      rows.push({ kind: "dir", path, name: parts[depth] ?? "", depth });
    }
    rows.push({ ...file, kind: "file", name: parts.at(-1) ?? file.path, depth: parts.length - 1 });
  }
  return rows;
}
