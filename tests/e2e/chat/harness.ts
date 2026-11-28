import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { textOf } from "../../../packages/brain/src/resources/packages/skill-package.ts";
import { startBrain } from "../../../packages/brain-app/src/index.ts";
import {
  createPeer,
  type EventPayloads,
  Events,
  Methods,
  type Port,
} from "../../../packages/protocol/src/index.ts";
import { zipEntries } from "../../../packages/teams/src/brain/teams/team-archive.ts";
import { startFakeLlm } from "../../../tools/fake-llm/index.ts";
import { loadScenario, type Scenario } from "../../../tools/fake-llm/scenario.ts";
import { withToolDiscovery } from "../../../tools/fake-llm/tool-discovery.ts";
import { toolLoadGroup } from "../product-tool-groups.ts";

export async function until<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  /** Scenario-specific budget: a real cron boundary or a loaded cold start needs more than 60 s. */
  timeoutMs = 180_000,
) {
  // A loaded development machine can spend well over a minute compiling a cold owner or draining
  // a sibling Bot. The condition remains the assertion; this only gives it a load-tolerant budget.
  const signal = AbortSignal.timeout(timeoutMs);
  while (!signal.aborted) {
    const value = await read();
    if (ready(value)) return value;
    try {
      await wait(40, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  throw new Error(`演练超时：${label}`);
}

/** A scenario name, or a scenario built by the probe itself (paths that depend on today's date). */
export async function fixture(
  scenarioName: string | Scenario,
  temporaryRoot: string,
  /** Extra host capabilities a probe stubs (e.g. revealPath); the base host stays fixed. */
  extraHost: Partial<Parameters<typeof startBrain>[0]["host"]> = {},
  /** Probe-only brain options (a stubbed page source for web_fetch). */
  extraBrain: Pick<
    Parameters<typeof startBrain>[0],
    "pageFetch" | "imageGenerationTimeoutMs" | "plugins" | "video"
  > = {},
  /** Cache probe: wire API and compat flags of the synthetic provider, raw request bodies. */
  probe: {
    api?: "openai-completions" | "openai-responses";
    compat?: Record<string, boolean>;
    onRequest?: (body: Record<string, unknown>, route: string, index: number) => void;
    /** Image probe: delay of the n-th fake image response. */
    imageDelayMs?: (index: number) => number;
    /** Additional fake model endpoints used by this scenario. */
    allowedFetchOrigins?: readonly string[];
  } = {},
) {
  const scenario =
    typeof scenarioName === "string" ? await loadScenario(scenarioName) : scenarioName;
  scenario.replies = withToolDiscovery(scenario.replies, toolLoadGroup);
  if (scenario.routes)
    for (const [model, replies] of Object.entries(scenario.routes))
      scenario.routes[model] = withToolDiscovery(replies, toolLoadGroup);
  const root = await realpath(await mkdtemp(join(temporaryRoot, "fixture-")));
  const subscriptions = [new Set<(v: unknown) => void>(), new Set<(v: unknown) => void>()];
  const ports = [0, 1].map(
    (i): Port => ({
      post(value) {
        const copy = structuredClone(value);
        queueMicrotask(() => {
          for (const listener of subscriptions[1 - i] ?? []) listener(copy);
        });
      },
      onMessage(listener) {
        subscriptions[i]?.add(listener);
        return () => {
          subscriptions[i]?.delete(listener);
        };
      },
    }),
  );
  const requests: Array<{
    route: string;
    index: number;
    memory: boolean;
    summary: boolean;
    tools: number;
    /** Size of the injected workflow block (0 when the request has none). */
    workflowChars: number;
  }> = [];
  const server = await startFakeLlm({
    port: 0,
    scenario,
    logDirectory: join(root, "http"),
    ...(probe.imageDelayMs ? { imageDelayMs: probe.imageDelayMs } : {}),
    observe(body, route, index) {
      probe.onRequest?.(body, route, index);
      // Image service requests have no chat messages; only the probe's own observer sees them.
      if (route === "images") return;
      const text = JSON.stringify(body.messages ?? body.input);
      requests.push({
        route,
        index,
        memory: text.includes("报告先写结论"),
        summary: text.includes("Create a concise work checkpoint"),
        tools: Array.isArray(body.tools) ? body.tools.length : 0,
        workflowChars:
          text.indexOf("<workflow name=") < 0
            ? 0
            : text.indexOf("</workflow>") - text.indexOf("<workflow name="),
      });
      if (requests.length > 256) throw new Error("演练请求超过有界预算");
    },
  });
  const originalFetch = globalThis.fetch;
  let blocked = 0;
  globalThis.fetch = (input, options) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== server.url && !probe.allowedFetchOrigins?.includes(url.origin)) {
      blocked++;
      return Promise.reject(new Error("演练禁止非指定假模型端口"));
    }
    return originalFetch(input, { ...options, redirect: "error" });
  };
  const client = createPeer(ports[1] as Port, { methods: Methods, events: Events });
  const statuses: EventPayloads["chat.status"][] = [];
  client.on("chat.status", (status) => {
    statuses.push(status);
    if (statuses.length > 256) statuses.shift();
  });
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined;
  let exported = "";
  let select = false;
  let nextFolder: string | undefined;
  let stage = "启动";
  const cleanup = async () => {
    // A failed drain keeps the network guard and resources inside this Worker.
    // Only its supervisor may delete the root, after a certified Worker exit.
    await brain?.stop();
    client.dispose();
    await server.stop();
    globalThis.fetch = originalFetch;
  };
  try {
    // Share production assembly so a newly extracted capability cannot disappear from fixtures.
    const brainOptions: Parameters<typeof startBrain>[0] = {
      ...extraBrain,
      port: ports[0] as Port,
      dataDir: join(root, "data"),
      version: "chat-synthetic",
      platform: process.platform,
      host: {
        ...extraHost,
        secrets: {
          isAvailable: async () => true,
          encrypt: async (plain) => Buffer.from(plain),
          decrypt: async (cipher) => Buffer.from(cipher).toString(),
        },
        env: {
          detect: async () => [],
          read: async () => {
            throw new Error("不读取宿主凭据");
          },
        },
        // One-shot override so a probe can import a skill folder through the real picker path.
        pickFolder: async () => {
          const picked = nextFolder ?? root;
          nextFolder = undefined;
          return picked;
        },
        teams: {
          pickFile: async () => (select ? join(root, "synthetic.pibot") : null),
          // The host hands brain the file's raw bytes (base64); exports are v3 zips.
          read: async () => exported,
          save: async (payload) => {
            exported =
              "archive" in payload
                ? payload.archive
                : Buffer.from(JSON.stringify(payload.template)).toString("base64");
            return { saved: true };
          },
          cancel: async () => {
            select = false;
          },
        },
      },
    };
    brain = await startBrain(brainOptions);
    stage = "设置语言";
    await client.call("settings.set", { language: "zh" });
    // These scenarios were written for "ask before writing"; maintainers 2026-10-23 made in-workplace
    // writes default to "always" (covered by the fewer-approvals probe), so pin the old level here.
    await client.call("permissions.set", { levels: { write_file: "ask" } });
    const main = (await client.call("bots.list", {})).find((bot) => bot.isMain);
    assert(main);
    // Create without a model, then name explicitly: persona generation must not
    // silently consume the first collaboration/compaction reply.
    stage = "创建 Bot";
    const researcher = await client.call("bots.create", { description: "合成研究员" });
    const writer = await client.call("bots.create", { description: "合成写手" });
    stage = "配置假模型";
    const { id: provider } = await client.call("customProviders.upsert", {
      name: "本地假模型",
      baseUrl: `${server.url}/v1`,
      api: probe.api ?? "openai-completions",
      ...(probe.compat ? { compat: probe.compat } : {}),
      apiKey: "synthetic-chat-key-only",
      models: ["coordinator", "researcher", "writer"].map((id) => ({
        id,
        // The system prompt, core tools and a two-turn history must all fit; at 32K the
        // compaction trigger sat on the same number as the request limit, so a longer tool
        // description moved the checkpoint boundary. 64K leaves the history, not the
        // fixed prompt, to decide when the fixture checkpoints.
        contextWindow: 65536,
        maxTokens: 2048,
      })),
    });
    // The application default stays independent of Pi; the second fixture
    // needs its own provider identity for unavailable template model fallbacks.
    stage = "配置合成应用默认";
    await client.call("settings.set", {
      defaultModel: { provider, id: "coordinator", thinkingLevel: "off" },
    });
    for (const [bot, name, model] of [
      [main, "统筹", "coordinator"],
      [researcher, "研究员", "researcher"],
      [writer, "写手", "writer"],
    ] as const) {
      stage = `配置 ${model}`;
      await client.call("bots.update", {
        botId: bot.id,
        name,
        modelProvider: provider,
        modelId: model,
        thinkingLevel: "off",
      });
      stage = `关联目录 ${model}`;
      const workplaces = await client.call("workplaces.add", { botId: bot.id });
      const folder = workplaces.folders.find((folder) => folder.path === root);
      assert(folder);
      await client.call("workplaces.setCurrent", { botId: bot.id, folderId: folder.id });
    }
    stage = "创建群";
    const group = await client.call("groups.create", {
      name: "合成群",
      botIds: [main.id, researcher.id, writer.id],
      coordinatorBotId: main.id,
      autoRoundLimit: 10,
    });
    return {
      root,
      client,
      main,
      researcher,
      writer,
      group,
      requests,
      statuses,
      cleanup,
      /** The fake server's origin, for probes that configure another provider on it. */
      serverUrl: server.url,
      counts: server.counts,
      blocked: () => blocked,
      /**
       * A graceful stop and a new brain on the same data directory, port and fake model.
       * `between` runs while no brain is open (a probe restores a crash-time snapshot there).
       */
      restart: async (between?: () => Promise<void>) => {
        await brain?.stop();
        brain = undefined;
        await between?.();
        brain = await startBrain(brainOptions);
      },
      pickFolderNext: (path: string) => {
        nextFolder = path;
      },
      selectExport: (text?: string) => {
        if (text !== undefined) exported = text;
        select = true;
      },
      exportFile: () => exported,
      // team.json of the exported version-3 zip, for assertions on what was shared.
      exportText: () =>
        textOf(
          zipEntries(Buffer.from(exported, "base64")).find((e) => e.path === "team.json")?.data ??
            Buffer.alloc(0),
        ) ?? "",
    };
  } catch (error) {
    console.error(`合成 fixture 失败阶段：${stage}`);
    await cleanup();
    throw error;
  }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function groupIdle(f: Fixture) {
  return until(
    "群真实终态",
    () => f.client.call("chat.runs", { groupId: f.group.id }),
    (runs) => runs.length > 0 && runs.every((run) => !["running", "queued"].includes(run.status)),
  );
}
export async function dmDone(f: Fixture, text: string, newTopic = false) {
  const receipt = await f.client.call("chat.send", {
    botId: f.researcher.id,
    text,
    ...(newTopic ? { newTopic: true } : {}),
  });
  const history = await until(
    "私聊真实终态",
    () =>
      f.client.call("chat.history", { botId: f.researcher.id, topicId: receipt.conversationId }),
    (rows) =>
      rows.some((row) => row.id === receipt.assistantMessageId && row.status !== "streaming"),
  );
  return history.find((row) => row.id === receipt.assistantMessageId);
}
export async function sessionEntries(root: string): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".jsonl"))
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          if (line) output.push(JSON.parse(line));
        }
    }
  }
  await visit(join(root, "data", "bots"));
  return output;
}
