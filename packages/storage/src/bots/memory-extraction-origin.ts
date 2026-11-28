import type { DatabaseSync } from "node:sqlite";

/** Trusted message provenance only; model text and topic titles never identify a person. */
export const memoryHumanMessageSql = `m.import_id IS NULL AND m.role='user' AND m.status='done' AND m.bot_id IS NULL
  AND m.routine_trigger IS NULL AND COALESCE(json_extract(m.usage,'$.systemEvent'),0)=0
  AND COALESCE(json_extract(m.usage,'$.inputOrigin'),'')<>'acp'
  AND NOT EXISTS (SELECT 1 FROM runs mr WHERE mr.user_message_id=m.id AND mr.automatic=1)
  AND (json_extract(m.usage,'$.inputOrigin')='user' OR (
    NOT EXISTS (SELECT 1 FROM conversations mc WHERE mc.id=m.conversation_id
      AND (mc.routine_id IS NOT NULL OR mc.internal_task_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.kind='acp.session.new'
      AND json_extract(a.detail,'$.conversationId')=m.conversation_id)))`;

export function extractionAutomatedReason(
  db: DatabaseSync,
  conversationId: string,
): string | undefined {
  if (
    db
      .prepare(
        `SELECT 1 FROM messages m WHERE m.conversation_id=? AND (${memoryHumanMessageSql}) LIMIT 1`,
      )
      .get(conversationId)
  )
    return undefined;
  const topic = db
    .prepare("SELECT routine_id, internal_task_id FROM conversations WHERE id=?")
    .get(conversationId);
  if (!topic) return "topic_missing";
  if (topic.routine_id != null) return "automation_routine";
  if (topic.internal_task_id != null) return "automation_internal_task";
  if (
    db
      .prepare(
        `SELECT 1 FROM audit_log WHERE kind='acp.session.new' AND json_extract(detail,'$.conversationId')=? LIMIT 1`,
      )
      .get(conversationId) ||
    db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id=? AND json_extract(usage,'$.inputOrigin')='acp' LIMIT 1`,
      )
      .get(conversationId)
  )
    return "automation_acp";
  return "automation_no_human";
}
