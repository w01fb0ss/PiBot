import { createHash } from "node:crypto";
import { memoryWritePolicy } from "@pibot/policy";
import type { ApprovalFact } from "@pibot/protocol-base";
import { BotsRepo, GroupsRepo } from "@pibot/storage";
import { auditText } from "../../core/audit-fields.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissionScope } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { memoryProjectPath } from "../memory/project.ts";
import type { ToolInput } from "./tools.ts";

export function memoryWriteFacts(local: LocalService, context: ToolRunContext, input: ToolInput) {
  if (
    input.tool !== "memory_add" &&
    input.tool !== "memory_update" &&
    input.tool !== "memory_remove"
  )
    return undefined;
  const groupId = runPermissionScope(local, context);
  const project = memoryProjectPath(context);
  const target =
    input.tool === "memory_add"
      ? undefined
      : local.memory.writeTarget(context.botId, input.args.id, input.args.scope, groupId, project);
  const scope =
    input.args.scope ??
    target?.scope ??
    (input.tool === "memory_add" && input.args.category === "about_you"
      ? "user"
      : groupId
        ? "group"
        : "bot");
  const text =
    input.tool === "memory_add"
      ? input.args.text
      : input.tool === "memory_update" && input.args.text !== undefined
        ? input.args.text
        : target?.text;
  return {
    text,
    scope,
    afterUntrusted: context.untrustedContent?.seen === true,
    tool: input.tool,
    target,
    groupId,
    project,
  };
}

type WriteFacts = NonNullable<ReturnType<typeof memoryWriteFacts>>;

export function memorySafetySnapshot(facts: WriteFacts) {
  return {
    digest: createHash("sha256")
      .update(JSON.stringify([facts.text, facts.target?.text, facts.target?.updatedAt]))
      .digest("hex"),
    reason: memoryWritePolicy(facts).reason,
    scope: facts.scope,
  };
}

export function memoryApprovalFacts(
  local: LocalService,
  botId: string,
  facts: WriteFacts,
): ApprovalFact[] {
  const { db, redactor } = local.deps;
  const owner: ApprovalFact =
    facts.scope === "user"
      ? { kind: "read", labelKey: "memoryUser", value: "user" }
      : facts.scope === "group"
        ? {
            kind: "read",
            labelKey: "memoryGroup",
            value: new GroupsRepo(db).get(facts.groupId ?? "")?.name ?? facts.groupId ?? "",
          }
        : facts.scope === "project"
          ? { kind: "read", labelKey: "memoryProject", value: facts.project ?? "" }
          : {
              kind: "read",
              labelKey: "memoryBot",
              value: new BotsRepo(db).get(botId)?.name ?? botId,
            };
  const rows: ApprovalFact[] = [{ ...owner, value: auditText(owner.value, redactor, 160) || "—" }];
  const preview = (text: string) =>
    memoryWritePolicy({ text }).reason === "memory_sensitive"
      ? "[REDACTED]"
      : auditText(text, redactor, 240) || "—";
  const before = facts.target && preview(facts.target.text);
  const after = facts.text !== undefined ? preview(facts.text) : undefined;
  if (facts.tool === "memory_update" && before && after)
    rows.push({ kind: "write", labelKey: "memoryChange", value: `${before} → ${after}` });
  else if (facts.tool === "memory_remove" && before)
    rows.push({ kind: "write", labelKey: "memoryRemove", value: before });
  else if (after) rows.push({ kind: "write", labelKey: "memoryNote", value: after });
  return rows;
}
