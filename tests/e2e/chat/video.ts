import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Approval, EventPayloads, Message } from "../../../packages/protocol/src/index.ts";
import {
  type FakeVideoApi,
  fakeAgnesModels,
  fakeOpenRouterModel,
  fakeVideoClip,
  fakeVideoKey,
  startFakeVideo,
  startFakeVideoCdn,
} from "../../../tools/fake-llm/fake-video.ts";
import type { Reply } from "../../../tools/fake-llm/scenario.ts";
import type { AcceptanceResult } from "../supervisor.ts";
import { fixture, until as waitUntil } from "./harness.ts";

const until = <T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean) =>
  waitUntil(label, read, ready, 20_000);

const frame =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const families = ["openai-videos", "gemini-veo", "kling", "ark-seedance", "agnes"] as const;
const successes = [...families, "agnes"] as const;
const modes = ["cancel", "fail", "oversize", "restart", "timeout", "private"] as const;
const paid = (approval: Approval) =>
  approval.explanation?.some((step) => step.code === "video_generation_confirmation");
const jobId = (message: Message) =>
  message.usage &&
  typeof message.usage === "object" &&
  !Array.isArray(message.usage) &&
  typeof message.usage.videoJobId === "string"
    ? message.usage.videoJobId
    : undefined;

