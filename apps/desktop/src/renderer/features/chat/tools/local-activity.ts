import type { ActivityState, ActivityTool, ChatPeer, LiveRunActivity } from "@pibot/client-core";
import { toolTarget } from "@pibot/client-core";
import type { Approval, EventPayloads } from "@pibot/protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";

export type { ActivityState, ActivityTool } from "@pibot/client-core";

const key = (messageId: string, toolCallId: string) => JSON.stringify([messageId, toolCallId]);
const tail = (text: string) => text.slice(-40_000).split("\n").slice(-200).join("\n");

/** Separate tool subscription captures events even before chat.send returns message IDs. */
export class LocalActivity {
  private state: ActivityState = { approvals: [], tools: [], error: false };
  private approvals = new Map<string, Approval>();
  private tools = new Map<string, ActivityTool>();
  private runActivities = new Map<string, LiveRunActivity>();
  private listeners = new Set<() => void>();
  private subscriptions: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private version = 0;
  private revision = 0;
  constructor(
    private readonly peer: ChatPeer,
    private readonly botId: string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active) return;
    this.trimApprovals();
    this.state = {
      ...this.state,
      approvals: [...this.approvals.values()],
      tools: [...this.tools.values()],
      runActivity: [...this.runActivities.values()].findLast(() => true),
    };
    for (const listener of this.listeners) listener();
  }
  private trimApprovals() {
    if (this.approvals.size <= 500) return;
    // Redirects can resolve many approvals without a tool event; trim every published change.
    for (const [id, approval] of this.approvals) {
      if (approval.status === "pending") continue;
      this.approvals.delete(id);
      if (this.approvals.size <= 500) break;
    }
  }
  start() {
    this.active = true;
    this.subscriptions = [
      this.peer.on("approval.requested", (approval) => {
        if (approval.botId !== this.botId) return;
        this.revision++;
        const previous = this.approvals.get(approval.id);
        if (!previous || previous.status === "pending") this.approvals.set(approval.id, approval);
        this.publish();
      }),
      this.peer.on("approval.resolved", (result) => {
        const approval = this.approvals.get(result.id);
        this.revision++;
        if (approval) this.approvals.set(result.id, { ...approval, ...result });
        this.publish();
        void this.refresh();
      }),
      this.peer.on("chat.tool", (event) => this.receiveTool(event)),
      this.peer.on("chat.activity", (event) => this.receiveRunActivity(event)),
      this.peer.on("chat.done", (event) => {
        this.clearRunActivity(event.runId);
        void this.refresh();
      }),
      this.peer.on("chat.error", (event) => {
        this.clearRunActivity(event.runId);
        void this.refresh();
      }),
      this.peer.on("chat.status", (event) => {
        if (event.botId !== this.botId || event.state !== "idle" || !event.runId) return;
        this.clearRunActivity(event.runId);
      }),
    ];
    void this.refresh();
    return () => this.stop();
  }
  private stop() {
    this.active = false;
    this.version++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
  }
  refresh = async () => {
    const version = ++this.version;
    const revision = this.revision;
    try {
      const pending = await this.peer.call("approvals.pending", { botId: this.botId, limit: 200 });
      if (!this.active || version !== this.version) return;
      // A response issued before a live resolution must not resurrect that approval.
      if (revision !== this.revision) {
        void this.refresh();
        return;
      }
      const ids = new Set(pending.map((approval) => approval.id));
      for (const [id, approval] of this.approvals) {
        if (approval.status === "pending" && !ids.has(id)) this.approvals.delete(id);
      }
      for (const approval of pending) this.approvals.set(approval.id, approval);
      this.state = { ...this.state, error: false };
      this.publish();
    } catch {
      if (this.active && version === this.version) {
        this.state = { ...this.state, error: true };
        this.publish();
      }
    }
  };
  resolve = async (
    id: string,
    decision: "allow" | "deny",
    remember: boolean,
    preauthorize = false,
    rememberSecrets?: string[],
  ) => {
    const approval = this.approvals.get(id);
    await this.peer.call("approvals.resolve", {
      id,
      decision,
      remember:
        decision === "allow" &&
        !!approval?.canRemember &&
        approval.rememberOnly !== "secrets" &&
        approval.risk !== "danger" &&
        remember,
      ...(decision === "allow" &&
      approval?.canRememberSecrets === true &&
      approval.source !== "routine" &&
      !approval.routineRunId &&
      approval.risk !== "danger" &&
      rememberSecrets?.length &&
      rememberSecrets.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name))
        ? { rememberSecrets }
        : {}),
      preauthorize:
        decision === "allow" &&
        approval?.source === "routine" &&
        !!approval.canPreauthorize &&
        approval.risk !== "danger" &&
        preauthorize,
    });
    if (!this.active) return;
    // The backend may re-evaluate, expire or cancel an allow request; only its event/read proves the outcome.
    await this.refresh();
  };
  private receiveTool(event: EventPayloads["chat.tool"]) {
    if (event.botId !== this.botId) return;
    const id = key(event.messageId, event.toolCallId);
    const previous = this.tools.get(id);
    this.tools.set(id, {
      messageId: event.messageId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      tool: event.tool,
      summary: event.summary,
      inputTranslation: event.inputTranslation ?? previous?.inputTranslation,
      ...((event.codeAnalysis ?? previous?.codeAnalysis)
        ? { codeAnalysis: event.codeAnalysis ?? previous?.codeAnalysis }
        : {}),
      target: previous?.target ?? toolTarget(event.tool, event.summary),
      status:
        event.status ??
        (event.phase === "end"
          ? event.exitCode !== undefined && event.exitCode !== 0
            ? "error"
            : "done"
          : "running"),
      exitCode: event.exitCode ?? previous?.exitCode ?? null,
      durationMs: event.durationMs ?? previous?.durationMs ?? null,
      output: tail((previous?.output ?? "") + (event.output ?? "")),
      ...((event.yolo ?? previous?.yolo) ? { yolo: event.yolo ?? previous?.yolo } : {}),
      // Only a start event carries it; the next start (lock taken) or any end clears it.
      ...(event.phase === "start" && event.waitingFor !== undefined
        ? { waitingFor: event.waitingFor }
        : {}),
      // A card-less refusal states its reason on the end event, so the row does not wait
      // for a history reload to replace "Denied".
      ...((event.settingsAction ?? previous?.settingsAction)
        ? { settingsAction: event.settingsAction ?? previous?.settingsAction }
        : {}),
      ...((event.denialReason ?? previous?.denialReason)
        ? { denialReason: event.denialReason ?? previous?.denialReason }
        : {}),
    });
    // Bound session-only memory; durable history continues to come from chat.history.
    if (this.tools.size > 500) {
      for (const [id, tool] of this.tools) {
        if (tool.status !== "running" && tool.status !== "pending") {
          this.tools.delete(id);
          break;
        }
      }
    }
    if (event.phase !== "output") this.publish();
    else this.timer ??= setTimeout(() => this.publish(), 100);
  }
  private clearRunActivity(runId: string) {
    let changed = false;
    for (const [messageId, activity] of this.runActivities) {
      if (activity.runId !== runId) continue;
      this.runActivities.delete(messageId);
      changed = true;
    }
    if (changed) this.publish();
  }
  private receiveRunActivity(event: EventPayloads["chat.activity"]) {
    if (event.botId !== this.botId) return;
    const previous = this.runActivities.get(event.messageId);
    if (event.phase === "clear") {
      if (previous?.runId === event.runId) {
        this.runActivities.delete(event.messageId);
        this.publish();
      }
      return;
    }
    const samePhase =
      previous?.runId === event.runId &&
      previous.phase === event.phase &&
      (event.phase === "waiting_model" ||
        (previous.phase !== "waiting_model" && previous.tool === event.tool));
    this.runActivities.set(event.messageId, {
      ...event,
      startedAt: samePhase ? previous.startedAt : Date.now(),
    });
    if (this.runActivities.size > 500)
      this.runActivities.delete(this.runActivities.keys().next().value as string);
    this.publish();
  }
}

const empty: ActivityState = { approvals: [], tools: [], error: false };
const noopSubscribe = () => () => {};
const emptySnapshot = () => empty;
const noopRefresh = async () => {};
export function useLocalActivity(peer: ChatPeer, botId?: string) {
  const activity = useMemo(
    () => (botId ? new LocalActivity(peer, botId) : undefined),
    [peer, botId],
  );
  useEffect(() => activity?.start(), [activity]);
  const state = useSyncExternalStore(
    activity?.subscribe ?? noopSubscribe,
    activity?.getSnapshot ?? emptySnapshot,
    activity?.getSnapshot ?? emptySnapshot,
  );
  return { state, decide: activity?.resolve, refresh: activity?.refresh ?? noopRefresh };
}
