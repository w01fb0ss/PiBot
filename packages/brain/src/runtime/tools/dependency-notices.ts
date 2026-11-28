import type { ChatDependencyNotice } from "@pibot/protocol-base";
import { ChatNoticesRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

type Dependency = ChatDependencyNotice["dependency"];

export function noteDependency(
  local: LocalService,
  context: ToolRunContext,
  dependency: Dependency,
) {
  if (!context.conversationId) return;
  try {
    const notice = new ChatNoticesRepo(local.deps.db).addAgentWarning({
      botId: context.botId,
      runId: context.runId,
      conversationId: context.conversationId,
      text: `${dependency} (${context.runId})`,
      dependency,
    });
    if (notice) {
      local.deps.peer.emit("chat.notice", notice);
      const { id, conversationId, runId, createdAt } = notice;
      local.deps.peer.emit("chat.dependencyNotice", {
        id,
        conversationId,
        runId,
        dependency,
        createdAt,
      });
    }
  } catch {
    local.deps.logger.warn(
      JSON.stringify({ module: "execution", event: "dependency_notice_failed", dependency }),
    );
  }
}
