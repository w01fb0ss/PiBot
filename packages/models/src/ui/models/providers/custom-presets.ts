import type { CustomImageModel, CustomProvider, ImageApi } from "@pibot/models-contract/full";

export type ImageProviderLabel = `media.provider.${"seedream" | "dashscope" | "xai" | "comfyui"}`;

export const customPresets: Record<
  string,
  {
    name: string;
    urls: Record<string, string>;
    videoApi?: CustomProvider["videoApi"];
    imageApi?: ImageApi;
    imageModels?: CustomImageModel[];
    regionalImageModels?: Record<string, CustomImageModel[]>;
    label?: ImageProviderLabel;
  }
> = {
  ollama: { name: "Ollama", urls: { local: "http://127.0.0.1:11434/v1" } },
  lmstudio: { name: "LM Studio", urls: { local: "http://127.0.0.1:1234/v1" } },
  vllm: { name: "vLLM", urls: { local: "http://127.0.0.1:8000/v1" } },
  "zai-api": {
    name: "Z.ai API",
    urls: { global: "https://api.z.ai/api/paas/v4", china: "https://open.bigmodel.cn/api/paas/v4" },
  },
  "qwen-api": {
    name: "Qwen API",
    urls: {
      global: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      china: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  },
  "agnes-api": {
    name: "Agnes",
    urls: { global: "https://apihub.agnes-ai.com" },
    videoApi: "agnes",
  },
  "ark-seedream-api": {
    name: "Volcengine Ark Seedream",
    label: "media.provider.seedream",
    urls: { china: "https://ark.cn-beijing.volces.com/api/v3" },
    imageApi: "seedream-images",
    imageModels: [
      {
        id: "doubao-seedream-5-0-flash-260915",
        name: "Seedream 5.0 Flash",
        modes: ["text-to-image", "image-to-image"],
      },
    ],
  },
  "dashscope-images-api": {
    name: "Alibaba Cloud DashScope Images",
    label: "media.provider.dashscope",
    urls: {
      china: "https://dashscope.aliyuncs.com",
      global: "https://dashscope-intl.aliyuncs.com",
    },
    imageApi: "dashscope-images",
    imageModels: [
      {
        id: "qwen-image-2.1-turbo",
        name: "Qwen Image 2.1 Turbo",
        modes: ["text-to-image", "image-to-image"],
      },
    ],
    regionalImageModels: {
      china: [
        { id: "wanx2.1-t2i-turbo", name: "Wanx 2.1 Turbo", modes: ["text-to-image"] },
        { id: "wanx2.1-imageedit", name: "Wanx 2.1 Image Edit", modes: ["image-to-image"] },
      ],
      global: [{ id: "wan2.1-t2i-turbo", name: "Wan 2.1 Turbo", modes: ["text-to-image"] }],
    },
  },
  "xai-imagine-api": {
    name: "xAI Grok Imagine",
    label: "media.provider.xai",
    urls: { global: "https://api.x.ai/v1" },
    imageApi: "xai-images",
    imageModels: [
      {
        id: "grok-imagine-image-2.0",
        name: "Grok Imagine Image 2.0",
        modes: ["text-to-image", "image-to-image"],
      },
    ],
  },
  comfyui: {
    name: "ComfyUI",
    label: "media.provider.comfyui",
    urls: { local: "http://127.0.0.1:8188" },
    imageApi: "comfyui-images",
  },
};

export function presetImageModels(id: string, baseUrl: string): CustomImageModel[] {
  const preset = customPresets[id];
  if (!preset?.imageModels) return [];
  const region = Object.keys(preset.urls).find((key) => preset.urls[key] === baseUrl);
  return [...preset.imageModels, ...(region ? (preset.regionalImageModels?.[region] ?? []) : [])];
}
