import { randomInt, randomUUID } from "node:crypto";
import {
  type CustomImageModel,
  comfyUsesImage,
  type ImageContent,
  MAX_ATTACHMENTS,
  parseComfyWorkflow,
} from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import { checkedImage } from "./image-response.ts";
import { type ImageTransport, responseValue, taskId } from "./provider-transport.ts";

const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/[\\/:]/.test(value) &&
      !value.includes("\0") &&
      value !== "." &&
      value !== ".." &&
      !/\[(?:input|output|temp)\]$/.test(value),
  );
const subfolder = z
  .string()
  .max(1000)
  .transform((value) => value.replaceAll("\\", "/"))
  .refine(
    (value) => !value || value.split("/").every((segment) => filename.safeParse(segment).success),
  );
const upload = z.object({ name: filename, subfolder, type: z.literal("input") });
const queued = z.object({ prompt_id: taskId });
const outputFile = z.object({ filename, subfolder, type: z.enum(["output", "temp"]) });
const history = z.record(
  z.string(),
  z.object({
    status: z.object({ status_str: z.enum(["success", "error"]), completed: z.boolean() }),
    outputs: z.record(
      z.string(),
      z.object({ images: z.array(outputFile).max(MAX_ATTACHMENTS).optional() }),
    ),
  }),
);
const CONTROL_LIMIT = 1024 * 1024;

type Json = z.infer<ReturnType<typeof z.json>>;
function fill(value: Json, values: Record<string, string | number>): Json {
  if (typeof value === "string") {
    const exact = /^\{\{(prompt|seed|width|height|image)\}\}$/.exec(value)?.[1];
    if (exact) return values[exact] ?? "";
    return value.replace(/\{\{(prompt|seed|width|height|image)\}\}/g, (_, key: string) =>
      String(values[key] ?? ""),
    );
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fill(item, values)]),
    );
  return value;
}

async function uploadReference(transport: ImageTransport, image: ImageContent) {
  const input = checkedImage(image.data, image.mimeType);
  const extension = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType.split("/")[1];
  const form = new FormData();
  form.set("type", "input");
  form.set(
    "image",
    new Blob([Uint8Array.from(Buffer.from(input.data, "base64"))], { type: input.mimeType }),
    `pibot-${randomUUID()}.${extension}`,
  );
  const file = responseValue(
    upload,
    await transport.json("upload/image", form, undefined, CONTROL_LIMIT),
  );
  return file.subfolder ? `${file.subfolder}/${file.name}` : file.name;
}

export async function comfyImages(
  transport: ImageTransport,
  prompt: string,
  images: ImageContent[],
  settings?: CustomImageModel,
) {
  // https://docs.comfy.org/development/comfyui-server/comms_routes
  // The server queues the API-format graph as "prompt"; history is keyed by prompt ID.
  // https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py
  const graph = settings?.workflow && parseComfyWorkflow(settings.workflow);
  if (!graph) throw new AgentError("provider_error");
  if (images.length !== (comfyUsesImage(graph) ? 1 : 0))
    throw new AgentError("image_mode_mismatch");
  const [width = 1024, height = 1024] = settings?.size?.split("x").map(Number) ?? [];
  const values = {
    prompt,
    width,
    height,
    seed: randomInt(2 ** 32),
    image: images[0] ? await uploadReference(transport, images[0]) : "",
  };
  const workflow = Object.fromEntries(
    Object.entries(graph).map(([id, node]) => [id, { ...node, inputs: fill(node.inputs, values) }]),
  );
  const { prompt_id } = responseValue(
    queued,
    await transport.json("prompt", JSON.stringify({ prompt: workflow }), undefined, CONTROL_LIMIT),
  );
  const files = await transport.poll(async () => {
    const result = responseValue(
      history,
      await transport.json(`history/${prompt_id}`, undefined, undefined, CONTROL_LIMIT),
    )[prompt_id];
    if (!result) return;
    if (result.status.status_str === "error") throw new AgentError("provider_error");
    if (!result.status.completed) return;
    const files = Object.values(result.outputs).flatMap((node) => node.images ?? []);
    const saved = files.filter((file) => file.type === "output");
    const selected = saved.length ? saved : files;
    if (selected.length > MAX_ATTACHMENTS) throw new AgentError("provider_error");
    return selected;
  }, 1000);
  return transport.links(
    files.map((file) => `${transport.base}/view?${new URLSearchParams(file)}`),
  );
}
