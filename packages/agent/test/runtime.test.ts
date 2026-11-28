import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRedactor } from "@pibot/secrets";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntime,
  BotSession,
  CustomProviderConfig,
  OpenSessionOptions,
} from "../src/core/types.ts";
import { AgentError, createAgentRuntime, mapAgentError } from "../src/index.ts";

const root = fs.mkdtempSync(join(tmpdir(), "pibot-t7-"));
const home = join(root, "home");
const dataDir = join(root, "data");
const foreignPi = join(home, ".pi");
const foreignAuth = join(foreignPi, "agent", "auth.json");
const fixture = JSON.stringify({ openai: { type: "api_key", key: "fake-foreign" } });
const previousEnv = { ...process.env };
const restorers: Array<() => void> = [];
let networkAttempts = 0;
let commandAttempts = 0;
let foreignAccesses = 0;
let fixtureMtime = 0;
let pi: typeof import("@earendil-works/pi-coding-agent");
let keys = new Map<string, string>();
let custom: CustomProviderConfig[] = [];
let runtime: AgentRuntime;
const sessions: BotSession[] = [];
const captured: ModelRuntime[] = [];
const streamRestorers: Array<() => void> = [];
const local: CustomProviderConfig = {
  id: "ollama",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:1/v1",
  api: "openai-completions",
  compat: { supportsDeveloperRole: false },
  models: [{ id: "fake-model" }],
};

function replace(target: object, name: string, replacement: unknown) {
  const original = Reflect.get(target, name);
  Reflect.set(target, name, replacement);
  restorers.push(() => {
    Reflect.set(target, name, original);
  });
}
function denyNetwork(): never {
  networkAttempts++;
  throw new Error("Tests must not use real network");
}
function denyCommand(): never {
  commandAttempts++;
  throw new Error("Tests must not launch subprocesses");
}
function message(
  model: Model<Api>,
  text = "hello",
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    model: model.id,
    api: model.api,
    content: [{ type: "text", text }],
    stopReason,
    errorMessage,
    usage: {
      input: 2,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}
function fakeStream(
  stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop",
  errorMessage?: string,
  waitForAbort = false,
) {
  const spy = vi
    .spyOn(pi.ModelRuntime.prototype, "streamSimple")
    .mockImplementation((model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const result = message(model, "hello", stopReason, errorMessage);
      queueMicrotask(() => {
        stream.push({ type: "start", partial: result });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hel", partial: result });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "lo", partial: result });
        if (waitForAbort) {
          const finish = () => {
            result.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: result });
          };
          if (options?.signal?.aborted) finish();
          else options?.signal?.addEventListener("abort", finish, { once: true });
        } else if (stopReason === "error" || stopReason === "aborted")
          stream.push({ type: "error", reason: stopReason, error: result });
        else stream.push({ type: "done", reason: stopReason, message: result });
      });
      return stream;
    });
  streamRestorers.push(() => spy.mockRestore());
  return spy;
}
function options(model = { provider: "ollama", id: "fake-model" }): OpenSessionOptions {
  return {
    botId: "test",
    homeDir: join(dataDir, "bots", "test", "home"),
    sessionDir: join(dataDir, "bots", "test", "sessions"),
    model,
    thinkingLevel: "off",
    systemPrompt: "Pi Bot test prompt",
  };
}
async function open(opts = options()) {
  const session = await runtime.openSession(opts);
  sessions.push(session);
  return session;
}

