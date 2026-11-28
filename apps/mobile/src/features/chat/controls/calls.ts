import type { ChangesTurn, ChatAdditionMode, ExecutionMode } from "@pibot/protocol";
import { type Caller, type ChatScope, changesTarget, executionScope } from "./scope.ts";

// Plain RPC sequences behind each chat control. Hooks add state and cancellation;
// the in-memory dev scenario calls these directly to list the methods a control uses.

export interface TopicRow {
  id: string;
  title?: string;
  importSource?: string;
  isCurrent: boolean;
  updatedAt: string;
}
export async function listTopics(
  c: Caller,
  kind: ChatScope["kind"],
  id: string,
  signal?: AbortSignal,
) {
  const rows =
    kind === "bot"
      ? await c.call("topics.list", { botId: id, limit: 50 }, signal)
      : await c.call("groups.topics.list", { groupId: id, limit: 50 }, signal);
  return rows.map(
    (row): TopicRow => ({
      id: row.id,
      title: row.title,
      ...("importSource" in row && row.importSource ? { importSource: row.importSource } : {}),
      isCurrent: !!row.isCurrent,
      updatedAt: row.updatedAt,
    }),
  );
}
/** Returns the topic that is current afterwards. */
export async function switchTopic(
  c: Caller,
  kind: ChatScope["kind"],
  id: string,
  topicId: string,
  signal?: AbortSignal,
) {
  if (kind === "bot") return (await c.call("topics.switch", { botId: id, topicId }, signal)).id;
  return (await c.call("groups.topics.switch", { groupId: id, topicId }, signal)).conversationId;
}
export async function createTopic(
  c: Caller,
  kind: ChatScope["kind"],
  id: string,
  signal?: AbortSignal,
) {
  if (kind === "bot") return (await c.call("topics.create", { botId: id }, signal)).id;
  // A request ID makes a retried create idempotent; the new topic keeps the current folders.
  const group = await c.call(
    "groups.topics.create",
    { groupId: id, requestId: crypto.randomUUID() },
    signal,
  );
  return group.conversationId;
}
export async function readWorkplace(c: Caller, scope: ChatScope, signal?: AbortSignal) {
  const target = { botId: scope.id, topicId: scope.topicId };
  const [current, all] = await Promise.all([
    c.call("topics.workplace.get", target, signal),
    c.call("workplaces.list", { botId: scope.id }, signal),
  ]);
  const folderId = current.folderId ?? "home";
  const readonly = current.readonly ?? [];
  const writable = current.writable ?? [];
  // Only folders the user already associated; adding one needs the computer's folder dialog.
  const listed = all.folders.filter((folder) => folder.association !== "monitor");
  // v0.0.2 B7: the topic may sit in a folder the registry hides (removed from the list, watched
  // only); the chip then said "Bot's own folder" while runs used that folder. The topic's own
  // folders come from its workplace answer and stay first, so the chip and sheet name them.
  const known = new Set(listed.map((folder) => folder.id));
  const used = new Set([folderId, ...readonly, ...writable]);
  const own = current.workplace.folders.filter(
    (folder) => used.has(folder.id) && !known.has(folder.id),
  );
  return {
    folderId,
    readonly,
    writable,
    busy: current.busy,
    home: all.home,
    folders: [...own, ...listed],
    /** The topic's folder is on a runner that is offline: runs fail until it returns or moves. */
    runnerOffline: current.runnerOffline === true,
  };
}
export function setWorkplace(c: Caller, scope: ChatScope, folderId: string, signal?: AbortSignal) {
  return c.call(
    "topics.workplace.set",
    { botId: scope.id, topicId: scope.topicId, folderId: folderId === "home" ? "home" : folderId },
    signal,
  );
}
export function readPlan(c: Caller, scope: ChatScope, signal?: AbortSignal) {
  return c.call("execution.todo.get", executionScope(scope), signal);
}
export function readMode(c: Caller, scope: ChatScope, signal?: AbortSignal) {
  return c.call("execution.get", executionScope(scope), signal);
}
export function setMode(
  c: Caller,
  scope: ChatScope,
  mode: ExecutionMode,
  expectedVersion: number,
  signal?: AbortSignal,
) {
  return c.call("execution.set", { ...executionScope(scope), expectedVersion, mode }, signal);
}
export function readYolo(c: Caller, scope: ChatScope, signal?: AbortSignal) {
  return c.call("conversations.yolo.get", { conversationId: scope.topicId }, signal);
}
export function setYolo(c: Caller, scope: ChatScope, enabled: boolean, signal?: AbortSignal) {
  return c.call("conversations.yolo.set", { conversationId: scope.topicId, enabled }, signal);
}
export function readChanges(c: Caller, scope: ChatScope, signal?: AbortSignal) {
  return c.call("changes.turn", changesTarget(scope), signal, 30_000);
}
/** Restores one file of the latest changing turn from its retained checkpoint. */
export async function restoreFile(
  c: Caller,
  scope: ChatScope,
  turn: ChangesTurn,
  path: string,
  signal?: AbortSignal,
) {
  const checkpointId = turn.checkpoint?.state === "retained" ? turn.checkpoint.checkpointId : null;
  if (!checkpointId) throw new Error("restore_unavailable");
  const target = changesTarget(scope);
  const checkpoint = await c.call("changes.checkpoints.get", { target, id: checkpointId }, signal);
  const item = checkpoint.items.find((entry) => entry.path === path);
  if (!item?.restorable || checkpoint.state === "expired" || checkpoint.runId !== turn.runId)
    throw new Error("restore_unavailable");
  return c.call(
    "changes.checkpoints.restore",
    {
      target,
      id: checkpoint.id,
      requestId: crypto.randomUUID(),
      expectedVersion: checkpoint.version,
      itemIds: [item.id],
    },
    signal,
    120_000,
  );
}
export function previewRetry(c: Caller, scope: ChatScope, messageId: string, signal?: AbortSignal) {
  return c.call(
    "chat.retryPreview",
    { botId: scope.id, conversationId: scope.topicId, messageId },
    signal,
  );
}
export function retryFrom(
  c: Caller,
  scope: ChatScope,
  messageId: string,
  hash: string,
  signal?: AbortSignal,
) {
  return c.call(
    "chat.retryFromMessage",
    {
      botId: scope.id,
      conversationId: scope.topicId,
      messageId,
      requestId: crypto.randomUUID(),
      hash,
      confirmed: true,
    },
    signal,
  );
}
export function answerQuestion(
  c: Caller,
  messageId: string,
  optionId: string,
  signal?: AbortSignal,
) {
  return c.call("execution.question.answer", { messageId, reply: { optionId } }, signal, 95_000);
}
export function compact(c: Caller, scope: ChatScope, requestId: string, signal?: AbortSignal) {
  return c.call(
    "chat.compact",
    { ...executionScope(scope), requestId, fork: false },
    signal,
    180_000,
  );
}
export function cancelCompact(
  c: Caller,
  scope: ChatScope,
  requestId: string,
  signal?: AbortSignal,
) {
  return c.call("chat.compact.cancel", { ...executionScope(scope), requestId }, signal);
}
export function readBudget(c: Caller, scope: ChatScope, runId: string, signal?: AbortSignal) {
  return c.call("execution.budget.get", { ...executionScope(scope), runId }, signal);
}
/** Steer (before the next step) or follow up (after this reply) on the DM's running reply. */
export function appendToRun(
  c: Caller,
  scope: ChatScope,
  runId: string,
  mode: ChatAdditionMode,
  text: string,
  signal?: AbortSignal,
) {
  return c.call(
    "chat.append",
    { botId: scope.id, topicId: scope.topicId, runId, requestId: crypto.randomUUID(), mode, text },
    signal,
  );
}
