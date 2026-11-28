import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ImageGenerationRequest } from "@pibot/agent";
import {
  type ImageGenerationOptions,
  type ImageModelInfo,
  imageGenerationResultCounts,
} from "@pibot/images-contract/full";
import { expect, test, vi } from "vitest";
import { imageCostCard } from "../src/brain/artifacts/image-cost-card.ts";
import { generateImageRequests } from "../src/brain/run/image-requests.ts";

vi.mock("@pibot/brain/kit", () => ({
  AttachmentService: class {
    async prepareOutput(_bot: string, outputs: { name: string }[]) {
      return {
        items: outputs.map(({ name }) => ({ metadata: { id: randomUUID(), name } })),
        discard: async () => {},
      };
    }
  },
  auditText: (text: string) => text,
  checkedImage: (data: string) => Buffer.from(data, "base64"),
}));

const model: ImageModelInfo = {
  provider: "image-service",
  id: "model",
  name: "Model",
  modes: ["text-to-image", "image-to-image"],
  output: ["image"],
  configured: true,
  source: "custom",
  recipient: "example.test",
  origin: "http://example.test:8188",
  size: "768x1024",
};
const workflow: ImageModelInfo = { ...model, id: "workflow", workflowOutput: true };
const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;

function run(
  models: ImageModelInfo[],
  options: ImageGenerationOptions,
  generateImage: (request: ImageGenerationRequest) => Promise<{ images: (typeof image)[] }>,
) {
  type Input = Parameters<typeof generateImageRequests>[0];
  const signal = new AbortController().signal;
  const assertCurrent = vi.fn();
  const observer = { beforeRequest() {}, settled() {} };
  return generateImageRequests({
    deps: {
      agent: { generateImage },
      logger: { info() {} },
      redactor: { redact: (value: string) => value },
    } as unknown as Input["deps"],
    local: {
      approvals: { audit: { append() {} } },
      budgets: { observer: () => observer },
      deps: { host: {} },
      shutdown: { signal },
    } as unknown as Input["local"],
    context: { signal, language: "en" } as Input["context"],
    authorization: { assertCurrent } as unknown as Input["authorization"],
    mode: "text-to-image",
    images: [],
    text: "",
    options,
    models,
    assertReferences() {},
    stopCode: () => "provider_error",
  });
}

test("a ten-request workflow batch retains every output and marks failed requests", async () => {
  let active = 0;
  let peak = 0;
  let issued = 0;
  const options = { kind: "batch", prompt: "Batch", count: 10 } as const;
  const result = await run([workflow], options, async ({ origin, assertCurrent }) => {
    expect(origin).toBe(workflow.origin);
    assertCurrent?.();
    const index = issued++;
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    if (index === 4) throw new Error("Fake provider failure");
    return { images: Array(5).fill(image) };
  });
  expect(issued).toBe(10);
  expect(peak).toBe(2);
  expect(result.prepared.items).toHaveLength(45);
  expect(new Set(result.prepared.items.map(({ metadata }) => metadata.name)).size).toBe(45);
  expect(result.results?.items[4]).toMatchObject({
    status: "failed",
    reasonCode: "provider_error",
  });
  assert(result.results);
  expect(imageGenerationResultCounts(result.results)).toEqual({
    images: 45,
    success: 9,
    total: 10,
  });

  const facts = imageCostCard(options, 10, [workflow], "text-to-image", 0)("zh").facts;
  expect(facts).toContainEqual({
    kind: "warning",
    label: "工作流运行次数（图片数量由工作流决定）",
    value: "10",
  });
  expect(facts.at(-1)?.value).toBe("费用未知");
});

test("compare uses each model's endpoint and dimension policy and estimates edit charges", async () => {
  const edit = {
    ...model,
    origin: "https://example.test:8443",
    aspectRatio: "4:3",
    generationPrice: { currency: "USD", perImage: 1 },
    editPrice: { currency: "USD", perImage: 0.06, perReference: 0.01 },
  } as const;
  const options: ImageGenerationOptions = {
    kind: "compare",
    prompt: "Compare",
    size: "1024x1024",
    ratio: "1:1",
    models: [edit, workflow].map(({ provider, id }) => ({ provider, id })),
  };
  const models = [edit, workflow];
  const generate = vi.fn(async ({ model: selected }: ImageGenerationRequest) => ({
    images: selected.id === workflow.id ? [image, image] : [image],
  }));
  const result = await run(models, options, generate);
  assert(result.results);
  expect(result.results.items).toHaveLength(2);
  expect(imageGenerationResultCounts(result.results)).toEqual({ images: 3, success: 2, total: 2 });
  expect(generate.mock.calls.map(([request]) => request.origin)).toEqual(
    models.map(({ origin }) => origin),
  );
  for (const [request] of generate.mock.calls) {
    expect(request.prompt).not.toContain("Requested image size");
    expect(request.prompt).not.toContain("Requested aspect ratio");
  }
  const facts = imageCostCard(options, 2, models, "image-to-image", 2)("en").facts;
  expect(facts[0]?.value).toContain("USD\u00a00.08");
  expect(facts.at(-1)?.value).toBe("Cost unknown");
});
