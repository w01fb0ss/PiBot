import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime, LocalToolResult } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import type {
  Bot,
  ImageContent,
  ImageMode,
  ImageModelInfo,
  ImageOperation,
  KernelEvents,
  KernelMethods,
  Peer,
} from "@pibot/protocol-base";
import type { ImageArtifactsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { BrainRedactor } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import type { ChatRun } from "../queue/chat-run.ts";

/** Only the host services required to settle an image run; no SDK session or queue control. */
export interface ImageRunHost {
  db: DatabaseSync;
  dataDir: string;
  agent: AgentRuntime;
  peer: Peer<typeof KernelMethods, typeof KernelEvents>;
  logger: Logger;
  redactor: BrainRedactor;
  local?: LocalService;
  language(): "zh" | "en";
  finished(run: ChatRun): void;
}

/** The engine owns admission and the run slot; the image capability owns paid generation and delivery. */
export type ImageDispatchModel = (
  hasImages: boolean,
  failure?: unknown,
  executionClock?: ToolRunContext["executionClock"],
) => Promise<Bot | undefined>;

export interface ImagesPort {
  requireModel(
    selected: { provider: string; id: string } | undefined,
    mode: ImageMode | undefined,
    signal: AbortSignal,
  ): Promise<ImageModelInfo>;
  name(input: {
    description: string;
    language: "zh" | "en";
    signal: AbortSignal;
    agent: AgentRuntime;
    preferences: ({ provider: string; id: string } | null | undefined)[];
    credentials(provider: string): Promise<void>;
    logger: import("@pibot/observability").Logger;
  }): Promise<string>;
  assertVisible(
    context: Pick<ToolRunContext, "botId" | "conversationId" | "groupId" | "threadId" | "runId">,
    operation: ImageOperation,
  ): ReturnType<ImageArtifactsRepo["resolveSource"]>;
  execute(context: ToolRunContext, operation: ImageOperation): Promise<LocalToolResult>;
  run(
    deps: ImageRunHost,
    run: ChatRun,
    text: string,
    bot: Bot,
    images: ImageContent[],
    dispatchModel?: ImageDispatchModel,
  ): Promise<void>;
}
