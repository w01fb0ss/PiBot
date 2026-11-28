import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type Attachment,
  type AttachmentInput,
  type ImageContent,
  KernelHostMethods,
  type ModelInfo,
  mediaMime,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { StoredAttachment } from "@pibot/storage";
import type { OfficePort } from "../../runtime/media/office-port.ts";
import { convertFile, type ExtractedAttachment, encodeCache } from "./attachment-conversion.ts";
import { checkedImage, discardFiles, readOwnedFile, saveFile } from "./attachment-files.ts";
import { type AttachmentHost, requireAttachmentHost } from "./attachment-types.ts";

export interface AttachmentSource {
  input: AttachmentInput;
  cache?: string;
  stored?: StoredAttachment;
}
export interface PreparedAttachment {
  sourceAttachmentId?: string;
  metadata: Attachment;
  path: string;
  textPath: string | null;
}
export interface PreparedAttachments {
  items: PreparedAttachment[];
  images: ImageContent[];
  text: string;
  discard(): Promise<void>;
}

export class AttachmentBatch {
  private readonly paths: string[] = [];
  private readonly images: ImageContent[] = [];
  private readonly items: PreparedAttachment[] = [];
  private readonly sections: string[] = [];
  private remaining: number;
  private readonly perFile: number;
  constructor(
    private readonly root: string,
    private readonly model: Pick<ModelInfo, "input" | "contextWindow">,
    private readonly host: AttachmentHost | undefined,
    private readonly signal: AbortSignal,
    private readonly office?: () => OfficePort,
  ) {
    // One UTF-8 byte per token is conservative across CJK, code and mixed text.
    this.remaining = Math.max(0, Math.min(200_000, Math.floor(model.contextWindow * 0.5)) - 2048);
    this.perFile = Math.max(0, Math.min(100_000, Math.floor(model.contextWindow * 0.25)) - 512);
  }
  private async save(path: string, data: string | Buffer) {
    this.paths.push(path);
    await saveFile(path, data, this.signal);
  }
  async add(source: AttachmentSource) {
    this.signal.throwIfAborted();
    if (source.input.kind === "image") await this.image({ ...source, input: source.input });
    else await this.file(source);
  }
  async addOutput(
    input: AttachmentInput | { kind: "file"; name: string; mimeType: string; data: string },
  ) {
    if (input.kind === "image") return this.image({ input }, true);
    await this.addOutputFile(input);
  }
  private async addOutputFile(input: { name: string; mimeType: string; data: string }) {
    this.signal.throwIfAborted();
    const bytes = Buffer.from(input.data, "base64");
    const id = randomUUID();
    const extension = /^[a-z0-9]{1,16}$/.test(input.name.split(".").at(-1)?.toLowerCase() ?? "")
      ? input.name.split(".").at(-1)?.toLowerCase()
      : "bin";
    const path = join(this.root, `${id}.${extension}`);
    await this.save(path, bytes);
    const item: PreparedAttachment = {
      metadata: {
        id,
        kind: "file",
        name: input.name,
        mimeType: input.mimeType,
        size: bytes.length,
      },
      path,
      textPath: null,
    };
    this.items.push(item);
    return item;
  }
  private async image(
    { input, stored }: AttachmentSource & { input: Extract<AttachmentInput, { kind: "image" }> },
    output = false,
  ) {
    if (!output && !this.model.input.includes("image"))
      throw new RpcError(RpcErrorCodes.imageUnsupported, "image_unsupported");
    checkedImage(input.data, input.mimeType);
    const result = KernelHostMethods["host.attachments.image"].result.parse(
      stored
        ? {
            image: { type: "image", data: input.data, mimeType: input.mimeType },
            width: stored.metadata.width,
            height: stored.metadata.height,
          }
        : await requireAttachmentHost(this.host).image(
            { type: "image", data: input.data, mimeType: input.mimeType },
            this.signal,
          ),
    );
    const bytes = checkedImage(result.image.data, result.image.mimeType);
    const id = randomUUID();
    const path = join(this.root, `${id}.${result.image.mimeType === "image/jpeg" ? "jpg" : "png"}`);
    await this.save(path, bytes);
    this.items.push({
      metadata: {
        id,
        kind: "image",
        name: input.name,
        mimeType: result.image.mimeType,
        size: bytes.length,
        width: result.width,
        height: result.height,
      },
      path,
      textPath: null,
      sourceAttachmentId: stored?.metadata.id,
    });
    this.images.push(result.image);
    // The model has the picture but not the file it came from, so it used to search the
    // whole disk for it. The path goes into the message text (never a stable prompt section), so
    // prompt caching is unaffected; an output image is for the user, not for the model to read.
    // The wording must not invite reading it to look at it: "read it directly with a tool" made a
    // translator read the file, open it in an app and screenshot it for 8 minutes instead of
    // translating the picture it already had (2026-11-14).
    if (!output)
      this.sections.push(
        `图片：${JSON.stringify(input.name)}（${result.image.mimeType}，${bytes.length} bytes）已随消息附上，你能直接看到它；只有要把文件交给工具（编辑、发送、放进文档）时才用这个路径：${path}（附件 ID：${id}），不要为了查看而读取或打开它 / Image: ${JSON.stringify(input.name)} (${result.image.mimeType}, ${bytes.length} bytes) is attached and you can see it directly. Use this path only to hand the file to a tool (edit, send, place in a document): ${path}; don't read or open it to view it. Attachment ID: ${id}`,
      );
    this.remaining = Math.max(0, this.remaining - 4096);
  }
  private truncate(extracted: ExtractedAttachment, metadata: Attachment) {
    const bytes = Buffer.from(extracted.text, "utf8");
    let body = bytes
      .subarray(0, Math.min(this.remaining, this.perFile))
      .toString("utf8")
      .replace(/\uFFFD$/, "");
    metadata.truncated = body.length < extracted.totalChars;
    metadata.sentPercent = extracted.totalChars
      ? Math.floor((body.length / extracted.totalChars) * 100)
      : 100;
    this.remaining = Math.max(0, this.remaining - Buffer.byteLength(body));
    if (metadata.truncated)
      body += `\n[已截断：只发送了前 ${metadata.sentPercent}% / Truncated: first ${metadata.sentPercent}% sent]`;
    return body;
  }
  private async cachedPages(
    source: AttachmentSource,
    pages: number,
  ): Promise<ImageContent[] | undefined> {
    if (!source.stored) return undefined;
    const images: ImageContent[] = [];
    for (let page = 1; page <= pages; page++) {
      try {
        const data = await readOwnedFile(
          this.root,
          join(this.root, `${source.stored.metadata.id}.page-${page}.png`),
          this.signal,
        );
        images.push({ type: "image", data: data.toString("base64"), mimeType: "image/png" });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      }
    }
    return images;
  }
  private async scan(
    source: AttachmentSource,
    extracted: ExtractedAttachment,
    metadata: Attachment,
  ) {
    if (!this.model.input.includes("image"))
      throw new RpcError(RpcErrorCodes.scannedPdfUnsupported, "scanned_pdf_unsupported");
    const pages = Math.min(
      10 - this.images.length,
      Math.floor(this.remaining / 4096),
      extracted.pages,
    );
    if (pages < 1)
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_image_budget");
    const cached = await this.cachedPages(source, pages);
    const rendered = cached
      ? { images: cached, totalPages: extracted.pages }
      : KernelHostMethods["host.attachments.pdf"].result.parse(
          await requireAttachmentHost(this.host).pdf(
            { data: source.input.data, pages },
            this.signal,
          ),
        );
    for (const [index, image] of rendered.images.entries()) {
      await this.save(
        join(this.root, `${metadata.id}.page-${index + 1}.png`),
        checkedImage(image.data, image.mimeType),
      );
      this.images.push(image);
    }
    this.remaining = Math.max(0, this.remaining - rendered.images.length * 4096);
    metadata.truncated = rendered.images.length < rendered.totalPages;
    metadata.sentPercent = Math.floor((rendered.images.length / rendered.totalPages) * 100);
    return `扫描 PDF：已发送前 ${rendered.images.length} / ${rendered.totalPages} 页图片${metadata.truncated ? "（已截断）" : ""}。`;
  }
  private async file(source: AttachmentSource) {
    const { input } = source;
    const bytes = Buffer.from(input.data, "base64");
    if (mediaMime(input.name)) {
      const item = await this.addOutputFile(input);
      // Media can be delivered or played; the chat model receives no media bytes to interpret.
      item.sourceAttachmentId = source.stored?.metadata.id;
      this.sections.push(
        `Media attachment: ${JSON.stringify(input.name)} (attachment ID: ${item.metadata.id}). Available for playback in chat.`,
      );
      return;
    }
    const extracted = await convertFile(input, bytes, source.cache, this.signal, this.office);
    const id = randomUUID();
    const path = join(this.root, `${id}.${input.name.split(".").at(-1)?.toLowerCase()}`);
    const textPath = join(this.root, `${id}.text.txt`);
    await this.save(path, bytes);
    await this.save(textPath, encodeCache(extracted));
    const metadata: Attachment = {
      id,
      kind: "file",
      name: input.name,
      mimeType: input.mimeType,
      size: bytes.length,
    };
    const delimiter = randomUUID();
    // The saved file is what a skill script or the office tools can actually open, so the
    // header names it; without the path the model searched the disk for its own attachment.
    const header = `附件：${JSON.stringify(input.name)}（${input.mimeType}，${bytes.length} bytes）\n已保存为：${path}，可以用工具直接读这个文件 / Saved as: ${path} — read it directly with a tool\n<attachment-data-${delimiter}>\n`;
    const footer = `\n</attachment-data-${delimiter}>`;
    this.remaining = Math.max(0, this.remaining - Buffer.byteLength(header + footer) - 256);
    const body = extracted.scanned
      ? await this.scan(source, extracted, metadata)
      : this.truncate(extracted, metadata);
    this.items.push({ metadata, path, textPath, sourceAttachmentId: source.stored?.metadata.id });
    this.sections.push(`${header}${body}${footer}`);
  }
  result(): PreparedAttachments {
    return {
      items: this.items,
      images: this.images,
      text: this.sections.join("\n\n"),
      discard: () => this.discard(),
    };
  }
  discard() {
    return discardFiles(this.paths);
  }
}
