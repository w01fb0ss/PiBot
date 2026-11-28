import { activeRun, chatController, retryText } from "@pibot/client-core";
import { createTranslator } from "@pibot/i18n";
import {
  type AgentErrorCode,
  type Bot,
  createPeer,
  Events,
  type Message,
  Methods,
  type ModelInfo,
  type Port,
  RpcError,
} from "@pibot/protocol";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerDraftProvider } from "./composer/composer-drafts.tsx";
import { shouldSend } from "./composer/input.ts";
import { NextReplyField, useNextReplySuggestion } from "./composer/NextReplySuggestion.tsx";
import { ChatScreen } from "./index.tsx";
import { externalUrl, Markdown } from "./messages/Markdown.tsx";

const context = vi.hoisted(() => ({ peer: null as unknown, language: "zh" as "zh" | "en" }));
// The shell hooks live in the renderer kit. Mock its context modules rather than the
// index, so kit-internal imports (widgets) see the same fakes.
vi.mock("../../../../../../packages/renderer-kit/src/rpc/context.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRpc: () => ({ peer: context.peer, state: "ready" }),
  useRpcEvent: vi.fn(),
}));
vi.mock(
  "../../../../../../packages/renderer-kit/src/settings/context.ts",
  async (importOriginal) => {
    const { createTranslator } = await import("@pibot/i18n");
    return {
      ...(await importOriginal<object>()),
      useT: () => createTranslator(context.language),
      useSettings: () => ({ t: createTranslator(context.language), language: context.language }),
    };
  },
);
vi.mock(
  "../../../../../../packages/renderer-kit/src/navigation/context.ts",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useNavigation: () => ({
      view: { name: "chat" },
      navigate: vi.fn(),
      openSettings: vi.fn(),
      openWorkspace: vi.fn(),
      revisions: {},
    }),
  }),
);
vi.mock(
  "../../../../../../packages/renderer-kit/src/workspace/context.ts",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useWorkspace: () => ({
      bots: [],
      groups: [],
      entries: [],
      sections: [],
      inbox: [],
      summaries: {},
      statuses: {},
      loading: false,
      error: false,
      unavailable: false,
      hasMore: false,
      refresh: vi.fn(),
    }),
  }),
);

function pair(): [Port, Port] {
  const listeners = [new Set<(value: unknown) => void>(), new Set<(value: unknown) => void>()];
  const port = (index: number): Port => ({
    post: (value) =>
      queueMicrotask(() => {
        for (const listener of listeners[1 - index] ?? []) listener(value);
      }),
    onMessage: (listener) => {
      listeners[index]?.add(listener);
      return () => {
        listeners[index]?.delete(listener);
      };
    },
  });
  return [port(0), port(1)];
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  context.peer = null;
  context.language = "zh";
});

