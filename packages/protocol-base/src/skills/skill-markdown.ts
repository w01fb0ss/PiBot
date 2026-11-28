import { flat, oneLine, parseSkillFile, SkillFileParamsSchema, storedName } from "./skill-file.ts";
import {
  SKILL_BODY_MAX_BYTES,
  type SkillDocument,
  SkillDocumentBaseSchema,
  type SkillParam,
} from "./skills.ts";

/** What the SKILL.md editor can point at below the text box; one i18n message each. */
export const SKILL_MARKDOWN_ISSUES = [
  "front_matter",
  "name_missing",
  "name_too_long",
  "name_invalid",
  "description_missing",
  "description_too_long",
  "description_invalid",
  "body_missing",
  "body_too_large",
  "body_invalid",
  "params_invalid",
] as const;
export type SkillMarkdownIssue = (typeof SKILL_MARKDOWN_ISSUES)[number];

export type SkillMarkdownResult =
  | { ok: true; document: SkillDocument }
  | { ok: false; issues: SkillMarkdownIssue[] };

/**
 * The SKILL.md a person edits: `name` is the display name (not the folder slug the saved file
 * uses), parameters stay where saved files keep them (`metadata.pibot-params`). Version and work
 * contract are left out: the editor never changed them and a patch without them keeps them.
 */
export function renderSkillMarkdown(
  document: Pick<SkillDocument, "name" | "description" | "body"> & { params: SkillParam[] },
): string {
  const lines = [
    "---",
    `name: ${yamlScalar(document.name)}`,
    `description: ${yamlScalar(oneLine(document.description))}`,
  ];
  if (document.params.length) {
    const json = JSON.stringify(document.params);
    // Bare JSON is valid flow YAML and easier to edit; ` #` would start a YAML comment.
    lines.push("metadata:", `  pibot-params: ${/\s#/.test(json) ? JSON.stringify(json) : json}`);
  }
  lines.push("---", "", document.body);
  return lines.join("\n");
}

/**
 * Reads what the editor submits. Accepts both a hand-written file (`name` = display name) and a
 * saved Agent Skills file (`name` = slug, display name in `metadata.pibot-name`), like an import.
 */
export function parseSkillMarkdown(text: string): SkillMarkdownResult {
  const parsed = parseSkillFile(text);
  if (!parsed.frontMatter) return { ok: false, issues: ["front_matter"] };
  const issues = new Set<SkillMarkdownIssue>();
  let params: unknown = [];
  const rawParams = parsed.metadata["pibot-params"];
  if (rawParams?.trim()) {
    try {
      params = SkillFileParamsSchema.parse(JSON.parse(rawParams));
    } catch {
      issues.add("params_invalid");
    }
  }
  return validateSkillFields(
    {
      name: unfilled(flat(storedName(parsed) ?? "")),
      description: unfilled(flat(parsed.fields.description ?? "")),
      body: parsed.body,
      params,
    },
    issues,
  );
}

export function validateSkillFields(
  fields: { name: string; description: string; body: string; params: unknown },
  issues = new Set<SkillMarkdownIssue>(),
): SkillMarkdownResult {
  if (!fields.body.trim()) issues.add("body_missing");
  const result = SkillDocumentBaseSchema.safeParse(fields);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0];
      if (field === "params") issues.add("params_invalid");
      else if (field === "body") {
        if (!fields.body.trim()) issues.add("body_missing");
        else if (new TextEncoder().encode(fields.body).byteLength > SKILL_BODY_MAX_BYTES)
          issues.add("body_too_large");
        else issues.add("body_invalid");
      } else if (field === "name" || field === "description") {
        issues.add(
          issue.code === "too_small"
            ? `${field}_missing`
            : issue.code === "too_big"
              ? `${field}_too_long`
              : `${field}_invalid`,
        );
      }
    }
  }
  if (issues.size || !result.success) {
    return { ok: false, issues: issues.size ? [...issues] : ["body_invalid"] };
  }
  return { ok: true, document: result.data };
}

/**
 * The new-skill template writes `<…>` where a value goes; saving it untouched must read as
 * "not filled in", not as a skill literally named `<技能名>`.
 */
function unfilled(value: string): string {
  return /^<[^<>]*>$/.test(value) ? "" : value;
}

/** Plain YAML when it reads back unchanged in any YAML parser, a JSON (double-quoted) string otherwise. */
function yamlScalar(value: string): string {
  const plain = /^[^\s"'|>[\]{}&*!%@`#,?:-]/.test(value) && !/:\s|:$|\s#|\s$/.test(value);
  return plain ? value : JSON.stringify(value);
}