export async function runVideoScenario(root: string): Promise<AcceptanceResult> {
  const servers = new Map<(typeof families)[number], Awaited<ReturnType<typeof startFakeVideo>>>();
  const cdn = await startFakeVideoCdn();
  const builtinServers: Awaited<ReturnType<typeof startFakeVideo>>[] = [];
  try {
    for (const api of families) servers.set(api, await startFakeVideo(api));
    const builtinOpenAI = await startFakeVideo("openai-videos", true);
    builtinServers.push(builtinOpenAI);
    const builtinGoogle = await startFakeVideo("gemini-omni", true);
    builtinServers.push(builtinGoogle);
    const builtinOpenRouter = await startFakeVideo("openrouter-videos", true);
    builtinServers.push(builtinOpenRouter);
    const omni = { provider: "google", id: "gemini-omni-1.2-flash" } as const;
    const openRouter = { provider: "openrouter", id: fakeOpenRouterModel } as const;
    const framePlaceholders = ["https://example.com/", ""];
    const agnes = servers.get("agnes");
    assert(agnes);
    // The fake provider records this URL without fetching it. A public IP avoids a real DNS lookup.
    const firstFrameUrl = "https://8.8.8.8/first-frame.png";
    const jobs = [
      ...successes,
      "agnes",
      "agnes",
      ...modes.map(() => "openai-videos" as const),
    ] as const;
    const keyframeIndex = families.length;
    const modelId = (api: FakeVideoApi, index: number) =>
      api === "agnes" ? fakeAgnesModels[index === keyframeIndex ? 0 : 1] : "fake-video";
    const replies: Reply[] = jobs.flatMap((api, index) => [
      {
        toolCalls: [
          {
            name: "generate_video",
            arguments: {
              prompt: `Synthetic clip ${index + 1}`,
              ...(index > 0 ? { model: { provider: api, id: modelId(api, index) } } : {}),
              duration: 5,
              ...(api !== "agnes" && index < families.length
                ? { firstFrame: { path: "first-frame.png" } }
                : {}),
              ...(api === "agnes"
                ? { aspect: "3:4", size: index === keyframeIndex ? "2K" : "720P", seed: 17 }
                : {}),
              ...(index === keyframeIndex ? { firstFrame: { url: firstFrameUrl } } : {}),
            },
          },
        ],
      },
      { text: "Queued the synthetic clip." },
    ]);
    replies.splice(
      successes.length * 2,
      0,
      { toolCalls: [{ name: "list_video_models", arguments: {} }] },
      { text: "Listed video models." },
      ...["Sora", "Omni image", "Omni inline", "Omni cancel", "Omni timeout"].flatMap<Reply>(
        (name) => [
          {
            toolCalls: [
              {
                name: "generate_video",
                arguments: {
                  prompt: `Synthetic ${name} clip`,
                  duration: name === "Omni inline" ? 15 : 8,
                  ...(name === "Omni image" && {
                    firstFrame: { path: "first-frame.png" },
                    aspect: "9:16",
                  }),
                  ...(name === "Omni inline" && { size: "4k" }),
                },
              },
            ],
          },
          { text: "Queued the synthetic built-in clip." },
        ],
      ),
    );
    replies.push(
      ...framePlaceholders.flatMap<Reply>((url) => [
        {
          toolCalls: [
            {
              name: "generate_video",
              arguments: {
                model: openRouter,
                prompt: "Synthetic OpenRouter clip",
                duration: 4,
                aspect: "16:9",
                size: "480p",
                firstFrame: { url },
              },
            },
          ],
        },
        { text: "Queued the synthetic OpenRouter clip." },
      ]),
      {
        toolCalls: [
          {
            name: "write_file",
            arguments: { path: ".pibot/out/result.mov", content: "Synthetic delivery marker" },
          },
        ],
      },
      { text: "The resulting file is .pibot/out/result.mov." },
    );
    // The only cross-origin successes are explicitly routed to the fake CDN's random local port.
    // A private URL still goes through the production address-validation path.
    const fetchLocal = globalThis.fetch;
    const { publicVideoDownload } = await import("../../../packages/videos/src/brain/transport.ts");
    let listedModels = "";
    const f = await fixture(
      { replies },
      root,
      {},
      {
        video: {
          testBuiltinBaseUrls: {
            openai: builtinOpenAI.url,
            google: builtinGoogle.url,
            openrouter: builtinOpenRouter.url,
          },
          pollMs: 120,
          timeoutMs: 6000,
          publicDownload: async (url, signal, read) =>
            url === cdn.expected
              ? read(
                  await fetchLocal(`${cdn.url}${new URL(url).pathname}${new URL(url).search}`, {
                    signal,
                    redirect: "error",
                  }),
                )
              : publicVideoDownload(() => undefined)(url, signal, read),
        },
      },
      {
        allowedFetchOrigins: [agnes.url, builtinOpenAI.url, builtinGoogle.url, builtinOpenRouter.url],
        onRequest(body) {
          const messages = JSON.stringify(body.messages ?? []);
          if (messages.includes(omni.id) && messages.includes("providerId"))
            listedModels = messages;
        },
      },
    );
    const events: EventPayloads["videos.changed"][] = [];
    const off = f.client.on("videos.changed", (event) => events.push(event));
    try {
      await writeFile(join(f.root, "first-frame.png"), Buffer.from(frame, "base64"));
      await f.client.call("permissions.set", { levels: { web: "always", write_file: "always" } });
      await f.client.call("bots.update", { botId: f.researcher.id, memoryExtraction: false });
      const agnesConfig = {
        baseUrl: agnes.url,
        api: "openai-completions" as const,
        apiKey: fakeVideoKey("agnes"),
      };
      const catalog = await f.client.call("customProviders.fetchModels", agnesConfig);
      assert.deepEqual(
        catalog.models,
        fakeAgnesModels.map((id) => ({ id })),
      );
      let videoProvider: string | undefined;
      for (const [api, server] of servers) {
        const saved = await f.client.call("customProviders.upsert", {
          ...(api === "agnes" && { id: "agnes-api" }),
          name: api,
          baseUrl: server.url,
          api: "openai-completions",
          models: [],
          apiKey: fakeVideoKey(api),
          videoApi: api,
          videoModels:
            api === "agnes"
              ? catalog.models
              : api === "openai-videos"
                ? [
                    { id: "fake-video", priceUsdPerSecond: 0.25 },
                    { id: "fake-video-default", priceUsdPerClip: 2.5 },
                  ]
                : [{ id: "fake-video" }],
        });
        if (api === "openai-videos") videoProvider = saved.id;
      }
      assert(videoProvider);
      const defaultVideoModel = { provider: videoProvider, id: "fake-video-default" };
      await f.client.call("bots.update", { botId: f.researcher.id, defaultVideoModel });
      const profile = await f.client.call("bots.profile", { botId: f.researcher.id });
      assert.deepEqual(profile.bot.defaultVideoModel, defaultVideoModel);
      assert.deepEqual(
        await f.client.call("customProviders.fetchSavedModels", { providerId: "agnes-api" }),
        catalog,
      );
      const sora = { provider: "openai", id: "sora-2" } as const;
      await assert.rejects(
        f.client.call("providers.videoModels", { providerId: "openai" }),
        /video_model_unavailable/,
      );
      await f.client.call("providers.setApiKey", {
        providerId: "openai",
        apiKey: fakeVideoKey("openai-videos", true),
      });
      await f.client.call("providers.setApiKey", {
        providerId: "google",
        apiKey: fakeVideoKey("gemini-omni", true),
      });
      await f.client.call("providers.setApiKey", {
        providerId: "openrouter",
        apiKey: fakeVideoKey("openrouter-videos", true),
      });
      await f.client.call("providers.setVideoModel", {
        providerId: openRouter.provider,
        modelId: openRouter.id,
        enabled: true,
      });
      assert.deepEqual(await f.client.call("providers.videoModels", { providerId: "openai" }), {
        models: [],
        fallback: false,
        unavailable: false,
      });
      await assert.rejects(
        f.client.call("providers.setVideoModel", {
          providerId: "openai",
          modelId: sora.id,
          enabled: true,
        }),
        /video_model_unavailable/,
      );
      builtinOpenAI.listSora();
      for (const model of [sora, omni]) {
        const refreshed = await f.client.call("providers.videoModels", {
          providerId: model.provider,
          refresh: true,
        });
        assert.equal(refreshed.fallback, false);
        assert.equal(refreshed.unavailable, false);
        assert.deepEqual(
          refreshed.models.map(({ id, enabled }) => ({ id, enabled })),
          [{ id: model.id, enabled: true }],
        );
        await f.client.call("providers.setVideoModel", {
          providerId: model.provider,
          modelId: model.id,
          enabled: false,
        });
        await assert.rejects(
          f.client.call("bots.update", { botId: f.researcher.id, defaultVideoModel: model }),
          /video_model_unavailable/,
        );
      }
      const videoModels = () => f.client.call("videos.models", { offset: 0, limit: 100 });
      assert(
        !(await videoModels()).some(
          ({ provider }) => provider === "openai" || provider === "google",
        ),
      );
      for (const model of [sora, omni]) {
        await f.client.call("providers.setVideoModel", {
          providerId: model.provider,
          modelId: model.id,
          enabled: true,
        });
        assert(
          (await videoModels()).some(
            ({ provider, id }) => provider === model.provider && id === model.id,
          ),
        );
      }

      const submit = async (topicId?: string, switchModel?: "custom" | "builtin") => {
        const sent = await f.client.call("chat.send", {
          botId: f.researcher.id,
          text: "Create the scripted local test clip.",
          ...(topicId ? { topicId } : { newTopic: true }),
        });
        const read = () =>
          f.client.call("chat.history", { botId: f.researcher.id, topicId: sent.conversationId });
        const approval = (
          await until(
            "paid video card",
            () => f.client.call("approvals.pending", {}),
            (rows) => rows.some(paid),
          )
        ).find(paid);
        assert(approval);
        assert.equal(approval.canRemember, false);
        let modelOptionId: string | undefined;
        if (switchModel === "custom") {
          assert.equal(
            approval.localized?.en.facts.find((fact) => fact.labelKey === "videoModel")?.value,
            "openai-videos · fake-video-default",
          );
          assert(approval.localized?.en.facts.some((fact) => fact.value === "$2.50 / clip"));
          const option = approval.modelOptions?.find(
            (candidate) => candidate.label === "openai-videos · fake-video",
          );
          assert(option);
          assert(option.localized.en.facts.some((fact) => fact.value === "$1.25 ($0.25 / sec)"));
          modelOptionId = option.id;
          await assert.rejects(
            f.client.call("approvals.resolve", {
              id: approval.id,
              decision: "allow",
              remember: false,
              modelOptionId: "0".repeat(64),
            }),
          );
        }
        if (switchModel === "builtin") {
          const option = approval.modelOptions?.find(
            (item) => item.label === `Google · ${omni.id}`,
          );
          assert(option);
          assert(option.localized.en.facts.some((fact) => fact.value === "$0.56 ($0.07 / sec)"));
          modelOptionId = option.id;
        }
        await f.client.call("approvals.resolve", {
          id: approval.id,
          decision: "allow",
          remember: false,
          ...(modelOptionId ? { modelOptionId } : {}),
        });
        if (switchModel === "custom") {
          const audit = await f.client.call("audit.list", { limit: 200 });
          assert(
            audit.some(
              (entry) =>
                entry.kind === "approval.resolved" &&
                entry.detail?.approvalId === approval.id &&
                entry.detail?.providerId === videoProvider &&
                entry.detail?.modelId === "fake-video",
            ),
          );
        }
        const card = (
          await until("durable job card", read, (rows) => rows.some((row) => jobId(row)))
        ).find((row) => jobId(row));
        assert(card);
        const id = jobId(card);
        assert(id);
        const params = { id, messageId: card.id };
        await until("chat run is free while video polls", read, (rows) =>
          rows.some((row) => row.id === sent.assistantMessageId && row.status === "done"),
        );
        return { params, read, topicId: sent.conversationId };
      };
      const openai = servers.get("openai-videos");
      assert(openai);
      for (const [index, api] of successes.entries()) {
        const agnesText = api === "agnes" && index < families.length;
        if (api === "agnes") agnes.setHoldProgress(true);
        if (agnesText) agnes.setQueueFull(true);
        else if (api === "agnes") agnes.next("legacy");
        const job = await submit(undefined, index === 0 ? "custom" : undefined);
        const readJob = () => f.client.call("videos.get", job.params);
        if (agnesText) {
          const queued = await until("Agnes queue full", readJob, (value) => !!value.queueFull);
          assert.equal(queued.status, "queued");
          assert.equal(queued.error, undefined);
          await until(
            "Agnes retry received HTTP 200 queue-full",
            async () => agnes.queueStatuses.length,
            (count) => count >= 2,
          );
          assert.deepEqual(agnes.queueStatuses.slice(0, 2), [429, 200]);
          assert.equal(agnes.tasks.length, 0);
          agnes.setQueueFull(false);
        }
        await until(`${api} generating`, readJob, (value) =>
          api === "agnes"
            ? value.status === "generating" && value.progress === 20 && !value.queueFull
            : value.status === "generating" || value.status === "done",
        );
        if (api === "agnes") agnes.setHoldProgress(false);
        const done = await until(
          `${api} done`,
          readJob,
          (value) => value.status === "done" || value.status === "failed",
        );
        assert.equal(done.status, "done", done.error ?? `${api} did not complete`);
        assert.equal(done.workspaceSaved, true);
        const body = servers.get(api)?.bodies.at(-1);
        assert(body);
        if (api === "agnes") {
          assert.deepEqual(JSON.parse(body), {
            model: modelId(api, index),
            prompt: `Synthetic clip ${index + 1}`,
            mode: agnesText ? "text" : "keyframe",
            seconds: "5",
            size: agnesText ? "720P" : "2K",
            aspect_ratio: "3:4",
            seed: 17,
            ...(!agnesText && { first_frame: firstFrameUrl }),
          });
          if (agnesText) assert(agnes.bodies.every((attempt) => attempt === body));
        } else assert(body.includes(api === "openai-videos" ? 'name="input_reference"' : frame));
        if (api === "kling") assert(servers.get(api)?.tasks[0]?.path.includes("/image2video/"));
        const attachment = (await job.read()).find((row) => row.id === job.params.messageId)
          ?.attachments?.[0];
        assert(attachment);
        assert(attachment.name.endsWith(".mp4"));
        const preview = await f.client.call("preview.read", {
          attachmentId: attachment.id,
          messageId: job.params.messageId,
          requestId: crypto.randomUUID(),
        });
        assert.equal(preview.kind, "video");
        assert.deepEqual(Buffer.from(preview.data, "base64"), await fakeVideoClip());
        assert.deepEqual(await readFile(join(f.root, attachment.name)), await fakeVideoClip());
      }
      await f.client.call("bots.update", { botId: f.researcher.id, defaultVideoModel: sora });
      const listed = await f.client.call("chat.send", {
        botId: f.researcher.id,
        text: "List my available video models.",
        newTopic: true,
      });
      await until(
        "Bot sees both built-in models and the OpenAI default",
        async () => listedModels.replaceAll('\\"', '"'),
        (value) =>
          value.includes(
            '"providerId":"openai","providerName":"OpenAI","id":"sora-2","api":"openai-videos","default":true',
          ) &&
          value.includes(
            `"providerId":"google","providerName":"Google","id":"${omni.id}","api":"gemini-omni"`,
          ),
      );
      await until(
        "video model list completed",
        () =>
          f.client.call("chat.history", { botId: f.researcher.id, topicId: listed.conversationId }),
        (rows) => rows.some((row) => row.id === listed.assistantMessageId && row.status === "done"),
      );
      for (const switchModel of [undefined, "builtin"] as const) {
        const job = await submit(undefined, switchModel);
        const done = await until(
          "built-in video done",
          () => f.client.call("videos.get", job.params),
          (value) => value.status === "done" || value.status === "failed",
        );
        assert.equal(done.status, "done", done.error ?? "Built-in video did not complete");
      }
      assert(builtinOpenAI.bodies[0]?.includes(sora.id));
      assert.equal(builtinGoogle.tasks[0]?.polls, 2);
      assert.deepEqual(JSON.parse(builtinGoogle.bodies[0] ?? ""), {
        model: omni.id,
        input: [
          {
            type: "text",
            text: "Use the supplied image as the first frame.\nSynthetic Omni image clip",
          },
          { type: "image", mime_type: "image/png", data: frame },
        ],
        response_format: {
          type: "video",
          aspect_ratio: "9:16",
          resolution: "720p",
          duration: "8s",
          delivery: "uri",
        },
      });
      await f.client.call("bots.update", { botId: f.researcher.id, defaultVideoModel: omni });
      builtinGoogle.next("inline");
      const inline = await submit();
      const inlineDone = await until(
        "Omni inline video done",
        () => f.client.call("videos.get", inline.params),
        (value) => value.status === "done" || value.status === "failed",
      );
      assert.equal(
        inlineDone.status,
        "done",
        inlineDone.error ?? "Omni inline video did not complete",
      );
      assert.equal(builtinGoogle.tasks[1]?.polls, 0);
      assert.deepEqual(JSON.parse(builtinGoogle.bodies[1] ?? ""), {
        model: omni.id,
        input: "Synthetic Omni inline clip",
        response_format: {
          type: "video",
          aspect_ratio: "16:9",
          resolution: "4k",
          duration: "15s",
          delivery: "uri",
        },
      });
      const attachment = (await inline.read()).find((row) => row.id === inline.params.messageId)
        ?.attachments?.[0];
      assert(attachment);
      assert.deepEqual(await readFile(join(f.root, attachment.name)), await fakeVideoClip());
      for (const mode of ["cancel", "timeout"] as const) {
        builtinGoogle.next("hold");
        const index = builtinGoogle.tasks.length;
        const job = await submit();
        const task = await until(
          "Omni interaction received",
          async () => builtinGoogle.tasks[index],
          Boolean,
        );
        assert(task?.mode === "hold");
        const readJob = () => f.client.call("videos.get", job.params);
        await until("Omni POST pending", readJob, (value) => value.status === "generating");
        assert.equal(task.polls, 0);
        if (mode === "cancel") {
          assert.equal((await f.client.call("videos.cancel", job.params)).status, "cancelled");
        } else {
          const failed = await until(
            "Omni POST deadline",
            readJob,
            (value) => value.status === "failed",
          );
          assert.equal(failed.error, "timeout");
        }
        await until("Omni POST disconnected", async () => task.cancelled, Boolean);
      }
      await f.client.call("providers.setVideoModel", {
        providerId: "google",
        modelId: omni.id,
        enabled: false,
      });
      assert(!(await videoModels()).some(({ provider }) => provider === "google"));
      agnes.next("fail");
      const agnesFailure = await submit();
      const rejected = await until(
        "Agnes provider failure",
        () => f.client.call("videos.get", agnesFailure.params),
        (value) => value.status === "failed",
      );
      assert.equal(rejected.error, "provider_error");
      assert((agnes.tasks.at(-1)?.polls ?? 0) >= 4);

      agnes.setQueueFull(true);
      const agnesCreates = agnes.tasks.length;
      const agnesTimeout = await submit();
      const timedOut = await until(
        "Agnes queue-full deadline",
        () => f.client.call("videos.get", agnesTimeout.params),
        (value) => value.status === "failed",
      );
      assert.equal(timedOut.error, "timeout");
      assert.equal(timedOut.queueFull, undefined);
      assert.equal(agnes.tasks.length, agnesCreates);
      for (const mode of modes) {
        openai.next(mode === "cancel" || mode === "restart" || mode === "timeout" ? "hold" : mode);
        const job = await submit();
        const task = openai.tasks.at(-1);
        assert(task);
        if (mode === "cancel" || mode === "restart") {
          await until(
            "live generation",
            () => f.client.call("videos.get", job.params),
            (value) => value.status === "generating",
          );
        }
        if (mode === "cancel") {
          assert.equal((await f.client.call("videos.cancel", job.params)).status, "cancelled");
          assert(task.cancelled);
          assert.equal(
            (await job.read()).find((row) => row.id === job.params.messageId)?.attachments
              ?.length ?? 0,
            0,
          );
        } else if (mode === "restart") {
          const creates: number = openai.tasks.length;
          await f.restart(() => {
            task.mode = "complete";
            return Promise.resolve();
          });
          assert(
            (await videoModels()).some(
              ({ provider, id }) => provider === sora.provider && id === sora.id,
            ),
          );
          assert(!(await videoModels()).some(({ provider }) => provider === omni.provider));
          assert.equal(
            (
              await until(
                "resumed video",
                () => f.client.call("videos.get", job.params),
                (value) => value.status === "done" || value.status === "failed",
              )
            ).status,
            "done",
          );
          assert.equal(openai.tasks.length, creates, "restart must not repeat a paid create");
        } else {
          const failed = await until(
            `${mode} terminal state`,
            () => f.client.call("videos.get", job.params),
            (value) => value.status === "failed",
          );
          assert.equal(
            failed.error,
            mode === "timeout" ? "timeout" : mode === "oversize" ? "size_limit" : "provider_error",
          );
        }
      }
      for (const [index] of framePlaceholders.entries()) {
        if (index > 0) builtinOpenRouter.next("signed");
        const job = await submit();
        const done = await until(
          "OpenRouter terminal state",
          () => f.client.call("videos.get", job.params),
          (value) => value.status === "done" || value.status === "failed",
        );
        assert.equal(done.status, "done", done.error ?? "OpenRouter did not complete");
        assert.deepEqual(JSON.parse(builtinOpenRouter.bodies[index] ?? ""), {
          model: openRouter.id,
          prompt: "Synthetic OpenRouter clip",
          duration: 4,
          aspect_ratio: "16:9",
          resolution: "480p",
        });
        const attachment = (await job.read()).find((row) => row.id === job.params.messageId)
          ?.attachments?.[0];
        assert(attachment);
        assert.deepEqual(await readFile(join(f.root, attachment.name)), await fakeVideoClip());
      }
      const mov = await f.client.call("chat.send", {
        botId: f.researcher.id,
        text: "Write and deliver result.mov",
        newTopic: true,
      });
      await until(
        "automatic .mov delivery",
        () =>
          f.client.call("chat.history", {
            botId: f.researcher.id,
            topicId: mov.conversationId,
          }),
        (rows) =>
          rows.some((message) =>
            message.attachments?.some((attachment) => attachment.name === "result.mov"),
          ),
      );
      assert.equal(cdn.reads(), successes.length + 2);
      assert.equal(cdn.leaked(), 0);
      builtinOpenAI.listSora(false);
      assert.deepEqual(
        await f.client.call("providers.videoModels", { providerId: "openai", refresh: true }),
        { models: [], fallback: false, unavailable: false },
      );
      assert(!(await videoModels()).some(({ provider }) => provider === sora.provider));
      assert(events.length >= families.length * 3);
      const audit = await f.client.call("audit.list", { limit: 200 });
      assert(
        audit.some(
          (entry) =>
            entry.kind === "provider.video_model_changed" &&
            entry.detail.providerId === "openai" &&
            entry.detail.modelId === sora.id,
        ),
      );
      assert(
        audit.some(
          (entry) =>
            entry.kind === "video.finished" &&
            entry.detail.video?.status === "done" &&
            entry.detail.video.estimateUsd === 1.25,
        ),
      );
      for (const api of families) assert(!JSON.stringify(audit).includes(fakeVideoKey(api)));
      for (const api of ["openai-videos", "gemini-omni", "openrouter-videos"] as const)
        assert(!JSON.stringify(audit).includes(fakeVideoKey(api, true)));
      assert.equal(f.blocked(), 0);
      return {
        scenario:
          "Video providers, progress, playback bytes, cancel, failure, timeout, cap, restart and .mov",
        status: "脚本化通过",
        requests: f.counts(),
        nonFixtureNetworkAttempts: f.blocked(),
        window: "未验证",
      };
    } finally {
      off();
      await f.cleanup();
    }
  } finally {
    await Promise.all([
      cdn.stop(),
      ...[...servers.values(), ...builtinServers].map((server) => server.stop()),
    ]);
  }
}