const timestamp = "2026-10-09T12:00:00.000Z";
function message(role: Message["role"], content: string, runId = crypto.randomUUID()): Message {
  return {
    id: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    role,
    content,
    status: role === "assistant" ? "streaming" : "done",
    runId,
    errorCode: null,
    usage: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function fixture(history: Message[] = []) {
  const [a, b] = pair();
  const peer = createPeer(a, { methods: Methods, events: Events });
  const brain = createPeer(b, { methods: Methods, events: Events });
  const bot: Bot = {
    id: crypto.randomUUID(),
    name: "Pi",
    isMain: true,
    category: "chat",
    avatarShape: "blob",
    avatarColor: "orange",
    avatarEyes: "marks",
    modelProvider: "test",
    modelId: "model",
    thinkingLevel: "medium",
    systemPrompt: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const model: ModelInfo = {
    provider: "test",
    id: "model",
    name: "Test model",
    contextWindow: 4096,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const data = { history, models: [model], bot };
  brain.handle("bots.list", async () => [data.bot]);
  brain.handle("models.list", async () => data.models);
  const historyCall = vi.fn(async ({ before, limit = 50 }: { before?: string; limit?: number }) => {
    const end = before ? data.history.findIndex((item) => item.id === before) : data.history.length;
    return data.history.slice(Math.max(0, end - limit), end).map((item) => ({ ...item }));
  });
  brain.handle("chat.history", historyCall);
  const sendCall = vi.fn(async ({ text }: { text: string }) => {
    const runId = crypto.randomUUID();
    const user = message("user", text, runId);
    const assistant = message("assistant", "", runId);
    data.history.push(user, assistant);
    return { runId, userMessageId: user.id, assistantMessageId: assistant.id };
  });
  brain.handle("chat.send", sendCall);
  const abortCall = vi.fn(async ({ runId }: { runId: string }) => {
    const assistant = data.history.find(
      (item) => item.runId === runId && item.role === "assistant",
    );
    if (assistant) {
      assistant.status = "aborted";
      assistant.errorCode = "aborted";
      brain.emit("chat.error", {
        runId,
        messageId: assistant.id,
        code: "aborted",
        message: "stopped",
      });
    }
    return { ok: true as const };
  });
  brain.handle("chat.abort", abortCall);
  const controller = chatController(peer);
  cleanups.push(() => {
    controller.dispose();
    peer.dispose();
    brain.dispose();
  });
  return { peer, brain, data, controller, historyCall, sendCall, abortCall };
}
const flush = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};

describe("chat controller over a typed fake brain", () => {
  it("loads history once on simultaneous mounts and defers provider refresh until initialization", async () => {
    const f = fixture([message("user", "saved history")]);
    const start = f.controller.start();
    f.brain.emit("providers.changed", {});
    await Promise.all([start, f.controller.start()]);
    await flush();
    expect(f.historyCall).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot()).toMatchObject({
      loading: false,
      historyError: false,
      metadataError: false,
    });
    expect(f.controller.getSnapshot().messages[0]?.content).toBe("saved history");
  });
  it("loads 50 messages and pages by the oldest persisted UUID without duplicate requests", async () => {
    const all = Array.from({ length: 121 }, (_, index) => message("user", `${index}`));
    const f = fixture(all);
    await f.controller.start();
    expect(f.controller.getSnapshot().messages).toEqual(all.slice(-50));
    expect(f.historyCall).toHaveBeenLastCalledWith(
      { botId: f.data.bot.id, limit: 50 },
      { signal: expect.any(AbortSignal) },
    );
    await Promise.all([f.controller.loadMore(), f.controller.loadMore()]);
    expect(f.historyCall).toHaveBeenCalledTimes(2);
    expect(f.historyCall).toHaveBeenLastCalledWith(
      {
        botId: f.data.bot.id,
        before: all[71]?.id,
        limit: 50,
      },
      { signal: expect.any(AbortSignal) },
    );
    await f.controller.loadMore();
    expect(f.controller.getSnapshot().messages).toEqual(all);
    expect(f.controller.getSnapshot().hasMore).toBe(false);
  });
  it("preserves streaming text, rejects double send and finalizes canonical content", async () => {
    const f = fixture();
    await f.controller.start();
    expect(await f.controller.send("hello")).toBe(true);
    const assistant = f.data.history.at(-1) as Message;
    f.brain.emit("chat.delta", {
      runId: assistant.runId as string,
      messageId: assistant.id,
      text: "Hi",
    });
    await flush();
    expect(f.controller.getSnapshot().messages.at(-1)?.content).toBe("Hi");
    expect(await f.controller.send("second")).toBe(false);
    expect(f.sendCall).toHaveBeenCalledTimes(1);
    assistant.content = "Hi [redacted]";
    assistant.status = "done";
    f.brain.emit("chat.done", {
      runId: assistant.runId as string,
      messageId: assistant.id,
      stopReason: "stop",
    });
    await flush();
    expect(activeRun(f.controller.getSnapshot())).toBeUndefined();
    expect(f.controller.getSnapshot().messages.at(-1)?.content).toBe("Hi [redacted]");
  });
  it("buffers delta and terminal events arriving before the send response", async () => {
    const f = fixture();
    await f.controller.start();
    f.brain.handle("chat.send", async ({ text }) => {
      const result = await f.sendCall({ text });
      const assistant = f.data.history.at(-1) as Message;
      assistant.content = "early";
      assistant.status = "done";
      f.brain.emit("chat.delta", {
        runId: result.runId,
        messageId: result.assistantMessageId,
        text: "early",
      });
      f.brain.emit("chat.done", {
        runId: result.runId,
        messageId: result.assistantMessageId,
        stopReason: "stop",
      });
      return result;
    });
    await f.controller.send("hello");
    await flush();
    expect(f.controller.getSnapshot().messages).toHaveLength(2);
    expect(f.controller.getSnapshot().messages.at(-1)).toMatchObject({
      content: "early",
      status: "done",
    });
  });
  it("keeps the next run after a delayed terminal history snapshot", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.send("first");
    const first = f.data.history.at(-1) as Message;
    first.status = "done";
    first.content = "finished";
    const snapshot = f.data.history.map((item) => ({ ...item }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.brain.handle("chat.history", async () => {
      await gate;
      return snapshot;
    });
    f.brain.emit("chat.done", {
      runId: first.runId as string,
      messageId: first.id,
      stopReason: "stop",
    });
    await flush();
    await f.controller.send("second");
    const second = f.data.history.at(-1) as Message;
    f.brain.emit("chat.delta", {
      runId: second.runId as string,
      messageId: second.id,
      text: "live",
    });
    await flush();
    release?.();
    await flush();
    expect(f.controller.getSnapshot().messages.map((item) => item.id)).toEqual(
      f.data.history.map((item) => item.id),
    );
    expect(f.controller.getSnapshot().messages.at(-1)).toMatchObject({
      content: "live",
      status: "streaming",
    });
  });
  it("handles transient no_model and RPC -32010 as one retryable error without phantom messages", async () => {
    const f = fixture();
    await f.controller.start();
    f.data.models = [];
    f.brain.handle("chat.send", async () => {
      f.brain.emit("chat.error", {
        runId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        code: "no_model",
        message: "no model",
      });
      throw new RpcError(-32010, "no_model");
    });
    expect(await f.controller.send("keep this draft")).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({
      messages: [],
      pending: false,
      requestError: "no_model",
      retryText: "keep this draft",
      models: [],
    });
  });
  it("recovers a concurrently active run on -32011 without changing it to an error", async () => {
    const f = fixture();
    await f.controller.start();
    f.brain.handle("chat.send", async () => {
      f.data.history.push(message("assistant", "other window"));
      throw new RpcError(-32011, "busy");
    });
    await f.controller.send("hello");
    expect(f.controller.getSnapshot().requestError).toBe("busy");
    expect(f.controller.getSnapshot().messages.at(-1)?.status).toBe("streaming");
  });
  it.each([
    "auth_failed",
    "network",
    "rate_limited",
    "provider_error",
    "internal",
  ] as AgentErrorCode[])(
    "maps %s onto the corresponding assistant and retries the preceding user prompt",
    async (code) => {
      const f = fixture();
      await f.controller.start();
      await f.controller.send("original");
      const assistant = f.data.history.at(-1) as Message;
      assistant.status = "error";
      assistant.errorCode = code;
      f.brain.emit("chat.error", {
        runId: assistant.runId as string,
        messageId: assistant.id,
        code,
        message: "raw diagnostic must not be displayed",
      });
      await flush();
      expect(f.controller.getSnapshot().messages.at(-1)).toMatchObject({
        status: "error",
        errorCode: code,
      });
      expect(retryText(f.controller.getSnapshot().messages, assistant.id)).toBe("original");
      expect(await f.controller.send("original")).toBe(true);
    },
  );
  it("aborts by runId and keeps generated text; an abort failure remains retryable", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.send("hello");
    const assistant = f.data.history.at(-1) as Message;
    assistant.content = "partial";
    f.brain.handle("chat.abort", async () => {
      throw new RpcError(-32603, "failed");
    });
    await f.controller.abort();
    expect(f.controller.getSnapshot()).toMatchObject({ stopping: false, stopError: true });
    f.brain.handle("chat.abort", f.abortCall);
    await f.controller.abort();
    expect(f.abortCall).toHaveBeenCalledWith(
      { runId: assistant.runId },
      { signal: expect.any(AbortSignal) },
    );
    expect(f.controller.getSnapshot().messages.at(-1)).toMatchObject({
      content: "partial",
      status: "aborted",
    });
  });
  it("keeps subscriptions during Settings and refreshes the chosen model on return", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.send("hello");
    const assistant = f.data.history.at(-1) as Message;
    f.brain.emit("chat.delta", {
      runId: assistant.runId as string,
      messageId: assistant.id,
      text: "while away",
    });
    await flush();
    expect(chatController(f.peer)).toBe(f.controller);
    f.data.bot = { ...f.data.bot, modelId: null };
    await f.controller.start();
    expect(f.controller.getSnapshot().bot?.modelId).toBeNull();
    expect(f.controller.getSnapshot().messages.at(-1)?.content).toBe("while away");
  });
  it("shows history failure and recovers without losing pagination position", async () => {
    const f = fixture(Array.from({ length: 60 }, () => message("user", "history")));
    await f.controller.start();
    f.brain.handle("chat.history", async () => {
      throw new RpcError(-32603, "failed");
    });
    await f.controller.loadMore();
    expect(f.controller.getSnapshot()).toMatchObject({
      historyError: true,
      loadingMore: false,
      hasMore: true,
    });
    expect(f.controller.getSnapshot().messages).toHaveLength(50);
    f.brain.handle("chat.history", f.historyCall);
    await f.controller.retryHistory();
    expect(f.controller.getSnapshot().messages).toHaveLength(60);
    expect(f.controller.getSnapshot().historyError).toBe(false);
  });
  it("retries a failed latest-history refresh instead of fetching the older page", async () => {
    const f = fixture(Array.from({ length: 60 }, () => message("user", "history")));
    await f.controller.start();
    await f.controller.send("new prompt");
    const assistant = f.data.history.at(-1) as Message;
    assistant.status = "done";
    f.brain.handle("chat.history", async () => {
      throw new RpcError(-32603, "failed");
    });
    f.brain.emit("chat.done", {
      runId: assistant.runId as string,
      messageId: assistant.id,
      stopReason: "stop",
    });
    await flush();
    expect(f.controller.getSnapshot()).toMatchObject({ historyError: true, hasMore: true });
    f.brain.handle("chat.history", f.historyCall);
    await f.controller.retryHistory();
    expect(f.historyCall).toHaveBeenLastCalledWith(
      { botId: f.data.bot.id, limit: 50 },
      { signal: expect.any(AbortSignal) },
    );
    expect(f.controller.getSnapshot().historyError).toBe(false);
  });
  it("does not resend an uncertain RPC while history recovery is pending", async () => {
    const f = fixture();
    await f.controller.start();
    f.brain.handle("chat.send", async ({ text }) => {
      await f.sendCall({ text });
      throw new RpcError(-32000, "timeout");
    });
    const send = f.controller.send("hello");
    expect(await f.controller.send("hello")).toBe(false);
    await send;
    expect(f.controller.getSnapshot().requestError).toBe("uncertain");
    expect(activeRun(f.controller.getSnapshot())).toBeTruthy();
    expect(await f.controller.send("hello")).toBe(false);
  });
});

describe("renderer", () => {
  it("offers the inline command help and accepts it with Tab only at the end of the draft", () => {
    const edit = vi.fn();
    const draft = "/Team Calendar ";
    let onKeyDown: ReturnType<typeof useNextReplySuggestion>["onKeyDown"] | undefined;
    function Fixture() {
      const suggestion = useNextReplySuggestion({
        text: draft,
        completion: "help",
        messages: [],
        topics: [],
        notices: [],
        hidden: false,
        edit,
        textarea: { current: null },
      });
      onKeyDown = suggestion.onKeyDown;
      return (
        <NextReplyField suggestion={suggestion}>
          <textarea value={draft} readOnly />
        </NextReplyField>
      );
    }
    const html = renderToStaticMarkup(<Fixture />);
    expect(html).toContain('data-completion="true"');
    expect(html).toContain("<kbd>Tab</kbd>");
    expect(html).toContain(`${draft}help`);
    const tab = (caret: number) =>
      ({
        key: "Tab",
        nativeEvent: { isComposing: false },
        currentTarget: { selectionStart: caret, selectionEnd: caret },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }) as unknown as KeyboardEvent<HTMLTextAreaElement>;
    expect(onKeyDown?.(tab(0), false)).toBe(false);
    expect(onKeyDown?.(tab(draft.length), true)).toBe(false);
    expect(onKeyDown?.(tab(draft.length), false)).toBe(true);
    expect(edit).toHaveBeenCalledExactlyOnceWith(`${draft}help`);
  });

  it.each(["zh", "en"] as const)(
    "renders the empty state and chat controls with the model moved out of the header in %s",
    async (language) => {
      const f = fixture();
      await f.controller.start();
      context.peer = f.peer;
      context.language = language;
      vi.stubGlobal("window", { pibot: { platform: "darwin" } });
      const html = renderToStaticMarkup(
        <ComposerDraftProvider>
          <ChatScreen />
        </ComposerDraftProvider>,
      );
      const t = createTranslator(language);
      expect(html).toContain(t("chat.hello", { name: "Pi" }));
      expect(html).toContain(t("suggestion.plan"));
      expect(html).not.toContain("Test model");
      expect(html).toContain(t("appMenu.title"));
      expect(html).toContain(t("workspace.new"));
      expect(html).not.toContain('title="Pi Bot"');
    },
  );
  it.each(["win32", "linux"])(
    "renders the brand on %s and a no-model settings prompt",
    async (platform) => {
      const f = fixture();
      f.data.models = [];
      await f.controller.start();
      context.peer = f.peer;
      vi.stubGlobal("window", { pibot: { platform } });
      const html = renderToStaticMarkup(
        <ComposerDraftProvider>
          <ChatScreen />
        </ComposerDraftProvider>,
      );
      // The Windows/Linux brand moved into the window title strip (main.tsx), out of the sidebar.
      expect(html).not.toContain("Pi Bot</strong>");
      expect(html).toContain("去设置");
    },
  );
  it("renders a streaming cursor/stop button, then an auth error with Check Key and retry", async () => {
    const f = fixture();
    await f.controller.start();
    await f.controller.send("hello");
    context.peer = f.peer;
    vi.stubGlobal("window", { pibot: { platform: "darwin" } });
    expect(
      renderToStaticMarkup(
        <ComposerDraftProvider>
          <ChatScreen />
        </ComposerDraftProvider>,
      ),
    ).toContain('aria-label="停止生成"');
    expect(
      renderToStaticMarkup(
        <ComposerDraftProvider>
          <ChatScreen />
        </ComposerDraftProvider>,
      ),
    ).toContain('aria-label="Pi 正在回复…"');
    const assistant = f.data.history.at(-1) as Message;
    assistant.status = "error";
    assistant.errorCode = "auth_failed";
    f.brain.emit("chat.error", {
      runId: assistant.runId as string,
      messageId: assistant.id,
      code: "auth_failed",
      message: "raw diagnostic",
    });
    await flush();
    const html = renderToStaticMarkup(
      <ComposerDraftProvider>
        <ChatScreen />
      </ComposerDraftProvider>,
    );
    expect(html).toContain("检查 Key");
    expect(html).toContain("重试");
    expect(html).not.toContain("raw diagnostic");
  });
  it("renders GFM tables/lists/code and safe external links; blocks HTML, scripts and remote images", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          '| A | B |\n| - | - |\n| 1 | 2 |\n\n- item\n\n```ts\nconst a = 1\n```\n\n[link](https://example.com)\n\n[bad](javascript:alert)\n\n<img src="https://example.com/track">\n\n![alt](https://example.com/track)'
        }
      />,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<li>item</li>");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('href="https://example.com/"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
  it.each([
    "file:///private",
    "javascript:alert(1)",
    "data:text/html,test",
    "/relative",
    "mailto:test@example.com",
  ])("rejects unsupported external URL %s", (url) => {
    expect(externalUrl(url)).toBeUndefined();
  });
  it("sends only plain Enter, including IME composition and keyCode 229 guards", () => {
    const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };
    expect(shouldSend(enter, false)).toBe(true);
    for (const event of [
      { ...enter, shiftKey: true },
      { ...enter, isComposing: true },
      { ...enter, keyCode: 229 },
      { ...enter, key: "a" },
    ])
      expect(shouldSend(event, false)).toBe(false);
    expect(shouldSend(enter, true)).toBe(false);
  });
});
