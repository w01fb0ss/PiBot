import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CapabilityContext, type RegisterRpc, redactValue } from "@pibot/brain/kit";
import { withPublicDownload } from "@pibot/execution";
import {
  progressDeadline,
  RpcError,
  RpcErrorCodes,
  SKILL_IMPORT_MAX_BYTES,
  type SkillImportSource,
  type SkillLinkListing,
  SkillLinkListingSchema,
  type SkillLinkOrigin,
  type SkillLinkResolution,
  SkillLinkResolutionSchema,
} from "@pibot/skills-contract/full";
import { digestFolder } from "../service/shared-packages.ts";
import type { SkillImports } from "../service/skill-import.ts";
import type { SkillServices } from "../service/skill-services.ts";
import { extractLinkArchive, type LinkCandidate } from "./link-archive.ts";
import { auditDownload } from "./link-audit.ts";
import { downloadArchive } from "./link-download.ts";
import { linkFailure } from "./link-errors.ts";
import { type LinkSource, linkError, linkSubpath, resolveLink } from "./link-source.ts";

const TTL = 10 * 60_000;
interface Entry {
  source: LinkSource;
  resolution: SkillLinkResolution;
  abort: AbortController;
  expires: number;
  directory?: string;
  selectionId?: string;
  running?: Promise<unknown>;
  listing?: SkillLinkListing;
  candidates?: LinkCandidate[];
  origin?: SkillLinkOrigin;
  previews: { imports: SkillImports; previewId: string }[];
}

