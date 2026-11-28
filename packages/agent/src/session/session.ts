import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  LoadExtensionsResult,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { untilAborted } from "../core/abort.ts";
import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";
import type { AgentErrorCode, BotSession } from "../core/types.ts";
import { type CompactionState, finishCompaction } from "../extensions/compaction.ts";
import { enableNetworkRetry, NETWORK_RETRY_SETTINGS } from "../network/network-reconnect.ts";
import { knownRate } from "../runtime/memory-draft.ts";
import { toolVersion } from "../runtime/tool-identity.ts";
import { LeakedStateEchoFilter } from "./leaked-state-echo.ts";
import { LeakedToolMarkupFilter } from "./leaked-tool-markup.ts";
import { requeue, type SessionAdditions } from "./session-additions.ts";
import { ThinkingRepeatGuard } from "./thinking-repeat.ts";

type ExtensionRuntime = ReturnType<
  typeof import("@earendil-works/pi-coding-agent").createExtensionRuntime
>;
export function staticResourceLoader(
  systemPrompt: string,
  runtime: ExtensionRuntime,
  loaded?: LoadExtensionsResult,
): ResourceLoader {
  return {
    getExtensions: () => loaded ?? { extensions: [], errors: [], runtime },
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export type ChatSession = Pick<
  AgentSession,
  "subscribe" | "prompt" | "abort" | "dispose" | "messages" | "waitForIdle"
> &
  Partial<Pick<AgentSession, "steer" | "followUp" | "isStreaming" | "clearQueue">>;

/**
 * How long a message sent during compaction or an automatic retry waits for the run to accept input
 * again; compaction of a long conversation can take a minute or more.
 */
const HOLD_MS = 180_000;
const TOOL_FAILURE_LIMIT = 3;

/**
 * Custom models price at -1 ("unknown"), so pi's cost is negative (acceptance 2026-11-25:
 * -0.015692 stored on a keyless provider's reply). An unknown price is stored as 0 like the memory
 * workers do; the request record, not this copy, tells the receipt whether the cost is known.
 */
function usageInfo(usage: AssistantMessage["usage"]) {
  const input = knownRate(usage.cost.input);
  const output = knownRate(usage.cost.output);
  const cacheRead = knownRate(usage.cost.cacheRead);
  const cacheWrite = knownRate(usage.cost.cacheWrite);
  const parts = [usage.cost.input, usage.cost.output, usage.cost.cacheRead, usage.cost.cacheWrite];
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: parts.some((value) => !(value >= 0)) ? 0 : knownRate(usage.cost.total),
    },
  };
}

