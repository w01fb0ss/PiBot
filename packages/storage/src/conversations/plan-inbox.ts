import { GroupPlansRepo } from "../groups/group-plans.ts";
import { MessagesRepo } from "../workspace/repositories.ts";
import type { InboxSource } from "./inbox.ts";

// The same durable projection drives counts, keyset pages and sidebar waiting, including old cards.
// A started plan that holds for the user's choice (no replans left, or a skipped repair) is
// listed by its card, which carries the choice; a replacement in its chain shares the budget root.
export const pendingPlanRows = `SELECT m.id,m.created_at AS at,m.id AS messageId,
  g.id AS groupId,g.name AS groupName FROM messages m
  JOIN conversations c ON c.id=m.conversation_id AND c.kind='group'
  JOIN groups g ON g.id=c.group_id
  JOIN group_cycles cy ON cy.group_id=g.id
  WHERE c.archived_at IS NULL AND g.paused=0 AND cy.limited=0
  AND json_extract(m.usage,'$.groupPlan.groupId')=g.id
  AND json_extract(m.usage,'$.groupPlan.cycleId')=cy.cycle_id
  AND m.bot_id=g.coordinator_bot_id
  AND ((json_extract(m.usage,'$.groupPlan.status') IN ('pending','ready','starting','modify')
    AND NOT EXISTS (SELECT 1 FROM group_workflow_runs w
      WHERE w.id=json_extract(m.usage,'$.groupPlan.id'))
    AND (json_extract(m.usage,'$.groupPlan.replacesWorkflowRunId') IS NULL OR EXISTS (
      SELECT 1 FROM group_workflow_runs prior
      WHERE prior.id=json_extract(m.usage,'$.groupPlan.replacesWorkflowRunId')
      AND prior.group_id=g.id AND prior.cycle_id=cy.cycle_id AND prior.status IN ('running','waiting'))))
    OR (json_extract(m.usage,'$.groupPlan.status')='started' AND EXISTS (
      SELECT 1 FROM group_workflow_runs w WHERE w.id=json_extract(m.usage,'$.groupPlan.id')
      AND w.group_id=g.id AND w.cycle_id=cy.cycle_id AND w.status='failed'
      AND json_extract(w.workflow_json,'$.progress.stoppedReason')='cost'
      AND EXISTS (SELECT 1 FROM group_workflow_steps s WHERE s.workflow_run_id=w.id
        AND s.status='blocked')
      AND NOT EXISTS (SELECT 1 FROM group_workflow_runs next WHERE next.group_id=w.group_id
        AND next.cycle_id=w.cycle_id AND next.rowid>w.rowid)))
    OR (json_extract(m.usage,'$.groupPlan.status')='started' AND EXISTS (
      SELECT 1 FROM group_workflow_runs w WHERE w.group_id=g.id AND w.cycle_id=cy.cycle_id
      AND w.status IN ('running','waiting')
      AND json_extract(w.workflow_json,'$.progress.hold.kind') IS NOT NULL
      AND (w.id=json_extract(m.usage,'$.groupPlan.id')
        OR w.budget_root_run_id=json_extract(m.usage,'$.groupPlan.budgetRootRunId')))))
  AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=m.conversation_id
    AND newer.rowid>m.rowid AND json_extract(newer.usage,'$.groupPlan.cycleId')=cy.cycle_id)`;

export const planInboxSource: InboxSource = {
  select: `SELECT 'group_plan',id,at,messageId FROM (${pendingPlanRows})`,
  counts: { group_plan: `SELECT COUNT(*) FROM (${pendingPlanRows})` },
  item(row, _context, db) {
    const entry = new GroupPlansRepo(db).get(row.id);
    if (!entry) throw new Error("group_plan_inbox_unavailable");
    return {
      messageId: entry.message.id,
      conversationId: entry.message.conversationId,
      card: entry.card,
      groupId: entry.card.groupId,
    };
  },
};

// Resolved/stale cards stay in chat, but never keep an inbox badge alive.
export const pendingPlanActionRows = `SELECT m.id,m.created_at AS at,m.id AS messageId,
  g.id AS groupId,g.name AS groupName FROM messages m
  JOIN conversations c ON c.id=m.conversation_id AND c.kind='group'
  JOIN groups g ON g.id=c.group_id
  JOIN group_cycles cy ON cy.group_id=g.id
  WHERE c.archived_at IS NULL
  AND m.bot_id=g.coordinator_bot_id AND (
    (json_extract(m.usage,'$.groupWorkflowDecision.state')='pending' AND EXISTS (
      SELECT 1 FROM group_workflow_runs w
      WHERE w.id=json_extract(m.usage,'$.groupWorkflowDecision.workflowRunId')
      AND w.group_id=g.id AND w.cycle_id=cy.cycle_id
      AND json_extract(m.usage,'$.groupWorkflowDecision.groupId')=g.id
      AND ((w.status='waiting' AND json_extract(w.workflow_json,'$.manualReviewMessageId')=m.id)
        OR (w.status IN ('running','waiting') AND EXISTS (
        SELECT 1 FROM group_workflow_steps step WHERE step.workflow_run_id=w.id
        AND step.step_id=json_extract(m.usage,'$.groupWorkflowDecision.stepId')
        AND step.decision_message_id=m.id AND step.status='blocked')))
    )) OR (json_extract(m.usage,'$.groupPlanLimit.groupId')=g.id
      AND json_extract(m.usage,'$.groupPlanLimit.cycleId')=cy.cycle_id AND EXISTS (
        SELECT 1 FROM settings s WHERE s.key='group-plan-attempts:'||g.id
        AND json_extract(s.value,'$.cycleId')=cy.cycle_id
        AND json_extract(s.value,'$.status')='waiting'
        AND json_extract(s.value,'$.messageId')=m.id
      ))
  )`;

export const planActionInboxSource: InboxSource = {
  select: `SELECT 'group_plan_action',id,at,messageId FROM (${pendingPlanActionRows})`,
  counts: { group_plan_action: `SELECT COUNT(*) FROM (${pendingPlanActionRows})` },
  item(row, _context, db) {
    const message = new MessagesRepo(db).get(row.id);
    const group = db
      .prepare("SELECT group_id FROM conversations WHERE id=?")
      .get(message?.conversationId ?? "");
    if (!message || !group) throw new Error("group_plan_action_unavailable");
    return { message, groupId: group.group_id };
  },
};
