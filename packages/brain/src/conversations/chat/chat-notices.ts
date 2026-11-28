import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "@pibot/observability";
import {
  DomainSchema,
  type KernelEvents,
  type KernelMethods,
  type Peer,
} from "@pibot/protocol-base";
import { ChatNoticesRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { BrowserHandBackRecorder } from "../../runtime/browser/port.ts";

/** Hostname of an http(s) address, or nothing (blank tabs, IPv6 literals, other schemes). */
export function siteOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return undefined;
    const domain = DomainSchema.safeParse(parsed.hostname);
    return domain.success ? domain.data : undefined;
  } catch {
    // Not a URL (empty or opaque address): there is simply no site to mention.
    return undefined;
  }
}

/**
 * Chat system records (centered lines in the timeline). They are written for the user only:
 * the model already learns about a hand-back from its next browser tool result.
 */
export class ChatNoticeService implements BrowserHandBackRecorder {
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      peer: Pick<Peer<typeof KernelMethods, typeof KernelEvents>, "emit">;
      logger: Pick<Logger, "warn">;
    },
  ) {}

  /** The Bot's own DM topic, or a group (or its task thread) the Bot is a member of. */
  place(botId: string, conversationId: string): string | undefined {
    const conversation = new ConversationsRepo(this.deps.db).get(conversationId);
    if (!conversation || conversation.archivedAt) return undefined;
    if (conversation.kind === "dm")
      return conversation.botId === botId ? conversation.id : undefined;
    const group = conversation.groupId
      ? new GroupsRepo(this.deps.db).get(conversation.groupId)
      : undefined;
    return group?.members.some((member) => member.botId === botId) ? conversation.id : undefined;
  }

  browserHandBack(input: {
    botId: string;
    conversationId: string;
    durationMs: number;
    domains: string[];
    signedIn?: string[];
  }) {
    try {
      const notice = new ChatNoticesRepo(this.deps.db).addBrowserHandBack(input);
      this.deps.peer.emit("chat.notice", notice);
    } catch {
      // The record is informational; the hand-back itself (audit, Bot note) already happened.
      // A topic deleted meanwhile is the expected case; nothing user-facing depends on it.
      this.deps.logger.warn(`chat notice not recorded botId=${input.botId}`);
    }
  }

  listDependencies(conversationId: string, page: { before?: string; limit?: number }) {
    return new ChatNoticesRepo(this.deps.db).listDependencies(conversationId, page);
  }

  list(conversationId: string, page: { before?: string; limit?: number }) {
    return new ChatNoticesRepo(this.deps.db).list(conversationId, page);
  }
}

/** Registered through brain's single RPC wrapper (validation, redacted logging, error mapping). */
export function registerChatNoticeRpc(handle: KernelRegisterRpc, notices: ChatNoticeService) {
  handle("chat.dependencyNotices", async ({ conversationId, before, limit }) =>
    notices.listDependencies(conversationId, { before, limit }),
  );
  handle("chat.notices", async ({ conversationId, before, limit }) =>
    notices.list(conversationId, { before, limit }),
  );
}
