import type { ImageApi, ImageUnitPrice } from "@pibot/protocol-base";

export function imagePrice(
  api: ImageApi,
  model: string,
  base: string,
  edit = false,
): ImageUnitPrice | undefined {
  const { hostname, protocol, port } = new URL(base);
  if (protocol !== "https:" || port) return;
  // Catalog rates apply only to known models at official endpoints.
  // https://docs.volcengine.com/docs/ark/model-pricing
  if (api === "seedream-images" && hostname === "ark.cn-beijing.volces.com") {
    if (model === "doubao-seedream-4-5-251128") return { currency: "CNY", perImage: 0.25 };
    if (model === "doubao-seedream-5-0-flash-260915") return { currency: "CNY", perImage: 0.12 };
    if (/^doubao-seedream-4-0-(?:250828|260415|20260415)$/.test(model))
      return { currency: "CNY", perImage: 0.2 };
  }
  // https://www.alibabacloud.com/help/en/model-studio/model-pricing
  if (api === "dashscope-images") {
    const china =
      hostname === "dashscope.aliyuncs.com" || hostname.endsWith(".cn-beijing.maas.aliyuncs.com");
    const singapore =
      hostname === "dashscope-intl.aliyuncs.com" ||
      hostname.endsWith(".ap-southeast-1.maas.aliyuncs.com");
    if (china || singapore) {
      if (model === "qwen-image-2.1-turbo")
        return { currency: "USD", perImage: china ? 0.014133 : 0.016 };
      if (model === "qwen-image-2.1-pro")
        return { currency: "USD", perImage: china ? 0.035333 : 0.04 };
      if (china && model === "wanx2.1-t2i-turbo") return { currency: "USD", perImage: 0.02007 };
      if (singapore && model === "wan2.1-t2i-turbo") return { currency: "USD", perImage: 0.025 };
      if (china && model === "wanx2.1-imageedit") return { currency: "USD", perImage: 0.02007 };
    }
  }
  // The adapter pins 1K low for generation and 1K medium for editing.
  // https://docs.x.ai/developers/models/grok-imagine-image-2.0
  if (api === "xai-images" && hostname === "api.x.ai" && model === "grok-imagine-image-2.0")
    return edit
      ? { currency: "USD", perImage: 0.06, perReference: 0.01 }
      : { currency: "USD", perImage: 0.04 };
}
