import { type NetworkProxy, withPublicDownload } from "@pibot/execution";
import {
  base64Bytes,
  base64Schema,
  FILE_LIMIT,
  IMAGE_LIMIT,
  type VideoApi,
} from "@pibot/protocol-base";
import type { VideoJob } from "@pibot/videos-contract";
import { AgnesQueueFull, httpVideoError, providerHeaders, type VideoRequest } from "./provider.ts";

export class VideoFailure extends Error {
  readonly code: string | number;

  constructor(
    readonly reason: NonNullable<VideoJob["error"]>,
    options?: ErrorOptions & { code?: string | number },
  ) {
    super(reason, options);
    this.code = options?.code ?? reason;
  }
}
export class RetryableVideoRequest extends Error {}
export class VideoQueueFull extends Error {}

const inlineVideo = base64Schema(FILE_LIMIT);

export function decodeInlineMp4(data: string) {
  if (base64Bytes(data) > FILE_LIMIT) throw new VideoFailure("size_limit");
  return checkedMp4(Buffer.from(inlineVideo.parse(data), "base64"));
}

function checkedMp4(bytes: Buffer | undefined) {
  // Native media decoders should only receive a plausible MP4 container from this tool.
  if (!bytes || bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp")
    throw new VideoFailure("provider_error");
  return bytes;
}

// DOM and Undici streams share the byte-reader operations used here, but their full types differ.
interface BodyResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: {
    cancel(): Promise<void>;
    getReader(): {
      read(): Promise<{ done: boolean; value?: unknown }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}
export type PublicVideoDownload = (
  url: string,
  signal: AbortSignal,
  read: (response: BodyResponse) => Promise<Buffer>,
) => Promise<Buffer>;

async function boundedBody(
  response: BodyResponse,
  limit: number,
  error: VideoFailure,
  signal: AbortSignal,
  allowError = false,
) {
  if (
    !response.body ||
    (!response.ok && !allowError) ||
    Number(response.headers.get("content-length")) > limit
  ) {
    await response.body?.cancel();
    throw error;
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(parts, length);
      if (!(value instanceof Uint8Array)) throw new VideoFailure("provider_error");
      length += value.byteLength;
      if (length > limit) throw error;
      parts.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

async function readErrorJson(response: BodyResponse, limit: number, signal: AbortSignal) {
  if (!response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return undefined;
  }
  try {
    const bytes = await boundedBody(
      response,
      limit,
      new VideoFailure("provider_error"),
      signal,
      true,
    );
    return bytes.length ? (JSON.parse(bytes.toString("utf8")) as unknown) : undefined;
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

export class VideoTransport {
  private readonly origin: string;

  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly publicDownload: PublicVideoDownload,
    readonly root: string,
    private readonly api: VideoApi,
    private readonly key: string,
  ) {
    this.origin = new URL(root).origin;
  }

  private async request(
    url: URL,
    signal: AbortSignal,
    method: "POST" | "GET" | "DELETE",
    body?: VideoRequest["body"],
    redirect: RequestRedirect = "error",
  ) {
    if (url.origin !== this.origin || url.username || url.password)
      throw new VideoFailure("provider_error");
    const headers = new Headers(providerHeaders(this.api, this.key));
    if (typeof body === "string") headers.set("Content-Type", "application/json");
    try {
      return await this.fetch(url, {
        headers,
        signal,
        method,
        body,
        redirect,
        credentials: "omit",
      });
    } catch (cause) {
      signal.throwIfAborted();
      throw new VideoFailure("network", { cause });
    }
  }

  async json(request: VideoRequest, signal: AbortSignal, method: "POST" | "GET") {
    const response = await this.request(
      new URL(request.path, `${this.root}/`),
      signal,
      method,
      request.body,
    );
    if (method === "GET" && (response.status === 429 || response.status >= 500)) {
      await response.body?.cancel();
      throw new RetryableVideoRequest();
    }
    const agnesCreate = this.api === "agnes" && method === "POST";
    const omniCreate = this.api === "gemini-omni" && method === "POST";
    if (!response.ok) {
      const value = await readErrorJson(response, agnesCreate ? 256 * 1024 : 64 * 1024, signal);
      if (agnesCreate && AgnesQueueFull.safeParse(value).success) throw new VideoQueueFull();
      throw new VideoFailure(httpVideoError(response.status, value), { code: response.status });
    }
    const failure = new VideoFailure("provider_error");
    // The interaction may include both an inline clip and the original image input.
    const jsonLimit =
      256 * 1024 + (omniCreate ? (Math.ceil(FILE_LIMIT / 3) + Math.ceil(IMAGE_LIMIT / 3)) * 4 : 0);
    const bodyFailure = omniCreate ? new VideoFailure("size_limit") : failure;
    const bytes = await boundedBody(response, jsonLimit, bodyFailure, signal);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (agnesCreate && AgnesQueueFull.safeParse(value).success) throw new VideoQueueFull();
    return value;
  }

  async cancel(path: string, signal: AbortSignal) {
    const response = await this.request(new URL(`${this.root}/${path}`), signal, "DELETE");
    await response.body?.cancel();
    return response.ok;
  }

  async download(input: string, signal: AbortSignal) {
    const read = (response: BodyResponse) =>
      boundedBody(
        response,
        FILE_LIMIT,
        response.ok
          ? new VideoFailure("size_limit")
          : new VideoFailure(httpVideoError(response.status), { code: response.status }),
        signal,
      );
    let url = new URL(input, `${this.root}/`);
    let bytes: Buffer | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
        throw new VideoFailure("provider_error");
      if (url.origin !== this.origin) {
        // After crossing origins, the public transport never regains provider headers, even on a redirect back.
        if (url.protocol !== "https:") throw new VideoFailure("provider_error");
        bytes = await this.publicDownload(url.href, signal, read);
        break;
      }
      const response = await this.request(url, signal, "GET", undefined, "manual");
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        bytes = await read(response);
        break;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new VideoFailure("provider_error");
      url = new URL(location, url);
    }
    return checkedMp4(bytes);
  }
}

export function publicVideoDownload(proxy: () => NetworkProxy | undefined): PublicVideoDownload {
  return (url, signal, read) =>
    withPublicDownload({ url, video: true, signal, method: "GET", proxy: proxy() }, read);
}