export function wrapSession(
  session: ChatSession,
  sessionFile: string,
  hasAvailableModel: () => Promise<boolean>,
  beforePrompt?: (
    text: string,
    images?: import("@earendil-works/pi-ai").ImageContent[],
  ) => Promise<void>,
  signal?: AbortSignal,
  compaction?: CompactionState,
  additions?: SessionAdditions,
  /** Why the program (not the user) stopped this prompt before a request, if it did. */
  programFailure?: () => AgentErrorCode | undefined,
  requestAccounting?: {
    responseError?: AgentError;
    interrupted?: boolean;
    drain(): Promise<void>;
    managesRetries?: boolean;
    onReconnect?: (
      event: Extract<import("../core/types.ts").SessionEvent, { type: "reconnect" }>,
    ) => void;
  },
  setNetworkRetryEnabled?: (enabled: boolean) => void,
  beforeAddition?: (messageId: string) => void,
): BotSession {
  let running = false;
  let disposed = false;
  let aborted = false;
  let aborting: Promise<void> | undefined;
  let operation: AbortController | undefined;
  // A run can call prompt again to continue after an output or connection interruption.
  const failedToolCalls = new Map<string, number>();
  const canAppend = () =>
    !!(
      additions?.accepting &&
      running &&
      session.isStreaming &&
      !disposed &&
      !aborted &&
      !signal?.aborted
    );
  const requestAbort = () => {
    operation?.abort();
    compaction?.background?.cancel();
    aborting ??= Promise.resolve().then(() => session.abort());
    return aborting;
  };
  return {
    sessionFile,
    canAppend,
    hasPendingInput: (text) =>
      !!additions && [...additions.queued.values()].some((input) => input.text === text),
    async append(id, mode, text, images) {
      // During compaction or an automatic retry the run goes on: wait for it rather than refuse.
      if (!canAppend() && additions?.holding && running)
        await additions.waitAccepting(signal, HOLD_MS);
      if (!canAppend() || !additions || !session[mode]) return false;
      if (
        additions.queued.size >= 16 ||
        [...additions.queued.values()].some((input) => input.text === text)
      )
        return false;
      additions.queued.set(id, { text, mode, ...(images?.length ? { images } : {}) });
      const pending = (session[mode] as NonNullable<ChatSession[typeof mode]>).call(
        session,
        text,
        images,
      );
      additions.pending.add(pending);
      try {
        const accepted = await pending;
        if (accepted !== "queued") {
          additions.queued.delete(id);
          return false;
        }
        return true;
      } catch (error) {
        additions.queued.delete(id);
        throw new AgentError(mapAgentError(error));
      } finally {
        additions.pending.delete(pending);
      }
    },
    async switchAddition(id, mode) {
      const item = additions?.queued.get(id);
      if (!additions || !item || !canAppend() || !session.clearQueue || !session[mode])
        return false;
      if (item.mode === mode) return true;
      const work = requeue(additions, session as Parameters<typeof requeue>[1], id, mode);
      additions.pending.add(work);
      try {
        return await work;
      } finally {
        additions.pending.delete(work);
      }
    },
    async prompt(text, onEvent, images) {
      if (disposed || running) throw new AgentError("internal");
      running = true;
      aborted = false;
      aborting = undefined;
      operation = new AbortController();
      if (compaction) compaction.operationSignal = operation.signal;
      let assistant: AssistantMessage | undefined;
      // Per assistant message: DeepSeek's DSML tool-call markup never reaches the reply text.
      let markup = new LeakedToolMarkupFilter();
      // …nor does an echo of Pi Bot's runtime state (a translator Bot translated it, 2026-11-18).
      let stateEcho = new LeakedStateEchoFilter();
      // Which text part the last delta belonged to, and whether it ended a line.
      let textPart: { index: number; endsLine: boolean } | undefined;
      // A reasoning loop is cut here and reported as a length stop, so the run can continue.
      let thinking = new ThinkingRepeatGuard();
      let repeatCut = false;
      let toolRetryCut = false;
      const activeToolCalls = new Map<string, string>();
      let eventFailed = false;
      let activityPhase: "waiting_model" | "preparing_tool" | "clear" = "clear";
      let activityAt = 0;
      let activityTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingActivity: Parameters<typeof emitActivity>[0] | undefined;
      const preparingTools = new Map<number, { tool: string; characters: number }>();
      const calledTools = new Set<string>();
      const trackTools = (message: AssistantMessage) => {
        for (const part of message.content)
          if (part.type === "toolCall") calledTools.add(part.name);
      };
      let unsubscribe: (() => void) | undefined;
      const cancel = () => {
        aborted = true;
        void requestAbort().catch(() => {
          /* Prompt settles the cancellation error. */
        });
      };
      const emit = (event: import("../core/types.ts").SessionEvent) => {
        try {
          onEvent(event);
        } catch {
          eventFailed = true;
          cancel();
        }
      };
      const emitActivity = (
        activity:
          | { phase: "waiting_model" }
          | { phase: "preparing_tool"; tool: string; characters: number }
          | { phase: "clear" },
      ) => {
        const now = Date.now();
        // Delta storms must not become UI/remote event storms. Phase changes remain immediate.
        // Throttled updates are deferred, not dropped: some OpenRouter upstreams send a tool's
        // first argument bytes right after its name and then buffer the rest (an office document
        // arrives in one chunk ~15 s later), so a dropped update left the line at "0 chars".
        if (activity.phase === activityPhase && now - activityAt < 500) {
          // A repeated clear says nothing new; deferring it could emit after the run ended.
          if (activity.phase === "clear") return;
          pendingActivity = activity;
          activityTimer ??= setTimeout(
            () => {
              activityTimer = undefined;
              const pending = pendingActivity;
              pendingActivity = undefined;
              if (pending) emitActivity(pending);
            },
            500 - (now - activityAt),
          );
          return;
        }
        clearTimeout(activityTimer);
        activityTimer = undefined;
        pendingActivity = undefined;
        activityPhase = activity.phase;
        activityAt = now;
        emit({ type: "activity", activity });
      };
      try {
        setNetworkRetryEnabled?.(false);
        if (requestAccounting?.managesRetries) requestAccounting.onReconnect = emit;
        signal?.throwIfAborted();
        signal?.addEventListener("abort", cancel, { once: true });
        if (!(await untilAborted(hasAvailableModel(), signal))) throw new AgentError("no_model");
        // Preparation owns cache IO too; cancellation must retain the run until its real drain.
        if (beforePrompt) await beforePrompt(text, images);
        signal?.throwIfAborted();
        if (aborted || disposed) throw new AgentError("aborted");
        unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          if (event.type === "tool_execution_start" && !toolRetryCut)
            activeToolCalls.set(event.toolCallId, toolVersion([event.toolName, event.args]));
          if (event.type === "tool_execution_end" && !toolRetryCut) {
            const key = activeToolCalls.get(event.toolCallId);
            activeToolCalls.delete(event.toolCallId);
            if (key && !event.isError) failedToolCalls.delete(key);
            if (key && event.isError) {
              const failures = (failedToolCalls.get(key) ?? 0) + 1;
              failedToolCalls.set(key, failures);
              if (failures >= TOOL_FAILURE_LIMIT && !aborted && !signal?.aborted) {
                toolRetryCut = true;
                void requestAbort().catch(() => {
                  /* The prompt reports the repeated failure below. */
                });
              }
            }
          }
          if (event.type === "entry_appended" && event.entry.type === "compaction" && compaction)
            finishCompaction(compaction, "done");
          if (event.type === "auto_retry_start") {
            if (additions) {
              additions.holding = true;
              additions.accepting = false;
            }
            emit({
              type: "reconnect",
              phase: "start",
              attempt: event.attempt,
              maxAttempts: NETWORK_RETRY_SETTINGS.maxRetries,
              delayMs: event.delayMs,
            });
          }
          if (event.type === "auto_retry_end")
            emit({
              type: "reconnect",
              phase: "end",
              attempt: event.attempt,
              maxAttempts: NETWORK_RETRY_SETTINGS.maxRetries,
              outcome: aborted || signal?.aborted ? "aborted" : event.success ? "done" : "error",
            });
          if (event.type === "compaction_start" && additions) {
            additions.holding = true;
            additions.accepting = false;
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            markup = new LeakedToolMarkupFilter();
            stateEcho = new LeakedStateEchoFilter();
            textPart = undefined;
            thinking = new ThinkingRepeatGuard();
            if (additions) additions.accepting = true;
            emit({ type: "replyStart" });
          }
          if (event.type === "message_start" && event.message.role === "user" && additions) {
            const input =
              typeof event.message.content === "string"
                ? event.message.content
                : event.message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("");
            const id = additions.take(input);
            if (id) {
              beforeAddition?.(id);
              emit({ type: "addition", id });
            }
          }
          if (
            event.type === "compaction_end" &&
            !event.result &&
            !compaction?.failure &&
            compaction
          )
            compaction.failure =
              signal?.aborted || event.aborted
                ? "aborted"
                : event.reason === "overflow"
                  ? "context_overflow"
                  : "compaction_failed";
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            const content =
              "contentIndex" in update ? update.partial.content[update.contentIndex] : undefined;
            const toolCall = content?.type === "toolCall" ? content : undefined;
            if (update.type === "text_delta") {
              // A reply can carry several text parts (Responses API output items). Joined as one
              // stream they ran together ("…interrupting.Extra tip:", v0.0.2 Windows test); a new
              // part starts a new paragraph unless the previous one already ended a line.
              const index = "contentIndex" in update ? update.contentIndex : 0;
              const gap = textPart && textPart.index !== index && !textPart.endsLine ? "\n\n" : "";
              if (update.delta) textPart = { index, endsLine: /\n\s*$/.test(update.delta) };
              const shown = stateEcho.push(markup.push(gap + update.delta));
              if (shown) {
                emitActivity({ phase: "clear" });
                emit({ type: "delta", text: shown });
              }
            } else if (update.type === "thinking_delta") {
              // The guard sees reasoning text only, in memory, and never forwards it.
              if (!repeatCut && thinking.push(update.delta)) {
                repeatCut = true;
                void requestAbort().catch(() => {
                  /* The prompt settles the cut below. */
                });
              }
            } else if (update.type === "toolcall_start") {
              const initial = toolCall ? JSON.stringify(toolCall.arguments) : "";
              const preparing = {
                tool: toolCall?.name ?? "",
                characters: initial === "{}" ? 0 : Array.from(initial).length,
              };
              preparingTools.set(update.contentIndex, preparing);
              if (preparing.tool)
                emitActivity({
                  phase: "preparing_tool",
                  ...preparing,
                });
            } else if (update.type === "toolcall_delta") {
              const previous = preparingTools.get(update.contentIndex);
              const preparing = {
                tool: toolCall?.name || previous?.tool || "",
                characters: (previous?.characters ?? 0) + Array.from(update.delta).length,
              };
              preparingTools.set(update.contentIndex, preparing);
              // The SDK's delta is the raw incremental argument text. Count it; never forward it.
              if (preparing.tool)
                emitActivity({
                  phase: "preparing_tool",
                  ...preparing,
                });
            } else if (update.type === "toolcall_end") {
              preparingTools.delete(update.contentIndex);
              const preparing = [...preparingTools.values()].findLast((item) => !!item.tool);
              emitActivity(
                preparing ? { phase: "preparing_tool", ...preparing } : { phase: "clear" },
              );
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const rest = stateEcho.push(markup.end()) + stateEcho.end();
            if (rest) emit({ type: "delta", text: rest });
            emit({ type: "replyEnd" });
            assistant = event.message;
            if (setNetworkRetryEnabled && !requestAccounting?.managesRetries)
              setNetworkRetryEnabled(
                enableNetworkRetry(
                  assistant,
                  !!(
                    aborted ||
                    disposed ||
                    signal?.aborted ||
                    compaction?.failure ||
                    programFailure?.()
                  ),
                ),
              );
            trackTools(assistant);
          }
        });
        const before = session.messages.length;
        emitActivity({ phase: "waiting_model" });
        await session.prompt(text, images?.length ? { images } : undefined);
        if (eventFailed) throw new AgentError("session_event_handler_failed");
        if (toolRetryCut && !aborted && !signal?.aborted)
          throw new AgentError("repeated_tool_failure");
        // Our own cut is not a user stop: report the length stop so the run continues with the
        // rest of the work instead of ending as "aborted".
        if (repeatCut && !aborted && !disposed && !signal?.aborted) {
          assistant ??= session.messages
            .slice(before)
            .findLast((message): message is AssistantMessage => message.role === "assistant");
          return {
            stopReason: "length",
            repeatedThinking: true,
            calledTools: [...calledTools],
            finalText: assistant
              ? assistant.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("")
              : "",
            usage: assistant ? usageInfo(assistant.usage) : undefined,
          };
        }
        if (compaction?.failure) throw new AgentError(compaction.failure);
        // The context hook aborts through pi (stopReason "aborted", or an error from the guarded
        // stream function). Report its reason so the window does not show it as a user stop.
        const failure = aborted ? undefined : programFailure?.();
        if (failure) throw new AgentError(failure);
        // Native context can omit a length/error response although message_end persisted it.
        assistant ??= session.messages
          .slice(before)
          .findLast((message): message is AssistantMessage => message.role === "assistant");
        if (aborted || assistant?.stopReason === "aborted") throw new AgentError("aborted");
        if (assistant?.stopReason === "error") {
          if (requestAccounting?.responseError) throw requestAccounting.responseError;
          const code = mapAgentError(assistant.errorMessage);
          throw new AgentError(
            code === "internal" ? "provider_error" : code,
            agentHttpStatus(assistant.errorMessage),
          );
        }
        if (!assistant) throw new AgentError("internal");
        for (const message of session.messages.slice(before))
          if (message.role === "assistant") trackTools(message);
        return {
          stopReason: assistant.stopReason,
          ...(assistant.stopReason === "length" && requestAccounting?.interrupted
            ? { interrupted: true }
            : {}),
          calledTools: [...calledTools],
          finalText: assistant.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          usage: usageInfo(assistant.usage),
        };
      } catch (error) {
        const code = eventFailed
          ? "session_event_handler_failed"
          : aborted
            ? "aborted"
            : toolRetryCut
              ? "repeated_tool_failure"
              : (programFailure?.() ?? mapAgentError(error));
        if (error instanceof AgentError && error.code === code) throw error;
        throw new AgentError(code, agentHttpStatus(error));
      } finally {
        emitActivity({ phase: "clear" });
        emit({ type: "replyEnd" });
        if (additions) {
          additions.release();
          await Promise.allSettled([...additions.pending]);
          session.clearQueue?.();
          additions.queued.clear();
        }
        // Keep persistence listeners attached until both the run and abort reach SDK idle.
        for (;;) {
          const pendingAbort: Promise<void> | undefined = aborting;
          await Promise.allSettled(pendingAbort ? [pendingAbort] : []);
          await session.waitForIdle();
          // Cancellation can arrive while waitForIdle is yielding; drain that abort too.
          if (pendingAbort === aborting) break;
        }
        await compaction?.background?.drain();
        await requestAccounting?.drain();
        if (requestAccounting) requestAccounting.onReconnect = undefined;
        signal?.removeEventListener("abort", cancel);
        unsubscribe?.();
        setNetworkRetryEnabled?.(false);
        if (compaction) finishCompaction(compaction, aborted ? "aborted" : "error");
        running = false;
        if (disposed) session.dispose();
      }
    },
    async abort() {
      if (disposed && !running) return;
      if (running) aborted = true;
      try {
        await requestAbort();
      } finally {
        await session.waitForIdle();
        await requestAccounting?.drain();
      }
    },
    waitForIdle: () => session.waitForIdle(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (running) {
        aborted = true;
        void requestAbort().catch(() => {
          /* prompt keeps tracking SDK idle. */
        });
        return;
      }
      session.dispose();
    },
  };
}
