import type {
  Bot,
  ImageContent,
  ImageGenerationOptions,
  ImageOperation,
  Run,
  RunStopCause,
} from "@pibot/protocol-base";
import type { TaskAuthority } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { ChatRun } from "./chat-run.ts";

export interface QueueInput {
  backgroundCommandId?: string;
  /** Redacted output data; only agent's untrusted reference path may present it. */
  backgroundResults?: string;
  worktreeReview?: import("../workspaces/types.ts").WorktreeReceipt;
  /** Trusted task-tree snapshot; never accepted from an RPC or model tool's arguments. */
  continuationAuthority?: TaskAuthority;
  parentFollowThrough?: { planVersion: number };
  executionTaskId?: string;
  budgetRootRunId?: string;
  /** Trusted outer workflow whose budget applies to this run without injecting its body. */
  budgetWorkflow?: Pick<import("../workflows/workflow-prepare.ts").WorkflowRun, "contract">;
  /** Group workflow cost caps fail closed when a member model has no known price. */
  enforceBudgetCost?: boolean;
  /**
   * This run resumes an interrupted one (user's 「继续」). `note` is Pi Bot's trusted
   * runtime note (interrupted, which calls have an unknown outcome); never from RPC or tool input.
   */
  resume?: { fromRunId: string; note: string };
  /** A workflow skill run (pre-checks already passed); never from RPC or tool input. */
  workflow?: import("../workflows/workflow-prepare.ts").WorkflowRun;
  /** A `cheap` child task (from its persisted authority, never from tool input). */
  modelTier?: "cheap";
  imageOperation?: ImageOperation;
  imageGeneration?: ImageGenerationOptions;
  userInitiated?: boolean;
  routine?: {
    claim(run: ChatRun): boolean;
    settled(run: ChatRun, record: Run): Promise<void>;
  };
  runId?: string;
  bot: Bot;
  conversationId: string;
  text: string;
  images?: ImageContent[];
  userMessageId?: string;
  groupId?: string;
  threadId?: string;
  taskId?: string;
  cycleId?: string;
  automatic?: boolean;
  kind?: Run["kind"];
  parentRunId?: string;
  afterRunId?: string;
  ancestry?: string[];
  triggerKey?: string;
  replyToRunId?: string;
}

export interface Entry {
  record: Run;
  run: ChatRun;
  input: QueueInput;
  acceptedReply?: boolean;
  /** generateRun returned (SDK certified idle); a failed park may then complete the run itself. */
  drained?: boolean;
  admissionReady?: boolean;
  observingDrained?: boolean;
}

/**
 * Why the queue is ending runs. Four separate cancellation paths used to exist (a queued sweep, a
 * tree abort, the routine record cancel and the interactive drain); they now all select runs here.
 * The cause is diagnostic only: every one of them persisted `aborted` before, and still does.
 */
export type CancelReason = "aborted" | "cancelled" | "superseded" | "detached" | "shutdown";

export function abortRun(run: Pick<ChatRun, "controller" | "stopCause">, cause: RunStopCause) {
  run.stopCause ??= cause;
  run.controller.abort(run.stopCause);
}

export interface DrainedRun {
  record: Run;
  context?: ToolRunContext;
  /** Finalization has its own deadline: the original run signal is already aborted on normal exit. */
  signal: AbortSignal;
}
