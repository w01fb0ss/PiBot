import type { DatabaseSync } from "node:sqlite";
import { type DispatchModelRoute, DispatchModelRouteSchema } from "@pibot/protocol-base";

export class DispatchModelRoutesRepo {
  constructor(private readonly db: DatabaseSync) {}

  origin(dispatchId: string, conversationId: string) {
    const row = this.db
      .prepare(`SELECT pi_bot_id AS botId, pi_run_id AS runId, pi_message_id AS messageId,
        m.conversation_id AS conversationId, title
        FROM pi_dispatches d JOIN messages m ON m.id=d.pi_message_id
        WHERE d.id=? AND d.target_conversation_id=?`)
      .get(dispatchId, conversationId);
    return (
      row && {
        botId: String(row.botId),
        runId: String(row.runId),
        messageId: String(row.messageId),
        conversationId: String(row.conversationId),
        title: String(row.title),
      }
    );
  }

  get(conversationId: string, scope = "topic"): DispatchModelRoute | undefined {
    const row = this.db
      .prepare("SELECT route FROM pi_dispatch_models WHERE conversation_id=? AND scope=?")
      .get(conversationId, scope);
    return typeof row?.route === "string"
      ? DispatchModelRouteSchema.parse(JSON.parse(row.route))
      : undefined;
  }

  set(conversationId: string, scope: string, route: DispatchModelRoute) {
    this.db
      .prepare(`INSERT INTO pi_dispatch_models(conversation_id,scope,route) VALUES (?,?,?)
        ON CONFLICT(conversation_id,scope) DO UPDATE SET route=excluded.route`)
      .run(conversationId, scope, JSON.stringify(DispatchModelRouteSchema.parse(route)));
  }

  clear(conversationId: string, scope: string) {
    this.db
      .prepare("DELETE FROM pi_dispatch_models WHERE conversation_id=? AND scope=?")
      .run(conversationId, scope);
  }
}