/** One capability owns downloads, expiry and all previews that still read their temporary files. */
export class SkillLinks {
  private readonly sources = new Map<string, Entry>();
  private readonly stopped = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly root: string;
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly services: SkillServices,
    private readonly signal: AbortSignal,
    private readonly actorBotId: string,
    private readonly network = { resolve: resolveLink, request: withPublicDownload },
  ) {
    this.root = join(ctx.dataDir, "skill-downloads");
    // The brain has exclusive data-directory ownership. Clear only this feature's crash leftovers.
    this.ready = rm(this.root, { recursive: true, force: true })
      .then(() => mkdir(this.root, { recursive: true, mode: 0o700 }))
      .then(() => undefined);
    // Capture initialization failure until the first RPC/stop can report it, never detach a rejection.
    void this.ready.catch(() => undefined);
    this.timer = setInterval(() => {
      for (const [id, entry] of this.sources) {
        if (entry.previews.some(({ imports, previewId }) => imports.isImporting(previewId))) {
          entry.expires = Date.now() + TTL;
        } else if (entry.expires <= Date.now() && !entry.running) {
          void this.track(() => this.cancel(id)).catch(() => this.warn());
        }
      }
    }, 30_000);
    this.timer.unref();
  }
  get retained() {
    return this.sources.size > 0 || this.pending.size > 0;
  }
  private warn() {
    this.ctx.logger.warn(JSON.stringify({ module: "skills", event: "link_cleanup_failed" }));
  }
  private track<T>(action: () => Promise<T>) {
    const work = Promise.resolve().then(action);
    this.pending.add(work);
    void work
      .finally(() => this.pending.delete(work))
      .catch(() => {
        /* Caller owns the failure. */
      });
    return work;
  }
  register(handle: RegisterRpc) {
    handle("skills.resolveLink", ({ url }, context) => this.resolve(url, context.signal));
    handle("skills.downloadLink", ({ sourceId }, context) =>
      this.download(sourceId, context.signal),
    );
    handle("skills.previewLink", ({ sourceId, candidateId, botId, groupId }, context) =>
      this.preview(sourceId, candidateId, botId, groupId, context.signal),
    );
    handle("skills.cancelLink", ({ sourceId }) => this.cancel(sourceId));
  }
  private get(id: string) {
    const entry = this.sources.get(id);
    if (!entry || entry.expires <= Date.now() || entry.abort.signal.aborted)
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_link_expired");
    return entry;
  }
  private async guard<T>(
    signal: AbortSignal,
    action: (signal: AbortSignal, touch: () => void) => Promise<T>,
  ) {
    const work = progressDeadline(AbortSignal.any([signal, this.signal, this.stopped.signal]));
    try {
      return await action(work.signal, work.touch);
    } catch (error) {
      throw linkFailure(error, work.signal);
    } finally {
      work.dispose();
    }
  }
  resolve(url: string, signal: AbortSignal) {
    return this.track(() =>
      this.guard(signal, async (signal) => {
        await this.ready;
        if (this.sources.size >= 4) throw new RpcError(RpcErrorCodes.busy, "skill_link_busy");
        const result = await this.network.resolve(url, signal, this.ctx.local.deps.proxy?.());
        signal.throwIfAborted();
        if (this.sources.size >= 4) throw new RpcError(RpcErrorCodes.busy, "skill_link_busy");
        const { source, bytes, estimate } = result;
        const sourceId = randomUUID();
        const expires = Date.now() + TTL;
        const resolution = SkillLinkResolutionSchema.parse({
          sourceId,
          host: source.host,
          owner: source.owner,
          repo: source.repo,
          ref: source.ref,
          subpath: source.subpath,
          bytes,
          estimateBytes: estimate,
          expiresAt: new Date(expires).toISOString(),
        });
        this.sources.set(sourceId, {
          source,
          resolution,
          abort: new AbortController(),
          expires,
          previews: [],
        });
        return resolution;
      }),
    );
  }
  download(id: string, signal: AbortSignal): Promise<SkillLinkListing> {
    const entry = this.get(id);
    if (entry.listing) return Promise.resolve(entry.listing);
    // A retry while this source is still downloading must join the transfer in flight instead of
    // starting a second one: its progress events carry the same sourceId, so the retry shows the
    // download that is already running. A finished or aborted run has cleared `running` by then.
    if (entry.running) return entry.running as Promise<SkillLinkListing>;
    let received = 0;
    let commit: string | undefined;
    const work = this.track(async () => {
      let result = "ok";
      try {
        return await this.guard(
          AbortSignal.any([signal, entry.abort.signal]),
          async (signal, touch) => {
            await this.ready;
            const directory = await mkdtemp(join(this.root, "source-"));
            entry.directory = directory;
            const archive = join(directory, "source.zip");
            let last = 0;
            const emit = (
              phase: "downloading" | "scanning",
              bytes: number,
              totalBytes: number | null,
            ) => {
              touch();
              if (phase === "downloading" && last && Date.now() - last < 200) return;
              last = Date.now();
              try {
                this.ctx.peer.emit("skills.linkProgress", {
                  sourceId: id,
                  phase,
                  bytes,
                  totalBytes,
                });
              } catch {
                this.ctx.logger.warn(
                  JSON.stringify({ module: "skills", event: "link_progress_unavailable" }),
                );
              }
            };
            // HEAD and the GET header both may lack a length; the repository-size estimate is the
            // only total left, and the bar shows an indeterminate state when even that is unknown.
            const totalEstimate = entry.resolution.estimateBytes ?? entry.resolution.bytes;
            await downloadArchive(
              archive,
              entry.source,
              signal,
              (bytes, total) => {
                received = bytes;
                if (bytes <= SKILL_IMPORT_MAX_BYTES)
                  emit("downloading", bytes, total ?? totalEstimate);
              },
              this.ctx.local.deps.proxy?.(),
              this.network.request,
              entry.resolution.bytes,
            );
            const destination = join(directory, "files");
            await mkdir(destination, { mode: 0o700 });
            emit("scanning", 0, null);
            const extracted = await extractLinkArchive(
              archive,
              destination,
              entry.source.subpath,
              signal,
              touch,
            );
            commit = extracted.commit;
            await rm(archive);
            signal.throwIfAborted();
            if (entry.source.owner && !extracted.commit)
              throw linkError("skill_link_commit_unavailable");
            entry.candidates = extracted.candidates;
            entry.origin = {
              host: entry.source.host,
              url: entry.source.url,
              owner: entry.source.owner,
              repo: entry.source.repo,
              ref: entry.source.ref,
              commit: extracted.commit,
              subpath: entry.source.subpath,
              downloadedAt: new Date().toISOString(),
            };
            entry.expires = Date.now() + TTL;
            const selection = extracted.packageRoot
              ? await this.ctx.host.connectorImports?.adopt?.({
                  path: extracted.packageRoot,
                  temporary: true,
                })
              : undefined;
            entry.selectionId = selection?.selectionId;
            signal.throwIfAborted();
            if (extracted.packageRoot && !selection) throw linkError("skill_import_unsupported");
            entry.listing = SkillLinkListingSchema.parse(
              redactValue(
                {
                  sourceId: id,
                  ...(selection ? { selectionId: selection.selectionId } : {}),
                  skills: extracted.candidates.map(
                    ({ path: _path, subpath: _subpath, ...candidate }) => ({
                      ...candidate,
                      selected: extracted.candidates.length === 1,
                    }),
                  ),
                  components: extracted.components,
                  externalSources: extracted.externalSources,
                  expiresAt: new Date(entry.expires).toISOString(),
                },
                this.ctx.redactor,
              ),
            );
            return entry.listing;
          },
        );
      } catch (error) {
        result = error instanceof RpcError ? error.message : "skill_link_download_failed";
        throw error;
      } finally {
        auditDownload(this.ctx, this.actorBotId, entry.source, received, result, commit);
      }
    });
    entry.running = work;
    return work
      .catch(async (error: unknown) => {
        entry.abort.abort();
        this.sources.delete(id);
        if (entry.selectionId)
          await this.ctx.host.connectorImports?.release({ selectionId: entry.selectionId });
        if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
        throw error;
      })
      .finally(() => {
        entry.running = undefined;
      });
  }
  async previewTeamSource(
    botId: string,
    source: SkillImportSource,
    expectedHash: string,
    signal: AbortSignal,
  ) {
    this.services.skills.activeBot(botId);
    const { sourceId } = await this.resolve(source.url, signal);
    try {
      const entry = this.get(sourceId);
      if (entry.source.subpath && entry.source.subpath !== source.subpath)
        throw linkError("skill_link_candidate_missing");
      if (source.subpath) entry.source.subpath = linkSubpath(source.subpath);
      await this.download(sourceId, signal);
      const candidate = entry.candidates?.find((item) => item.subpath === source.subpath);
      if (!candidate) throw linkError("skill_link_candidate_missing");
      await this.guard(AbortSignal.any([signal, entry.abort.signal]), async (signal, touch) => {
        const { digest } = await digestFolder(candidate.path, signal, touch, { ignoreJunk: true });
        if (digest !== expectedHash) throw linkError("skill_link_source_changed");
      });
      const preview = await this.preview(sourceId, candidate.id, botId, undefined, signal, {
        expectedHash,
        source,
      });
      this.services.skills.imports.onPreviewRelease(preview.previewId, () => {
        if (!entry.abort.signal.aborted)
          void this.track(() => this.cancel(sourceId)).catch(() => this.warn());
      });
      return preview;
    } catch (error) {
      await this.cancel(sourceId).catch(() => this.warn());
      throw error;
    }
  }

  preview(
    id: string,
    candidateId: string,
    botId: string,
    groupId: string | undefined,
    signal: AbortSignal,
    team?: { expectedHash: string; source: SkillImportSource },
  ) {
    const entry = this.get(id);
    if (entry.running) throw new RpcError(RpcErrorCodes.busy, "skill_link_busy");
    const candidate = entry.candidates?.find((item) => item.id === candidateId);
    if (!candidate || !entry.origin) throw linkError("skill_link_candidate_missing");
    if (entry.previews.length >= 200) throw new RpcError(RpcErrorCodes.busy, "skill_link_busy");
    const imports = this.services.skillsFor(groupId).imports;
    const origin = { ...entry.origin, subpath: candidate.subpath };
    const work = this.track(async () => {
      const deadline = AbortSignal.any([
        signal,
        entry.abort.signal,
        this.signal,
        this.stopped.signal,
      ]);
      try {
        const preview = await imports.previewPath(botId, candidate.path, "folder", deadline, {
          linkOrigin: origin,
          ...(team
            ? { create: { expectedHash: team.expectedHash, importSource: team.source } }
            : {}),
        });
        if (deadline.aborted) {
          await imports.cancel(preview.previewId);
          deadline.throwIfAborted();
        }
        entry.previews.push({ imports, previewId: preview.previewId });
        entry.expires = Date.now() + TTL;
        return preview;
      } catch (error) {
        throw linkFailure(error, deadline);
      }
    });
    entry.running = work;
    return work.finally(() => {
      entry.running = undefined;
    });
  }
  async cancel(id: string) {
    const entry = this.sources.get(id);
    if (!entry) return { ok: true as const };
    entry.abort.abort();
    if (entry.running) await entry.running.catch(() => undefined);
    // The import can be queued/running independently of the source RPC. Drain it before rm.
    await Promise.all(entry.previews.map(({ imports, previewId }) => imports.cancel(previewId)));
    if (entry.selectionId)
      await this.ctx.host.connectorImports?.release({ selectionId: entry.selectionId });
    if (entry.directory) await rm(entry.directory, { recursive: true, force: true });
    this.sources.delete(id);
    return { ok: true as const };
  }
  async stop() {
    clearInterval(this.timer);
    this.stopped.abort();
    await Promise.allSettled([...this.pending]);
    await this.ready;
    await Promise.all([...this.sources.keys()].map((id) => this.cancel(id)));
    await rm(this.root, { recursive: true, force: true });
  }
}
