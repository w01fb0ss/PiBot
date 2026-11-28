import { setTimeout as delay } from "node:timers/promises";
import type { Usage } from "@earendil-works/pi-ai";
import type { ImageContent } from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";
import { imageJson, imageUsage, standardImages } from "./image-response.ts";
import { type ImageUrlContext, imageFromUrl } from "./image-url.ts";

export type ProviderImageResult = { images: ImageContent[]; text: string; usage?: Usage };
export const imageLink = z.string().min(1).max(8192);
export const taskId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);

export function responseValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentError("provider_error");
  return parsed.data;
}

export function dataUrl(image: ImageContent) {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function withImageCost(result: ProviderImageResult, cost: number | undefined) {
  if (cost === undefined) return result;
  const usage = result.usage;
  return {
    ...result,
    usage: usage ? { ...usage, cost: { ...usage.cost, total: cost } } : imageUsage({ cost }),
  };
}

export class ImageTransport {
  private readonly context: ImageUrlContext;

  constructor(
    readonly base: string,
    readonly signal: AbortSignal,
    fetch: typeof globalThis.fetch,
    headers: Headers,
    fetchPublic?: ImageUrlContext["fetchPublic"],
    private readonly localWorkflow = false,
  ) {
    this.context = {
      providerOrigin: new URL(base).origin,
      providerFetch: fetch,
      providerHeaders: headers,
      fetchPublic,
      signal,
      manualRedirects: localWorkflow ? 0 : 5,
    };
  }

  async json(
    path: string,
    body?: string | FormData,
    extra?: Record<string, string>,
    limit?: number,
  ) {
    const url = new URL(`${this.base}/${path}`);
    if (url.origin !== this.context.providerOrigin) throw new AgentError("provider_error");
    const headers = new Headers(this.context.providerHeaders);
    headers.delete("Content-Type");
    if (typeof body === "string") headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    const response = await this.context.providerFetch(url, {
      method: body === undefined ? "GET" : "POST",
      body,
      signal: this.signal,
      headers,
      credentials: "omit",
      redirect: "manual",
    });
    return imageJson(response, this.signal, limit);
  }

  download = (url: string) => {
    if (this.localWorkflow && new URL(url).origin !== this.context.providerOrigin)
      throw new AgentError("provider_error");
    return imageFromUrl(url, this.context);
  };

  standard(value: unknown) {
    return standardImages(value, this.download);
  }

  async links(links: string[]): Promise<ProviderImageResult> {
    if (!links.length) throw new AgentError("provider_error");
    const images: ImageContent[] = [];
    for (const url of links) images.push(await this.download(url));
    return { images, text: "" };
  }

  /** Poll a previously accepted task. A transient read error must never resubmit it. */
  async poll<T>(read: () => Promise<T | undefined>, interval: number): Promise<T> {
    for (;;) {
      this.signal.throwIfAborted();
      try {
        const result = await read();
        if (result !== undefined) return result;
      } catch (error) {
        const status = error instanceof AgentError ? error.httpStatus : undefined;
        if (status !== 429 && (status === undefined || status < 500)) throw error;
      }
      await delay(interval, undefined, { signal: this.signal });
    }
  }
}