beforeAll(async () => {
  fs.mkdirSync(dirname(foreignAuth), { recursive: true });
  fs.writeFileSync(foreignAuth, fixture);
  fixtureMtime = fs.statSync(foreignAuth).mtimeMs;
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENAI_API_KEY: "fake-env",
    PI_CODING_AGENT_DIR: foreignPi,
    PI_CODING_AGENT_SESSION_DIR: foreignPi,
    PI_TELEMETRY: "1",
  });
  replace(globalThis, "fetch", denyNetwork);
  replace(net.Socket.prototype, "connect", denyNetwork);
  for (const api of [http, https]) {
    replace(api, "request", denyNetwork);
    replace(api, "get", denyNetwork);
  }
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    replace(childProcess, name, denyCommand);
  // Detect discovery and credential reads as well as modifications to the foreign .pi tree.
  for (const [api, names] of [
    [fs, ["readFileSync", "readdirSync", "writeFileSync", "existsSync"]],
    [fs.promises, ["readFile", "readdir", "writeFile"]],
  ] as const) {
    for (const name of names) {
      const original = Reflect.get(api, name);
      replace(api, name, (...args: unknown[]) => {
        const path = args[0];
        if (
          typeof path === "string" &&
          (path.startsWith(foreignPi) ||
            path.includes("application_default_credentials.json") ||
            path.includes(`${join(".agents", "skills")}`))
        ) {
          foreignAccesses++;
          throw new Error("Foreign .pi access is forbidden");
        }
        return Reflect.apply(original, api, args);
      });
    }
  }
  syncBuiltinESMExports();
  runtime = createAgentRuntime({
    dataDir,
    hasApiKey: (id) => keys.has(id),
    getApiKey: async (id) => keys.get(id),
    customProviders: () => custom,
  });
  pi = await import("@earendil-works/pi-coding-agent");
  const create = pi.ModelRuntime.create.bind(pi.ModelRuntime);
  const spy = vi.spyOn(pi.ModelRuntime, "create").mockImplementation(async (opts) => {
    expect(opts).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(opts?.credentials).toBeDefined();
    const result = await create(opts);
    captured.push(result);
    return result;
  });
  restorers.push(() => spy.mockRestore());
});
beforeEach(() => {
  keys = new Map();
  custom = [];
  captured.length = 0;
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const restore of streamRestorers.splice(0).reverse()) restore();
  expect(networkAttempts).toBe(0);
  expect(commandAttempts).toBe(0);
  expect(foreignAccesses).toBe(0);
});
afterAll(() => {
  for (const restore of restorers.reverse()) restore();
  syncBuiltinESMExports();
  try {
    expect(fs.readdirSync(foreignPi)).toEqual(["agent"]);
    expect(fs.readdirSync(dirname(foreignAuth))).toEqual(["auth.json"]);
    expect(fs.readFileSync(foreignAuth, "utf8")).toBe(fixture);
    expect(fs.statSync(foreignAuth).mtimeMs).toBe(fixtureMtime);
    expect(fs.readdirSync(join(dataDir, "pi"))).toEqual([]);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("real pi SDK isolation", () => {
  it("ignores foreign auth.json and environment keys, reports no_model by availability", async () => {
    expect((await runtime.listModels()).some((model) => model.provider === "openai")).toBe(true);
    expect(await runtime.listModels({ availableOnly: true })).toEqual([]);
    expect(captured.at(-1)?.getProviderAuthStatus("openai")).toEqual({ configured: false });
    await expect(open(options({ provider: "openai", id: "missing" }))).rejects.toEqual(
      new AgentError("no_model"),
    );
    expect(await runtime.testProvider("openai")).toEqual({ ok: false, error: "no_model" });
  });
  it("uses current key presence on each list and injects literal keys only for the selected provider", async () => {
    keys.set("openai", "$OPENAI_API_KEY");
    keys.set("azure", "fake-cloud");
    expect(
      (await runtime.listModels({ availableOnly: true })).every(
        (model) => model.provider === "openai",
      ),
    ).toBe(true);
    const model = (await runtime.listModels({ availableOnly: true }))[0];
    if (!model) throw new Error("Missing test model");
    await open(options({ provider: model.provider, id: model.id }));
    expect((await captured.at(-1)?.getAuth("openai"))?.auth.apiKey).toBe("$OPENAI_API_KEY");
    keys.delete("openai");
    expect(await runtime.listModels({ availableOnly: true })).toEqual([]);
  });
  it("registers keyless local models and keeps headers and keys literal", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test literal pi template syntax
    const header = "$OPENAI_API_KEY ${HOME} $$ literal";
    custom = [{ ...local, headers: { "X-Test": header } }];
    expect(await runtime.listModels({ availableOnly: true })).toEqual([
      expect.objectContaining({ provider: "ollama", id: "fake-model", contextWindow: 131072 }),
    ]);
    const model = captured.at(-1)?.getModel("ollama", "fake-model");
    expect(model?.compat).toMatchObject({ supportsDeveloperRole: false });
    expect(captured.at(-1)?.getRegisteredProviderConfig("ollama")?.apiKey).toBeUndefined();
    if (!model) throw new Error("Missing test model");
    expect((await captured.at(-1)?.getAuth(model))?.auth).toMatchObject({
      headers: { "X-Test": header },
    });
    keys.set("ollama", "$literal-key");
    await open(options({ provider: "ollama", id: "fake-model" }));
    expect((await captured.at(-1)?.getAuth("ollama"))?.auth.apiKey).toBe("$literal-key");
  });
  it("rejects command keys, headers and builtin shadowing before execution", async () => {
    keys.set("openai", "!never-run");
    await expect(open(options({ provider: "openai", id: "gpt-4o" }))).rejects.toEqual(
      new AgentError("internal"),
    );
    keys.clear();
    custom = [{ ...local, headers: { "X-Test": "!never-run" } }];
    await expect(runtime.listModels()).rejects.toEqual(new AgentError("internal"));
    custom = [{ ...local, id: "openai" }];
    await expect(runtime.listModels()).rejects.toEqual(new AgentError("internal"));
  });
  it("creates/opens only explicit sessions and disables tools, resources, telemetry", async () => {
    custom = [local];
    fakeStream();
    let actual: AgentSession | undefined;
    // The SDK module namespace cannot be reassigned; inspect sessions at their subscribe boundary.
    const subscribe = pi.AgentSession.prototype.subscribe;
    const spy = vi.spyOn(pi.AgentSession.prototype, "subscribe").mockImplementation(function (
      this: AgentSession,
      listener,
    ) {
      actual = this;
      return subscribe.call(this, listener);
    });
    streamRestorers.push(() => spy.mockRestore());
    const session = await open();
    expect(dirname(join(dataDir, session.sessionFile))).toBe(options().sessionDir);
    const deltas: string[] = [];
    expect(
      await session.prompt("hello", (event) => {
        if (event.type === "delta") deltas.push(event.text);
      }),
    ).toMatchObject({
      stopReason: "stop",
      usage: { totalTokens: 5 },
    });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(actual?.getActiveToolNames()).toEqual([]);
    expect(actual?.agent.state.tools).toEqual([]);
    expect(actual?.agent.state.systemPrompt).toBe(
      // pi writes the cwd section with forward slashes on Windows (system-prompt.js).
      `Pi Bot test prompt\n\n<cwd>\n${options().homeDir.replaceAll("\\", "/")}\n</cwd>`,
    );
    expect(actual?.settingsManager.getEnableInstallTelemetry()).toBe(false);
    const file = session.sessionFile;
    session.dispose();
    const reopened = await open({ ...options(), sessionFile: file });
    expect(reopened.sessionFile).toBe(file);
    expect(await reopened.prompt("again", () => {})).toMatchObject({ stopReason: "stop" });
  });
  it("supports a fresh HOME without creating .pi", async () => {
    const cleanHome = join(root, "clean-home");
    fs.mkdirSync(cleanHome);
    process.env.HOME = cleanHome;
    process.env.USERPROFILE = cleanHome;
    try {
      custom = [local];
      const session = await open();
      await session.abort();
      expect(fs.existsSync(join(cleanHome, ".pi"))).toBe(false);
    } finally {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
    }
  });
  it("reopens a lazily created session before its first response", async () => {
    custom = [local];
    const session = await open();
    expect(fs.existsSync(join(dataDir, session.sessionFile))).toBe(false);
    const file = session.sessionFile;
    session.dispose();
    expect((await open({ ...options(), sessionFile: file })).sessionFile).toBe(file);
  });
  it("rejects paths outside the bot session directory", async () => {
    custom = [local];
    await expect(open({ ...options(), sessionDir: foreignPi })).rejects.toEqual(
      new AgentError("internal"),
    );
    await expect(open({ ...options(), sessionFile: foreignAuth })).rejects.toEqual(
      new AgentError("session_unavailable"),
    );
  });
});

describe("prompt lifecycle with fake pi streams", () => {
  beforeEach(() => {
    custom = [local];
  });
  it("aborts a running stream and preserves the emitted partial text", async () => {
    fakeStream("stop", undefined, true);
    const session = await open();
    const deltas: string[] = [];
    let ready: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const result = session.prompt("hello", (event) => {
      if (event.type !== "delta") return;
      deltas.push(event.text);
      ready?.();
    });
    const rejected = expect(result).rejects.toEqual(new AgentError("aborted"));
    await started;
    await session.abort();
    await rejected;
    expect(deltas.join("")).toBe("hello");
  });
  it.each([
    ["401 rejected", "auth_failed"],
    ["429 rate limited", "rate_limited"],
    ["fetch failed", "network"],
    ["503 unavailable", "provider_overloaded"],
    ["raw secret diagnostic", "provider_error"],
  ] as const)("maps provider stream error %s", async (diagnostic, code) => {
    fakeStream("error", diagnostic);
    const session = await open();
    const retries = code === "network" || code === "rate_limited" || diagnostic.startsWith("503");
    if (retries) vi.useFakeTimers();
    try {
      // A dropped stream (network / 5xx) keeps the "hello" the user already saw and ends
      // as an interrupted length stop for the run to continue; other errors still reject.
      const settled =
        code === "network" || code === "provider_overloaded"
          ? expect(session.prompt("hello", () => {})).resolves.toMatchObject({
              stopReason: "length",
              interrupted: true,
            })
          : expect(session.prompt("hello", () => {})).rejects.toEqual(
              new AgentError(
                code,
                /^[45]\d\d/.test(diagnostic) ? Number(diagnostic.slice(0, 3)) : undefined,
              ),
            );
      // Flush scheduled callbacks; this fixture already carries output, so the automatic retry
      // does not replay it.
      if (retries) await vi.runAllTimersAsync();
      await settled;
    } finally {
      if (retries) vi.useRealTimers();
    }
  });
  it("refreshes credentials and reports no_model when a configured key is removed", async () => {
    const models = await runtime.listModels();
    const model = models.find((entry) => entry.provider === "openai");
    if (!model) throw new Error("Missing builtin model");
    keys.set("openai", "fake-key");
    fakeStream();
    const session = await open(options({ provider: model.provider, id: model.id }));
    keys.delete("openai");
    await expect(session.prompt("hello", () => {})).rejects.toEqual(new AgentError("no_model"));
    keys.set("openai", "new-fake-key");
    await expect(session.prompt("hello", () => {})).resolves.toMatchObject({ stopReason: "stop" });
    expect((await captured.at(-1)?.getAuth("openai"))?.auth.apiKey).toBe("new-fake-key");
  });
  it("tests builtin providers with a tiny fake request and maps errors", async () => {
    keys.set("openai", "fake-key");
    const spy = vi
      .spyOn(pi.ModelRuntime.prototype, "completeSimple")
      .mockImplementation(async (model, _context, opts) => {
        expect(opts?.maxTokens).toBe(8);
        return message(model);
      });
    streamRestorers.push(() => spy.mockRestore());
    expect(await runtime.testProvider("openai")).toMatchObject({ ok: true });
    spy.mockImplementation(async (model) => message(model, "", "error", "401 raw-key"));
    expect(await runtime.testProvider("openai")).toEqual({
      ok: false,
      error: "auth_failed",
      httpStatus: 401,
      testedModels: ["gpt-5-nano"],
    });
  });

  it.each(["primary", "auxiliary", "auxiliary only"])(
    "charges one tool translation to the run (%s)",
    async (selection) => {
      keys.set("openai", "fake-key");
      const primary = { provider: "openai", id: "gpt-5-mini" };
      const auxiliary = { provider: "openai", id: "gpt-5-nano" };
      const agent = createAgentRuntime({
        dataDir,
        hasApiKey: (id) => keys.has(id),
        getApiKey: async (id) => keys.get(id),
        customProviders: () => [],
        auxiliaryModel: () => (selection === "primary" ? undefined : auxiliary),
      });
      const english = '["used books book swap warm","poster"]';
      const query = '["旧书 交换 温暖","海报"]';
      const complete = vi
        .spyOn(pi.ModelRuntime.prototype, "completeSimple")
        .mockImplementation(async (model) => {
          const result = message(model, english);
          result.usage.cost.total = 0.001;
          return result;
        });
      streamRestorers.push(() => complete.mockRestore());
      const observer = { beforeRequest: vi.fn(), settled: vi.fn() };
      await expect(
        agent.transformMessage?.({
          kind: "tool_input_translation",
          model: selection === "auxiliary only" ? undefined : primary,
          text: query,
          language: "en",
          observer,
          signal: new AbortController().signal,
        }),
      ).resolves.toBe(english);
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining(selection === "primary" ? primary : auxiliary),
        expect.objectContaining({
          messages: [expect.objectContaining({ role: "user", content: query })],
        }),
        expect.objectContaining({
          maxTokens: 192,
          maxRetries: 0,
          timeoutMs: 8_000,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(observer.beforeRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: "auxiliary" }),
      );
      expect(observer.settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ usage: { tokens: 5, costUsd: 0.001 } }),
      );
    },
  );
});

