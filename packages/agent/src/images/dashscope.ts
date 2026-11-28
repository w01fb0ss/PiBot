import { type ImageContent, MAX_ATTACHMENTS } from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import { imagePrice } from "./image-pricing.ts";
import {
  dataUrl,
  type ImageTransport,
  imageLink,
  responseValue,
  taskId,
  withImageCost,
} from "./provider-transport.ts";

export function dashscopeModel(model: string) {
  if (/^wanx.*-imageedit$/.test(model)) return "wanx-edit";
  if (/^wan2\.[0-5]-i2i/.test(model)) return "unsupported";
  if (/^(?:wanx|wan2\.[0-5])/.test(model)) return "wan-legacy";
  if (/^qwen-image-(?:edit|plus|max)(?:-|$)/.test(model) || model === "qwen-image")
    return "sync-only";
  return "messages";
}

const task = z.object({ output: z.object({ task_id: taskId }) });
const taskResult = z.object({
  output: z.object({
    task_status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]),
    results: z
      .array(z.object({ url: imageLink.optional() }))
      .max(MAX_ATTACHMENTS)
      .optional(),
    choices: z
      .array(
        z.object({
          message: z.object({
            content: z.array(z.object({ image: imageLink.optional() })).max(32),
          }),
        }),
      )
      .max(MAX_ATTACHMENTS)
      .optional(),
  }),
});

export async function dashscopeImages(
  transport: ImageTransport,
  model: string,
  prompt: string,
  images: ImageContent[],
) {
  const family = dashscopeModel(model);
  const references = images.map(dataUrl);
  let path = "image-generation/generation";
  let input: unknown;
  if (family === "wanx-edit") {
    // https://www.alibabacloud.com/help/en/model-studio/wanx-image-edit-api-reference
    if (references.length !== 1) throw new AgentError("image_mode_mismatch");
    path = "image2image/image-synthesis";
    input = { function: "description_edit", prompt, base_image_url: references[0] };
  } else if (family === "wan-legacy") {
    // https://www.alibabacloud.com/help/en/model-studio/text-to-image-v2-api-reference
    if (references.length) throw new AgentError("image_mode_mismatch");
    path = "text2image/image-synthesis";
    input = { prompt };
  } else {
    // https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference
    if (
      family === "sync-only" ||
      family === "unsupported" ||
      (/-t2i(?:-|$)/.test(model) && references.length) ||
      (/^qwen-image-3\.0(?:-|$)/.test(model) && references.length > 3)
    )
      throw new AgentError("image_mode_mismatch");
    input = {
      messages: [
        { role: "user", content: [...references.map((image) => ({ image })), { text: prompt }] },
      ],
    };
  }
  const submitted = responseValue(
    task,
    await transport.json(
      `services/aigc/${path}`,
      JSON.stringify({ model, input, parameters: { n: 1 } }),
      { "X-DashScope-Async": "enable" },
      256 * 1024,
    ),
  );
  const pollPath = `tasks/${submitted.output.task_id}`;
  const links = await transport.poll(async () => {
    const { output } = responseValue(
      taskResult,
      await transport.json(pollPath, undefined, undefined, 256 * 1024),
    );
    if (output.task_status === "PENDING" || output.task_status === "RUNNING") return;
    if (output.task_status !== "SUCCEEDED") throw new AgentError("provider_error");
    const urls = output.results
      ? output.results.flatMap((entry) => (entry.url ? [entry.url] : []))
      : (output.choices ?? []).flatMap((choice) =>
          choice.message.content.flatMap((entry) => (entry.image ? [entry.image] : [])),
        );
    if (urls.length > MAX_ATTACHMENTS) throw new AgentError("provider_error");
    return urls;
  }, 2000);
  const result = await transport.links(links);
  const price = imagePrice("dashscope-images", model, transport.base);
  return withImageCost(result, price && price.perImage * result.images.length);
}
