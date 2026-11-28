import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  createAgentRuntime,
  type CustomProviderConfig,
} from "../../../packages/agent/src/index.ts";
import { installAgentNetwork } from "../../../packages/agent/src/network/network.ts";
import { fetchImage } from "../../../packages/execution/src/index.ts";
import type { ImageContent } from "../../../packages/protocol-base/src/index.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAX+uc8AAAAASUVORK5CYII=";
const image: ImageContent = { type: "image", mimeType: "image/png", data: PNG };
const KEY = "synthetic-provider-norms-secret";
const dataUrl = `data:image/png;base64,${PNG}`;
const prompt = 'Image prompt with "quotes" and {{seed}}';
const json = (res: ServerResponse, value: unknown) =>
  res.setHeader("Content-Type", "application/json").end(JSON.stringify(value));

async function read(req: IncomingMessage) {
  const bytes: Buffer[] = [];
  for await (const chunk of req) bytes.push(Buffer.from(chunk));
  return Buffer.concat(bytes).toString();
}

async function fakeServer(
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void,
) {
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res, new URL(req.url ?? "/", "http://fake.invalid")))
      .catch((error) => {
        errors.push(error);
        res.writeHead(400).end();
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    errors,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Vendor-shaped fake servers backed by the real agent catalog and image dispatch. */
export async function runImageProvidersProbe(root: string) {
  let cdnHits = 0;
  let crossOriginRequests = 0;
  let dashPolls = 0;
  let pendingPolls = 0;
  let releasePending: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let comfyPolls = 0;
  let queued = 0;
  const cdn = await fakeServer((req, res, url) => {
    assert.equal(url.pathname, "/signed-image");
    assert.equal(url.searchParams.get("sig"), "local-probe");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-provider-custom"], undefined);
    cdnHits++;
    res.setHeader("Content-Type", "image/png").end(Buffer.from(PNG, "base64"));
  });
  const service = await fakeServer(async (req, res, url) => {
    if (url.pathname.startsWith("/comfy/")) {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers["x-provider-custom"], undefined);
      if (url.pathname.endsWith("/upload/image")) {
        assert.match(req.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
        const packet = await read(req);
        assert.match(packet, /name="image"; filename="pibot-[\w-]+\.png"/);
        assert.match(packet, /name="type"\r\n\r\ninput/);
        json(res, { name: "uploaded.png", type: "input", subfolder: "references" });
      } else if (url.pathname.endsWith("/prompt")) {
        const { prompt: graph } = JSON.parse(await read(req));
        assert.equal(graph["1"].inputs.text, `prefix ${prompt}`);
        assert.equal(graph["1"].inputs.width, 768);
        assert.equal(graph["1"].inputs.height, 1024);
        assert.equal(typeof graph["1"].inputs.seed, "number");
        if (++queued === 2) assert.equal(graph["2"].inputs.image, "references/uploaded.png");
        json(res, { prompt_id: `prompt-${queued}`, number: queued, node_errors: {} });
      } else if (url.pathname.includes("/history/")) {
        const id = url.pathname.split("/").at(-1);
        assert(id);
        json(
          res,
          ++comfyPolls % 2
            ? {}
            : {
                [id]: {
                  status: { status_str: "success", completed: true },
                  outputs: {
                    "3": {
                      images: [
                        { filename: "result.png", subfolder: "batch one\\nested", type: "output" },
                      ],
                    },
                  },
                },
              },
        );
      } else {
        assert.equal(url.pathname, "/comfy/view");
        assert.equal(url.searchParams.get("filename"), "result.png");
        assert.equal(url.searchParams.get("subfolder"), "batch one/nested");
        assert.equal(url.searchParams.get("type"), "output");
        res.end(Buffer.from(PNG, "base64"));
      }
      return;
    }

    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["x-provider-custom"], "synthetic");
    if (url.pathname === "/ark/api/v3/images/generations") {
      const body = JSON.parse(await read(req));
      assert.equal(body.model, "doubao-seedream-5-0-flash-260915");
      assert.equal(body.response_format, "b64_json");
      assert.equal(body.size, "2K");
      assert.equal(body.sequential_image_generation, undefined);
      assert.match(body.prompt, /16:9/);
      if (body.image) assert.deepEqual(body.image, [dataUrl, dataUrl]);
      json(res, { data: [{ b64_json: PNG, size: "2848x1600" }] });
    } else if (url.pathname.startsWith("/dash/api/v1/services/aigc/")) {
      assert.equal(req.headers["x-dashscope-async"], "enable");
      const body = JSON.parse(await read(req));
      let id: string;
      if (body.model === "qwen-image-2.1-turbo" || body.model === "qwen-image-2.1-turbo-pending") {
        assert.match(url.pathname, /\/image-generation\/generation$/);
        const content = body.input.messages[0].content;
        assert.deepEqual(
          content,
          content.length === 1 ? [{ text: prompt }] : [{ image: dataUrl }, { text: prompt }],
        );
        id = "qwen";
      } else if (body.model === "wanx2.1-imageedit") {
        assert.match(url.pathname, /\/image2image\/image-synthesis$/);
        assert.deepEqual(body.input, {
          function: "description_edit",
          prompt,
          base_image_url: dataUrl,
        });
        id = "wanx-edit";
      } else {
        assert.equal(body.model, "wanx2.1-t2i-turbo");
        assert.match(url.pathname, /\/text2image\/image-synthesis$/);
        assert.deepEqual(body.input, { prompt });
        id = "wanx-text";
      }
      json(res, {
        output: {
          task_id: body.model === "qwen-image-2.1-turbo-pending" ? "pending" : id,
          task_status: "PENDING",
        },
      });
    } else if (url.pathname.startsWith("/dash/api/v1/tasks/")) {
      assert.equal(req.headers["x-dashscope-async"], undefined);
      const id = url.pathname.split("/").at(-1);
      if (id === "pending") {
        pendingPolls++;
        json(res, { output: { task_id: id, task_status: "RUNNING" } });
        releasePending();
        return;
      }
      if (++dashPolls % 2) {
        json(res, { output: { task_id: id, task_status: "RUNNING" } });
        return;
      }
      const link = `https://cdn.example.test/signed-image?sig=local-probe`;
      json(res, {
        output: {
          task_id: id,
          task_status: "SUCCEEDED",
          ...(id === "qwen"
            ? { choices: [{ message: { content: [{ image: link }], role: "assistant" } }] }
            : { results: [{ url: link }] }),
        },
        usage: { image_count: 1 },
      });
    } else if (url.pathname.startsWith("/grok/v1/images/")) {
      const body = JSON.parse(await read(req));
      assert.equal(body.prompt, prompt);
      if (body.model === "unsafe-generation") {
        res.writeHead(307, { Location: `${cdn.url}/signed-image?sig=local-probe` }).end();
        return;
      }
      if (url.pathname.endsWith("/edits"))
        assert.deepEqual(body.images, Array(2).fill({ url: dataUrl, type: "image_url" }));
      const result = `${service.url}/grok/${body.model === "oversize-generation" ? "oversize" : "result"}`;
      json(res, {
        data: [{ b64_json: null, url: result, mime_type: "image/png" }],
        usage: { cost_in_usd_ticks: 400_000_000 },
      });
    } else if (url.pathname === "/grok/result") {
      res
        .writeHead(302, { Location: "https://cdn.example.test/signed-image?sig=local-probe" })
        .end();
    } else if (url.pathname === "/grok/oversize") {
      res.writeHead(200, { "Content-Length": 11 * 1024 * 1024 }).end();
    } else {
      assert.fail("Unexpected fake provider route");
    }
  });

  const comfyGraph = {
    "1": {
      class_type: "ProbeDimensions",
      inputs: {
        text: "prefix {{prompt}}",
        seed: "{{seed}}",
        width: "{{width}}",
        height: "{{height}}",
      },
    },
  };
  const both = ["text-to-image", "image-to-image"] as const;
  const cfg = (
    id: string,
    imageApi: CustomProviderConfig["imageApi"],
    basePath: string,
    imageModels: CustomProviderConfig["imageModels"],
  ): CustomProviderConfig => ({
    id,
    name: id,
    api: "openai-completions",
    baseUrl: service.url + basePath,
    models: [],
    imageApi,
    imageModels,
    headers: { "X-Provider-Custom": "synthetic" },
  });
  const providers = [
    cfg("ark", "seedream-images", "/ark", [
      { id: "doubao-seedream-5-0-flash-260915", modes: [...both], aspectRatio: "16:9" },
    ]),
    cfg("dashscope", "dashscope-images", "/dash", [
      { id: "qwen-image-2.1-turbo", modes: [...both] },
      { id: "qwen-image-2.1-turbo-pending", modes: ["text-to-image"] },
      { id: "wanx2.1-t2i-turbo", modes: ["text-to-image"] },
      { id: "wanx2.1-imageedit", modes: ["image-to-image"] },
    ]),
    cfg("grok", "xai-images", "/grok/v1", [
      { id: "grok-imagine-image-2.0", modes: [...both] },
      { id: "unsafe-generation", modes: ["text-to-image"] },
      { id: "oversize-generation", modes: ["text-to-image"] },
    ]),
    cfg("workflows", "comfyui-images", "/comfy", [
      {
        id: "text",
        modes: ["text-to-image"],
        size: "768x1024",
        workflow: JSON.stringify(comfyGraph),
      },
      {
        id: "edit",
        modes: ["image-to-image"],
        size: "768x1024",
        workflow: JSON.stringify({
          ...comfyGraph,
          "2": { class_type: "LoadImage", inputs: { image: "{{image}}" } },
        }),
      },
    ]),
  ];
  const realFetch = globalThis.fetch;
  const network = installAgentNetwork(realFetch, () => false);
  const agent = createAgentRuntime({
    dataDir: join(root, "provider-fakes"),
    network,
    // Simulate the credential-free public port on a random test port without external DNS.
    fetchImageUrl: async ({ url, signal }) => {
      assert.equal(new URL(url).origin, "https://cdn.example.test");
      crossOriginRequests++;
      const response = await realFetch(cdn.url + new URL(url).pathname + new URL(url).search, {
        signal,
        redirect: "manual",
        credentials: "omit",
      });
      assert(response.ok);
      return { data: new Uint8Array(await response.arrayBuffer()) };
    },
    hasApiKey: (id) => id !== "workflows",
    getApiKey: async (id) => (id === "workflows" ? undefined : KEY),
    customProviders: () => providers,
  });
  const generate = (
    provider: string,
    id: string,
    images: ImageContent[] = [],
    signal = AbortSignal.timeout(15_000),
  ) =>
    agent.generateImage!({
      model: { provider, id },
      recipient: "127.0.0.1",
      origin: service.url,
      mode: images.length ? "image-to-image" : "text-to-image",
      images,
      prompt,
      signal,
    });
  try {
    const refused = /private_address|unsupported_url/;
    await assert.rejects(
      fetchImage({
        url: "https://127.0.0.1/image.png",
        signal: AbortSignal.timeout(2000),
        allowDomain: () => true,
      }),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "reason" in error &&
        refused.test(String(error.reason)),
    );
    const models = await agent.listImageModels!({ availableOnly: true });
    assert(models.some((model) => model.provider === "workflows" && model.id === "text"));
    assert.deepEqual(models.find((model) => model.id === "wanx2.1-imageedit")?.modes, [
      "image-to-image",
    ]);
    assert.equal(models.find((model) => model.id === "grok-imagine-image-2.0")?.maxReferences, 5);
    for (const [provider, model, references] of [
      ["ark", "doubao-seedream-5-0-flash-260915", []],
      ["ark", "doubao-seedream-5-0-flash-260915", [image, image]],
      ["dashscope", "qwen-image-2.1-turbo", []],
      ["dashscope", "qwen-image-2.1-turbo", [image]],
      ["dashscope", "wanx2.1-t2i-turbo", []],
      ["dashscope", "wanx2.1-imageedit", [image]],
      ["grok", "grok-imagine-image-2.0", []],
      ["grok", "grok-imagine-image-2.0", [image, image]],
      ["workflows", "text", []],
      ["workflows", "edit", [image]],
    ] as const) {
      const result = await generate(provider, model, [...references]);
      assert.deepEqual(result.images, [image]);
      if (provider === "grok")
        assert.equal((result.usage as { cost: { total: number } }).cost.total, 0.04);
    }
    await assert.rejects(generate("grok", "unsafe-generation", [image]), {
      code: "image_mode_mismatch",
    });
    await assert.rejects(generate("grok", "unsafe-generation"), { code: "provider_error" });
    await assert.rejects(generate("grok", "oversize-generation"), {
      code: "image_url_unavailable",
    });
    const cancel = new AbortController();
    const cancelled = assert.rejects(
      generate(
        "dashscope",
        "qwen-image-2.1-turbo-pending",
        [],
        AbortSignal.any([cancel.signal, AbortSignal.timeout(15_000)]),
      ),
      { code: "aborted" },
    );
    await Promise.race([
      pending,
      cancelled.then(() => assert.fail("DashScope did not start polling")),
    ]);
    cancel.abort();
    await cancelled;
    assert.equal(pendingPolls, 1);
    assert.equal(dashPolls, 8);
    assert.equal(comfyPolls, 4);
    assert.equal(cdnHits, 6);
    assert.equal(crossOriginRequests, cdnHits);
    assert.deepEqual([...service.errors, ...cdn.errors], []);
    return {
      generated: 10,
      taskPolls: dashPolls + comfyPolls,
      credentialFreeDownloads: cdnHits,
      blockedSubmitRedirect: true,
      blockedOversizeResult: true,
      abortedPolling: true,
    };
  } finally {
    network.dispose();
    await Promise.all([service.close(), cdn.close()]);
  }
}