describe("custom model discovery using fetch stubs", () => {
  function stubFetch(response: Response) {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(response);
    const previous = globalThis.fetch;
    globalThis.fetch = spy;
    streamRestorers.push(() => {
      globalThis.fetch = previous;
    });
    return spy;
  }
  it("uses the configured /models path and literal headers without redirects", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ data: [{ id: "a" }, { id: "a" }, { id: "b" }] })),
    );
    expect(
      await runtime.fetchCustomModels({
        baseUrl: local.baseUrl,
        api: local.api,
        headers: { "X-Test": "$literal" },
        apiKey: "fake-key",
      }),
    ).toEqual([{ id: "a" }, { id: "b" }]);
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:1/v1/models");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-Test")).toBe("$literal");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fake-key");
  });
  it.each([false, true])(
    "streams Ollama through the real HTTP client with fake SSE (injected Key: %s)",
    async (withKey) => {
      custom = [{ ...local, headers: { "X-Literal": "$OPENAI_API_KEY" } }];
      if (withKey) keys.set("ollama", "$literal-api-key");
      const chunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null },
          ],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ];
      const sse = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
      const spy = stubFetch(
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
      );
      const session = await open();
      const deltas: string[] = [];
      expect(
        await session.prompt("hello", (event) => {
          if (event.type === "delta") deltas.push(event.text);
        }),
      ).toMatchObject({
        stopReason: "stop",
      });
      expect(deltas.join("")).toBe("hello");
      expect(spy).toHaveBeenCalledOnce();
      const [url, init] = spy.mock.calls[0] ?? [];
      expect(String(url)).toBe("http://127.0.0.1:1/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        withKey ? "Bearer $literal-api-key" : null,
      );
      expect(new Headers(init?.headers).get("X-Literal")).toBe("$OPENAI_API_KEY");
    },
  );
  it.each([
    [
      400,
      "Input tag 'developer' found using 'role' does not match any of the expected tags: 'system', 'user', 'assistant', 'tool'",
    ],
    [
      200,
      String.raw`Tool 20 function has invalid 'parameters' schema: '^[^\p{Cc}\p{Cf}]+$' is not a 'regex'. Failed validating 'format' in metaschema. On schema['properties']['items']['items']['properties']['id']['pattern']: '^[^\p{Cc}\p{Cf}]+$'`,
    ],
    [200, "Unexpected message role."],
    [422, "Invalid value for the network field."],
  ] as const)("preserves the upstream chat explanation for HTTP %i: %s", async (status, detail) => {
    custom = [local];
    const error = JSON.stringify({ error: { message: `${detail}\nAdditional gateway context` } });
    const streaming = status === 200;
    const fetch = stubFetch(
      new Response(streaming ? `data: ${error}\n\n` : error, {
        status,
        headers: { "content-type": streaming ? "text/event-stream" : "application/json" },
      }),
    );
    const session = await open({
      ...options(),
      systemPrompt: "Check each message role: system, user, assistant, tool.",
      redactProviderDetail: createRedactor().redact,
    });
    await expect(session.prompt("hello", () => {})).rejects.toMatchObject({
      code: streaming ? "provider_error" : "provider_rejected",
      httpStatus: status,
      providerDetail: detail,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const transcript = fs.readFileSync(join(dataDir, session.sessionFile), "utf8");
    expect(transcript).not.toContain(JSON.stringify(detail).slice(1, -1));
  });
  it("uses API-specific authentication and response formats", async () => {
    const spy = stubFetch(
      new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] })),
    );
    expect(
      await runtime.fetchCustomModels({
        baseUrl: "https://example.invalid/v1beta",
        api: "google-generative-ai",
        apiKey: "fake-key",
      }),
    ).toEqual([{ id: "gemini-test" }]);
    expect(new Headers(spy.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe("fake-key");
    spy.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "claude-test" }] })));
    await runtime.fetchCustomModels({
      baseUrl: "https://example.invalid/v1",
      api: "anthropic-messages",
      apiKey: "fake-key",
    });
    expect(new Headers(spy.mock.calls[1]?.[1]?.headers).get("x-api-key")).toBe("fake-key");
  });
  it("tests custom providers and maps rejected HTTP responses", async () => {
    custom = [local];
    const spy = vi
      .spyOn(pi.ModelRuntime.prototype, "completeSimple")
      .mockImplementation(async (model) => message(model));
    streamRestorers.push(() => spy.mockRestore());
    expect(await runtime.testProvider("ollama")).toEqual({ ok: true, modelCount: 1 });
  });
  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ] as const)("maps HTTP %d", async (status, code) => {
    stubFetch(new Response("sensitive response", { status }));
    await expect(
      runtime.fetchCustomModels({ baseUrl: local.baseUrl, api: local.api }),
    ).rejects.toEqual(new AgentError(code, status));
  });
  it("rejects dangerous inputs and malformed model catalogs", async () => {
    await expect(
      runtime.fetchCustomModels({ baseUrl: local.baseUrl, api: local.api, apiKey: "!command" }),
    ).rejects.toEqual(new AgentError("internal"));
    await expect(
      runtime.fetchCustomModels({
        baseUrl: local.baseUrl,
        api: local.api,
        headers: { bad: "!command" },
      }),
    ).rejects.toEqual(new AgentError("internal"));
    stubFetch(new Response(JSON.stringify({ data: [{}] })));
    try {
      await runtime.fetchCustomModels({ baseUrl: local.baseUrl, api: local.api });
      throw new Error("Expected failure");
    } catch (error) {
      expect(mapAgentError(error)).toBe("provider_error");
    }
  });
  it("maps an invalid JSON catalog to provider_error", async () => {
    stubFetch(new Response("invalid-json"));
    await expect(
      runtime.fetchCustomModels({ baseUrl: local.baseUrl, api: local.api }),
    ).rejects.toEqual(new AgentError("provider_error"));
  });
});
