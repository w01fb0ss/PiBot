import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { opendir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type AttachmentInput,
  AttachmentInputSchema,
  AttachmentSchema,
  FILE_LIMIT,
  fileMime,
  IMAGE_LIMIT,
  ImageContentSchema,
  type ModelInfo,
  mediaMime,
  RpcError,
  RpcErrorCodes,
  THUMBNAIL_BYTES,
} from "@pibot/protocol-base";
import { AttachmentsRepo, storedAttachmentPath } from "@pibot/storage";
import type { OfficePort } from "../../runtime/media/office-port.ts";
import {
  AttachmentBatch,
  type AttachmentSource,
  type PreparedAttachments,
} from "./attachment-batch.ts";
import {
  attachmentDirectory,
  attachmentFile,
  imageMime,
  invalidAttachment,
  readOwnedFile,
} from "./attachment-files.ts";
import { type AttachmentHost, requireAttachmentHost } from "./attachment-types.ts";

export type { PreparedAttachments } from "./attachment-batch.ts";

export class AttachmentService {
  private readonly repo: AttachmentsRepo;
  constructor(
    readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly host?: AttachmentHost,
    private readonly office?: () => OfficePort,
  ) {
    this.repo = new AttachmentsRepo(db);
  }
  async prepareOutput(
    botId: string,
    files: { name: string; bytes: Buffer }[],
    signal: AbortSignal,
  ): Promise<PreparedAttachments> {
    if (!files.length || files.length > 5) invalidAttachment();
    const root = await attachmentDirectory(this.dataDir, botId);
    // Output is shown to the user, independent of the current model's image input capability.
    const batch = new AttachmentBatch(root, { input: [], contextWindow: 0 }, this.host, signal);
    try {
      for (const file of files) {
        if (file.bytes.length > FILE_LIMIT)
          throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_too_large");
        let mime: string | undefined;
        try {
          mime = imageMime(file.bytes);
        } catch (error) {
          if (!(error instanceof RpcError)) throw error;
        }
        if (mime && file.bytes.length > IMAGE_LIMIT)
          throw new RpcError(RpcErrorCodes.attachmentInvalid, "attachment_too_large");
        if (mime && !this.host)
          throw new RpcError(RpcErrorCodes.unsupported, "image_host_unavailable");
        const input = {
          kind: mime ? "image" : "file",
          name: file.name,
          mimeType: mime ?? fileMime(file.name) ?? "application/octet-stream",
          data: file.bytes.toString("base64"),
        };
        AttachmentSchema.pick({ name: true }).parse({ name: input.name });
        await batch.addOutput(
          input.kind === "image" ? AttachmentInputSchema.parse(input) : { ...input, kind: "file" },
        );
      }
      return batch.result();
    } catch (error) {
      await batch.discard();
      throw error;
    }
  }
  async image(id: string) {
    const item = this.repo.get(id);
    if (item?.metadata.kind !== "image") invalidAttachment();
    const root = await attachmentDirectory(this.dataDir, item.botId);
    const data = await readOwnedFile(
      root,
      await attachmentFile(this.dataDir, item.path),
      AbortSignal.timeout(5000),
    );
    return ImageContentSchema.parse({
      type: "image",
      data: data.toString("base64"),
      mimeType: item.metadata.mimeType,
    });
  }
  /** Thumbnails are generated once by the host and kept beside the original. */
  async preview(id: string) {
    const item = this.repo.get(id);
    if (item?.metadata.kind !== "image") invalidAttachment();
    const thumbnail = this.host?.thumbnail;
    if (!thumbnail) return this.image(id);
    const root = await attachmentDirectory(this.dataDir, item.botId);
    const path = join(root, `${item.metadata.id}.thumb`);
    const cached = await readOwnedFile(root, path, AbortSignal.timeout(5000)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    // An oversized cache entry predates the shared budget (2x OS thumbnails); regenerate it.
    if (cached && cached.length <= THUMBNAIL_BYTES)
      return ImageContentSchema.parse({
        type: "image",
        data: cached.toString("base64"),
        mimeType: imageMime(cached),
      });
    const image = await thumbnail.call(
      this.host,
      { botId: item.botId, file: `${item.metadata.id}.${item.path.split(".").at(-1)}` },
      AbortSignal.timeout(15_000),
    );
    // Write then rename, so a crash never leaves a truncated thumbnail that later reads trust.
    const temporary = join(root, `${item.metadata.id}.thumb.tmp-${randomUUID()}`);
    try {
      await writeFile(temporary, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return image;
  }
  async open(id: string) {
    const item = this.repo.get(id);
    if (item?.metadata.kind !== "file") invalidAttachment();
    await requireAttachmentHost(this.host).open({
      botId: item.botId,
      file: `${item.metadata.id}.${item.path.split(".").at(-1)}`,
    });
  }
  persist(messageId: string, prepared: PreparedAttachments, ownerBotId?: string) {
    if (!prepared.items.length) return;
    // Batch files live under attachmentDirectory(), which is built from the realpath'd data root.
    const root = realpathSync(this.dataDir);
    for (const item of prepared.items)
      this.repo.create(
        messageId,
        item.metadata,
        storedAttachmentPath(root, item.path),
        item.textPath === null ? null : storedAttachmentPath(root, item.textPath),
        ownerBotId,
        item.sourceAttachmentId,
      );
  }
  async recover(botIds: string[], signal: AbortSignal) {
    for (const botId of botIds) {
      const root = await attachmentDirectory(this.dataDir, botId);
      const entries = await opendir(root);
      for await (const entry of entries) {
        signal.throwIfAborted();
        const id =
          /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:[a-z0-9]+|text\.txt|page-\d+\.png|thumb(?:\.tmp-[0-9a-f-]{36})?)$/.exec(
            entry.name,
          )?.[1];
        // Only application-owned UUID files without committed metadata can be crash leftovers.
        // An interrupted thumbnail write is always disposable, even for a live attachment.
        if (entry.isFile() && id && (!this.repo.get(id) || entry.name.includes(".thumb.tmp-")))
          await rm(join(root, entry.name), { force: true });
      }
    }
  }
  private async saved(
    root: string,
    botId: string,
    id: string,
    signal: AbortSignal,
    groupId?: string,
  ): Promise<AttachmentSource> {
    const stored = this.repo.get(id);
    if (!stored) invalidAttachment();
    if (groupId) {
      if (this.repo.groupId(id) !== groupId) invalidAttachment();
    } else if (stored.botId !== botId) invalidAttachment();
    const sourceRoot =
      stored.botId === botId ? root : await attachmentDirectory(this.dataDir, stored.botId);
    const data = await readOwnedFile(
      sourceRoot,
      await attachmentFile(this.dataDir, stored.path),
      signal,
    );
    return {
      stored,
      input: AttachmentInputSchema.parse({
        kind: stored.metadata.kind,
        name: stored.metadata.name,
        mimeType: mediaMime(stored.metadata.name) ?? stored.metadata.mimeType,
        data: data.toString("base64"),
      }),
      ...(stored.textPath
        ? {
            cache: (
              await readOwnedFile(
                sourceRoot,
                await attachmentFile(this.dataDir, stored.textPath),
                signal,
              )
            ).toString("utf8"),
          }
        : {}),
    };
  }
  async forwardingInputs(ids: string[], signal: AbortSignal): Promise<AttachmentInput[]> {
    if (ids.length > 5 || new Set(ids).size !== ids.length) invalidAttachment();
    const result: AttachmentInput[] = [];
    for (const id of ids) {
      signal.throwIfAborted();
      const stored = this.repo.get(id);
      if (!stored) invalidAttachment();
      const root = await attachmentDirectory(this.dataDir, stored.botId);
      const bytes = await readOwnedFile(
        root,
        await attachmentFile(this.dataDir, stored.path),
        signal,
      );
      result.push(
        AttachmentInputSchema.parse({
          kind: stored.metadata.kind,
          name: stored.metadata.name,
          mimeType: mediaMime(stored.metadata.name) ?? stored.metadata.mimeType,
          data: bytes.toString("base64"),
        }),
      );
    }
    return result;
  }
  async prepare(
    botId: string,
    inputs: AttachmentInput[],
    ids: string[],
    model: Pick<ModelInfo, "input" | "contextWindow">,
    signal: AbortSignal,
    groupId?: string,
  ): Promise<PreparedAttachments> {
    if (inputs.length + ids.length > 5 || new Set(ids).size !== ids.length) invalidAttachment();
    const root = inputs.length || ids.length ? await attachmentDirectory(this.dataDir, botId) : "";
    const batch = new AttachmentBatch(root, model, this.host, signal, this.office);
    try {
      for (const input of inputs) await batch.add({ input: AttachmentInputSchema.parse(input) });
      for (const id of ids) await batch.add(await this.saved(root, botId, id, signal, groupId));
      return batch.result();
    } catch (error) {
      await batch.discard();
      if (error instanceof RpcError) throw error;
      throw new RpcError(RpcErrorCodes.attachmentConversion, "attachment_conversion");
    }
  }
}
