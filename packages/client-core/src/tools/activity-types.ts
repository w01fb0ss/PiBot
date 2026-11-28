import type { Approval, EventPayloads, ToolCallRecord } from "@pibot/protocol";

export type RunActivityEvent = Exclude<EventPayloads["chat.activity"], { phase: "clear" }>;
export type LiveRunActivity = RunActivityEvent & { startedAt: number };

export interface ActivityTool
  extends Pick<
    ToolCallRecord,
    | "toolCallId"
    | "tool"
    | "summary"
    | "status"
    | "exitCode"
    | "durationMs"
    | "yolo"
    | "denialReason"
    | "settingsAction"
    | "codeAnalysis"
    | "inputTranslation"
  > {
  messageId: string;
  runId: string;
  output: string;
  target?: string;
  /** Waiting for this Bot (name, may be empty) to finish writing the same folder. */
  waitingFor?: string;
}
export interface ActivityState {
  approvals: Approval[];
  tools: ActivityTool[];
  runActivity?: LiveRunActivity;
  error: boolean;
}
