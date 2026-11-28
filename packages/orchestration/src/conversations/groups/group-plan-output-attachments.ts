import {
  deliveryFile,
  groupWorkplace,
  type PreparedAttachments,
  workspaceFiles,
} from "@pibot/brain/orchestration-kit";
import {
  FILE_LIMIT,
  GroupRelativePathSchema,
  MAX_REPLY_ATTACHMENTS,
  type Message,
} from "@pibot/protocol-base";
import {
  type GroupWorkflowRunRecord,
  type GroupWorkflowStepRecord,
  MessagesRepo,
} from "@pibot/storage";
import { assertPlanWorkplace } from "./group-plan-workplace.ts";
import type { GroupService } from "./group-service.ts";
import type { StoredWorkflow } from "./group-workflow-snapshot.ts";

/** Snapshot settled outputs using the same attachment service as chat's file delivery. */
export async function preparePlanOutputs(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  workflow: StoredWorkflow,
  steps: readonly GroupWorkflowStepRecord[],
  parent: AbortSignal,
) {
  const recorded = steps.flatMap((step) =>
    step.status === "passed"
      ? step.deliverables.flatMap((item) =>
          item && typeof item === "object" && "path" in item && typeof item.path === "string"
            ? [item.path]
            : [],
        )
      : [],
  );
  const attachments: PreparedAttachments[] = [];
  const unavailable: string[] = [];
  if (!recorded.length) return { attachments, unavailable };

  const signal = AbortSignal.any([parent, service.signal, AbortSignal.timeout(20_000)]);
  const current = () => {
    signal.throwIfAborted();
    assertPlanWorkplace(service, record.id);
  };
  const warn = () =>
    service.deps.logger.warn(
      JSON.stringify({
        module: "group-workflow",
        event: "output_attachment_unavailable",
        workflowRunId: record.id,
      }),
    );
  try {
    current();
    const group = service.active(record.groupId, record.coordinatorBotId);
    const place = await groupWorkplace(
      service.deps.local,
      record.coordinatorBotId,
      workflow.workplace ? { ...group, ...workflow.workplace } : group,
      signal,
    );
    const access = workspaceFiles(service.deps.local, place.boundary, current);
    const { basename, isAbsolute, relative, resolve, sep } = access.paths;
    const portable = (path: string) => path.split(sep).join("/");
    const folder = GroupRelativePathSchema.parse(portable(relative(place.cwd, workflow.folder)));
    if (!folder) return { attachments, unavailable };
    const prefix = `${folder}/`;
    const targets = new Map<string, string>();
    for (const raw of recorded) {
      const path = isAbsolute(raw) ? portable(relative(place.cwd, raw)) : portable(raw);
      if (!GroupRelativePathSchema.safeParse(path).success || !path) continue;
      // Contracts store paths relative to the output folder, while change receipts can repeat
      // those same paths from the workspace root. Attach only files inside this plan's folder.
      const normalized = path.startsWith(prefix)
        ? path
        : isAbsolute(raw)
          ? undefined
          : prefix + path;
      if (!normalized) continue;
      targets.set(sep === "\\" ? normalized.toLowerCase() : normalized, normalized);
    }
    for (const path of targets.values()) {
      const name = service.deps.redactor.redact(basename(path));
      try {
        current();
        const source = await deliveryFile(
          place.cwd,
          resolve(place.cwd, path),
          signal,
          FILE_LIMIT,
          access,
        );
        if (!source?.data) {
          if (source) unavailable.push(name);
          continue;
        }
        attachments.push(
          await service.deps.chat.attachments.prepareOutput(
            record.coordinatorBotId,
            [{ name, bytes: source.data }],
            signal,
          ),
        );
      } catch (error) {
        if (signal.aborted) {
          unavailable.push(name);
          continue;
        }
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")) continue;
        unavailable.push(name);
        warn();
      }
    }
  } catch {
    // Unavailable folders or attachment IO cannot undo a settled plan.
    warn();
  }
  return { attachments, unavailable };
}

/** Called inside the completion transaction so cards cannot outlive their summary or repeat on recovery. */
export function persistPlanOutputs(
  service: GroupService,
  record: GroupWorkflowRunRecord,
  summary: Message,
  attachments: readonly PreparedAttachments[],
) {
  const messages = new MessagesRepo(service.deps.db);
  let target = summary;
  for (const [index, batch] of attachments.entries()) {
    // The wire schema bounds cards per bubble. Overflow stays next to its summary in history.
    if (index > 0 && index % MAX_REPLY_ATTACHMENTS === 0)
      target = messages.create({
        conversationId: summary.conversationId,
        botId: record.coordinatorBotId,
        role: "assistant",
        content: "",
        status: "done",
        markUnread: false,
      });
    service.deps.chat.attachments.persist(target.id, batch, record.coordinatorBotId);
    for (const { metadata } of batch.items)
      service.deps.local.approvals.audit.append({
        botId: record.coordinatorBotId,
        kind: "file.sent",
        summary: "Attached a plan output / 已附上计划产出",
        detail: {
          groupId: record.groupId,
          workflowRunId: record.id,
          target: metadata.name,
          bytes: metadata.size,
        },
      });
  }
}
