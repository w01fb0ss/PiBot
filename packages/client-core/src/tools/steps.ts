import type { Approval, ToolCallRecord } from "@pibot/protocol";
import type { ActivityTool } from "./activity-types.ts";
import { toolTarget } from "./presentation.ts";

export interface ToolStep {
  tool: ActivityTool | ToolCallRecord;
  number: number;
  target?: string;
  approval?: Approval | NonNullable<ToolCallRecord["approval"]>;
  attention: boolean;
}

export function toolSteps(
  messageId: string,
  records: ToolCallRecord[],
  live: ActivityTool[],
  approvals: Approval[],
) {
  const tools = new Map<string, ActivityTool | ToolCallRecord>(
    records.map((record) => [record.toolCallId, record]),
  );
  for (const item of live) {
    if (item.messageId !== messageId) continue;
    const saved = tools.get(item.toolCallId);
    const finished = saved && !["pending", "running"].includes(saved.status);
    tools.set(item.toolCallId, finished ? { ...item, ...saved } : { ...saved, ...item });
  }
  const requests = new Map<string, Approval>();
  for (const request of approvals) {
    if (request.messageId !== messageId) continue;
    const previous = requests.get(request.toolCallId);
    // Redirects can ask again; a full pending card takes precedence over terminal snapshots.
    if (previous?.status !== "pending" || request.status === "pending")
      requests.set(request.toolCallId, request);
  }
  const steps: ToolStep[] = [];
  for (const tool of tools.values()) {
    const request = requests.get(tool.toolCallId);
    const stored = "approval" in tool ? tool.approval : undefined;
    const approval =
      request?.directRunRemember && request.status === "allowed" && stored?.remembered
        ? { ...request, remembered: true }
        : (request ?? stored);
    const fact = request?.facts.find((item) =>
      tool.tool === "read_file" || tool.tool === "list_dir"
        ? item.kind === "read"
        : tool.tool === "write_file" || tool.tool === "edit_file"
          ? item.kind === "write"
          : false,
    )?.value;
    steps.push({
      tool: approval?.explanation?.some((entry) => entry.code === "workspace_folder_added")
        ? { ...tool, status: "aborted" }
        : tool.status === "error" &&
            approval?.status === "denied" &&
            approval.explanation?.some(
              (entry) => entry.code === "approval_user_denied" && entry.effect === "deny",
            )
          ? { ...tool, status: "blocked", denialReason: "approval_user_denied" }
          : tool,
      number: steps.length + 1,
      target:
        fact ?? ("target" in tool ? tool.target : undefined) ?? toolTarget(tool.tool, tool.summary),
      approval: approval?.explanation?.some((entry) => entry.code === "workspace_folder_added")
        ? { ...approval, status: "cancelled" }
        : approval,
      // A done step that exits 1 (grep with no matches) needs no attention; the status
      // alone names a real failure, so the exit code no longer flags the row.
      attention:
        ["pending", "error", "blocked", "aborted"].includes(tool.status) ||
        (!!approval && approval.status !== "allowed"),
    });
  }
  return {
    steps,
    // Redirects normally have one pending request; retain every distinct pending card
    // if an event race delivers several for the same step instead of hiding consent.
    unmatched: [
      ...new Map(
        approvals
          .filter((request) => request.messageId === messageId)
          .map((request) => [request.id, request]),
      ).values(),
    ].filter(
      (request) =>
        !tools.has(request.toolCallId) ||
        (request.status === "pending" && requests.get(request.toolCallId)?.id !== request.id),
    ),
  };
}
