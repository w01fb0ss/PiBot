import type { DatabaseSync } from "node:sqlite";
import type { AgentRuntime } from "@pibot/agent";
import type { BrainHost, RegisterRpc, SkillsPort } from "@pibot/brain/kit";
import { abortable, redactValue, renderSkillFile, textOf } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";
import {
  canonicalImageModelId,
  type Events,
  type MethodParams,
  type Methods,
  type Peer,
  RpcError,
  RpcErrorCodes,
  SkillImportDetailsSchema,
  SkillImportSourceSchema,
  TEAM_ARCHIVE_MAX_BYTES,
  TEAM_ARCHIVE_MAX_FILES,
  type TeamPreview,
  type TeamSkillReimport,
  type TeamTemplate,
  TeamTemplateSchema,
} from "@pibot/protocol";
import type { Redactor } from "@pibot/secrets";
import { AuditRepo, PermissionsRepo, SettingsRepo, transaction } from "@pibot/storage";
import { TeamsRepo } from "../../store/index.ts";
import { buildTeamArchive, type TeamSkillPackage } from "./team-archive.ts";
import { copyTeamSkills, createTeam, skillCounts } from "./team-create.ts";
import { parseTeamBytes, teamError, tightenTemplate } from "./team-import.ts";

type Counts = { bots: number; groups: number; skills: number; files: number; scripts: number };

/** Counts only: never names, personas, norms or skill content. */
export function auditTeam(
  db: DatabaseSync,
  redactor: Redactor,
  input: {
    botId: string;
    kind: "team.created" | "team.exported";
    reasonCode: string;
    target?: string;
    counts: Counts;
  },
) {
  new AuditRepo(db, redactor).append({
    botId: input.botId,
    kind: input.kind,
    summary:
      input.kind === "team.exported"
        ? "Team file exported / 导出团队文件"
        : "Team created / 创建团队",
    detail: {
      actor: "user",
      reasonCode: input.reasonCode,
      ...(input.target ? { target: input.target.slice(0, 200) } : {}),
      botCount: input.counts.bots,
      groupCount: input.counts.groups,
      skillCount: input.counts.skills,
      fileCount: input.counts.files,
      scriptCount: input.counts.scripts,
    },
  });
}

export class TeamService {
  readonly repo: TeamsRepo;
  private current?: AbortController;
  /** Skill packages per previewed Bot, in template order. */
  private readonly previewSkills = new Map<string, TeamSkillPackage[][]>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  /** Matches an imported archive against the signed role catalog (set once at start). */
  private verifyArchive?: (data: Buffer) => Promise<boolean>;
  private readonly shutdown = new AbortController();
  setArchiveVerifier(verify: (data: Buffer) => Promise<boolean>): void {
    this.verifyArchive = verify;
  }

  get idle() {
    return this.pending.size === 0;
  }
  constructor(
    private readonly deps: {
      db: DatabaseSync;
      agent: AgentRuntime;
      host: BrainHost;
      redactor: Redactor;
      logger: Pick<Logger, "warn">;
      peer: Peer<typeof Methods, typeof Events>;
      language(): "zh" | "en";
      skills?: Pick<SkillsPort, "create" | "exportDocuments" | "exportPackages" | "previewLink">;
      bots?: { introduce(botId: string): void };
    },
  ) {
    this.repo = new TeamsRepo(deps.db, (text) => deps.redactor.redact(text));
  }
  private files() {
    if (!this.deps.host.teams) throw new RpcError(RpcErrorCodes.internal, "team_host_unavailable");
    return this.deps.host.teams;
  }
  private fileOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    discard?: (value: T) => void,
  ): Promise<T> {
    if (this.closed) throw new RpcError(RpcErrorCodes.closed, "team_stopped");
    if (this.current) throw new RpcError(RpcErrorCodes.busy, "team_busy");
    const controller = new AbortController();
    this.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(680_000)]);
    const request = Promise.resolve().then(async () => {
      let value: T | undefined;
      let completed = false;
      let cleaned = false;
      try {
        signal.throwIfAborted();
        value = await operation(signal);
        completed = true;
        await this.cancelFiles();
        cleaned = true;
        signal.throwIfAborted();
        return value;
      } catch (error) {
        if (completed) discard?.(value as T);
        throw error;
      } finally {
        // Cancellation also invalidates eventual selections from native dialogs still open.
        if (!cleaned) await this.cancelFiles();
        if (this.current === controller) this.current = undefined;
        this.pending.delete(request);
      }
    });
    this.pending.add(request);
    return request;
  }
  private async cancelFiles() {
    try {
      await this.deps.host.teams?.cancel();
    } catch {
      this.deps.logger.warn("Team file cancellation unavailable");
    }
  }
  /**
   * Always a version-3 zip in the current language. Refs become `bot-1`, `bot-2`… so the
   * file carries no local IDs; skills travel as full packages. No chats, memories, secrets, saved
   * passwords or folders.
   */
  export(input: MethodParams["teams.export"]) {
    return this.fileOperation(async (signal) => {
      let archive: Buffer;
      let counts: Counts;
      let auditBot = "";
      let defaultName = "Pi Bot";
      const omitted: TeamSkillReimport[] = [];
      try {
        const base = this.repo.export(input, 3);
        defaultName = this.deps.redactor.redact(
          base.groups[0]?.name ?? base.bots[0]?.name ?? "Pi Bot",
        );
        const refs = new Map(base.bots.map((bot, index) => [bot.ref, `bot-${index + 1}`]));
        const packages: TeamSkillPackage[][] = [];
        const bots = [];
        // Reserve actual template metadata; buildTeamArchive also checks the final raw total.
        let remainingBytes =
          TEAM_ARCHIVE_MAX_BYTES - Buffer.byteLength(JSON.stringify(base, null, 2));
        let remainingFiles = TEAM_ARCHIVE_MAX_FILES - 1;
        for (const bot of base.bots) {
          const list =
            (await this.deps.skills?.exportPackages(bot.ref, signal, {
              bytes: remainingBytes,
              files: remainingFiles,
            })) ?? [];
          for (const skill of list) {
            if (skill.reimport)
              omitted.push({
                folder: skill.folder,
                enabled: false,
                name: skill.document.name,
                description: skill.document.description,
                reimport: skill.reimport,
              });
            else {
              remainingBytes -=
                Buffer.byteLength(renderSkillFile(skill.folder, skill.document)) +
                skill.files.reduce((sum, file) => sum + file.data.length, 0);
              remainingFiles -= skill.files.length + 1;
            }
          }
          signal.throwIfAborted();
          packages.push(list);
          bots.push({
            ...bot,
            ref: refs.get(bot.ref) as string,
            ...(list.length
              ? {
                  skills: list.map((skill) =>
                    skill.reimport
                      ? {
                          folder: skill.folder,
                          enabled: false,
                          name: skill.document.name,
                          description: skill.document.description,
                          reimport: skill.reimport,
                        }
                      : { folder: skill.folder, enabled: skill.enabled },
                  ),
                }
              : {}),
          });
        }
        const template: TeamTemplate = TeamTemplateSchema.parse(
          redactValue(
            {
              ...base,
              version: 3,
              bots,
              groups: base.groups.map((group) => ({
                ...group,
                members: group.members.map((id) => refs.get(id) as string),
                coordinator: refs.get(group.coordinator) as string,
              })),
            },
            this.deps.redactor,
          ),
        );
        archive = buildTeamArchive(template, packages);
        counts = { bots: bots.length, groups: base.groups.length, ...skillCounts(packages) };
        auditBot = base.bots[0]?.ref ?? "";
      } catch (error) {
        signal.throwIfAborted();
        throw teamError(error);
      }
      signal.throwIfAborted();
      const result = await this.files().save(
        { archive: archive.toString("base64"), defaultName },
        signal,
      );
      if (result.saved && auditBot) {
        try {
          auditTeam(this.deps.db, this.deps.redactor, {
            botId: auditBot,
            kind: "team.exported",
            reasonCode: "export",
            counts,
          });
        } catch {
          // The file is already saved; a lost audit line is logged instead of failing the save.
          this.deps.logger.warn("Team audit unavailable");
        }
      }
      return { ...result, omitted };
    });
  }
  previewSkillSource(input: MethodParams["teams.previewSkillSource"], requestSignal: AbortSignal) {
    if (this.closed) throw new RpcError(RpcErrorCodes.closed, "team_stopped");
    const signal = AbortSignal.any([this.shutdown.signal, requestSignal]);
    // Downloads belong to T4's progress deadline, not the native picker/file-operation timeout.
    const work = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      if (!this.deps.skills?.previewLink)
        throw new RpcError(RpcErrorCodes.unsupported, "skill_link_import_unavailable");
      const preview = await this.deps.skills.previewLink(
        input.botId,
        SkillImportSourceSchema.parse(input.source),
        input.contentHash,
        signal,
      );
      return SkillImportDetailsSchema.parse(preview);
    });
    this.pending.add(work);
    void work
      .finally(() => this.pending.delete(work))
      .catch(() => {
        // The RPC caller receives the rejection; bookkeeping must not create a detached rejection.
      });
    return work;
  }
  pickFile() {
    return this.fileOperation(
      async (signal) => {
        const file = await this.files().pickFile(signal);
        signal.throwIfAborted();
        return file === null ? null : this.previewFile(file, signal);
      },
      (preview) => {
        if (preview) this.dismiss(preview.previewId);
      },
    );
  }
  preview(file: string) {
    return this.fileOperation(
      (signal) => this.previewFile(file, signal),
      (preview) => this.dismiss(preview.previewId),
    );
  }
  private async previewFile(file: string, signal: AbortSignal): Promise<TeamPreview> {
    const data = Buffer.from(await this.files().read(file, signal), "base64");
    signal.throwIfAborted();
    const parsed = parseTeamBytes(data, this.deps.language(), this.deps.redactor);
    const { template, notes } = tightenTemplate(
      parsed.template,
      new PermissionsRepo(this.deps.db).get().levels,
    );
    // listModels has no cancellation port; keep its actual promise until shutdown drains it.
    const readingModels = this.deps.agent.listModels({ availableOnly: true });
    this.pending.add(readingModels);
    void readingModels
      .finally(() => this.pending.delete(readingModels))
      .catch(() => {
        // The operation handles the failure; bookkeeping must not detach a rejection.
      });
    const models = await abortable(
      readingModels,
      AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
    );
    signal.throwIfAborted();
    const defaults = new SettingsRepo(this.deps.db).get().defaultModel;
    const imageModels =
      (await this.deps.agent.listImageModels?.({ availableOnly: true, signal })) ?? [];
    signal.throwIfAborted();
    const fallback = models.some((m) => m.provider === defaults?.provider && m.id === defaults.id)
      ? defaults
      : null;
    // A version-3 image Bot may leave its model open: the first image model that can do its mode.
    const image = (mode: string | undefined) =>
      imageModels.find((m) => m.modes.length && (!mode || m.modes.includes(mode as never)));
    const withModels = {
      ...template,
      bots: template.bots.map((bot) => {
        const pick = bot.category === "image" && !bot.model ? image(bot.imageMode) : undefined;
        return pick ? { ...bot, model: { provider: pick.provider, id: pick.id } } : bot;
      }),
    };
    try {
      const preview = this.repo.preview(
        JSON.stringify(withModels),
        models,
        // A fallback picks the provider, not a different thinking budget than the imported role.
        fallback ? { provider: fallback.provider, id: fallback.id } : null,
        new Date(),
        imageModels,
      );
      // Expired previews are never imported; keep the map as bounded as the repo's previews.
      const oldest = this.previewSkills.keys().next().value;
      if (this.previewSkills.size >= 32 && oldest) this.previewSkills.delete(oldest);
      this.previewSkills.set(preview.previewId, parsed.skills);
      const official = this.verifyArchive ? await this.verifyArchive(data) : undefined;
      return {
        ...preview,
        ...(parsed.files.length ? { files: parsed.files } : {}),
        ...(parsed.skipped ? { skippedFiles: parsed.skipped } : {}),
        ...(official === undefined
          ? {}
          : {
              provenance: {
                status: official ? "official" : "unverified",
                reason: official ? "catalog_match" : "no_catalog_match",
              } as const,
            }),
        ...(notes.length ? { permissionNotes: notes } : {}),
      };
    } catch {
      throw new RpcError(RpcErrorCodes.invalidParams, "team_preview_unavailable");
    }
  }
  /** One supporting file's text exactly as it would be saved; null for binary content. */
  async previewText({ previewId, ref, skill, path }: MethodParams["teams.previewFile"]) {
    const preview = this.repo.get(previewId);
    const skills = this.previewSkills.get(previewId);
    if (!preview || !skills)
      throw new RpcError(RpcErrorCodes.invalidParams, "team_preview_expired");
    const index = preview.template.bots.findIndex((bot) => bot.ref === ref);
    const file = skills[index]
      ?.find((item) => item.document.name === skill)
      ?.files.find((item) => item.path === path);
    if (!file) throw new RpcError(RpcErrorCodes.invalidParams, "team_file_unknown");
    return { text: file.text ? (textOf(file.data) ?? null) : null };
  }
  import(previewId: string) {
    if (this.closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "team_stopped"));
    const work = this.importInternal(previewId);
    this.pending.add(work);
    void work
      .finally(() => this.pending.delete(work))
      .catch(() => {
        // Import owns the rejection; bookkeeping must not create an unhandled rejection.
      });
    return work;
  }
  private async importInternal(previewId: string) {
    if (this.closed) throw new RpcError(RpcErrorCodes.closed, "team_stopped");
    if (this.current) throw new RpcError(RpcErrorCodes.busy, "team_busy");
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(25_000)]);
    const imageModels =
      (await this.deps.agent.listImageModels?.({ availableOnly: true, signal })) ?? [];
    signal.throwIfAborted();
    if (this.closed) throw new RpcError(RpcErrorCodes.closed, "team_stopped");
    const preview = this.repo.get(previewId);
    if (!preview) throw new RpcError(RpcErrorCodes.invalidParams, "team_preview_expired");
    // Import exactly the model mapping the user reviewed, never a later renderer-supplied one.
    const mappings = new Map(preview.models.map((model) => [model.ref, model]));
    const template = {
      ...preview.template,
      bots: preview.template.bots.map((b) => ({
        ...b,
        model: mappings.get(b.ref)?.resolved ?? null,
        thinkingPreference:
          b.thinkingPreference === undefined ? b.thinkingLevel : b.thinkingPreference,
        thinkingLevel: mappings.get(b.ref)?.thinkingLevel ?? "off",
      })),
    };
    if (
      template.bots.some(
        (b) =>
          b.category === "image" &&
          (!b.model ||
            !imageModels.some(
              (m) =>
                m.provider === b.model?.provider &&
                m.id === canonicalImageModelId(b.model.provider, b.model.id) &&
                m.modes.length > 0,
            )),
      )
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "image_model_unavailable");
    const skills = this.previewSkills.get(previewId) ?? [];
    let result: ReturnType<typeof createTeam>;
    try {
      result = transaction(this.deps.db, () => {
        const value = createTeam(
          {
            db: this.deps.db,
            language: this.deps.language(),
            redact: (text) => this.deps.redactor.redact(text),
            introduce: (botId) => this.deps.bots?.introduce(botId),
          },
          { template, sidebarSection: this.deps.language() === "zh" ? "团队" : "Team" },
        );
        const first = value.created[0];
        if (first)
          auditTeam(this.deps.db, this.deps.redactor, {
            botId: first,
            kind: "team.created",
            reasonCode: "import",
            counts: {
              bots: value.created.length,
              groups: value.groupIds.length,
              ...skillCounts(skills),
            },
          });
        return value;
      });
    } catch {
      // The transaction rolled back and the preview is kept; the caller may retry its ID.
      throw new RpcError(RpcErrorCodes.internal, "team_import_failed");
    }
    this.dismiss(previewId);
    const skippedSkills = await copyTeamSkills(
      this.deps.skills,
      template.bots.map((bot, index) => ({
        botId: result.refs.get(bot.ref) as string,
        packages: skills[index] ?? [],
      })),
      (message) => this.deps.logger.warn(message),
    );
    try {
      for (const botId of result.created)
        this.deps.peer.emit("bots.changed", { botId, reason: "created" });
      for (const groupId of result.groupIds)
        this.deps.peer.emit("groups.changed", { groupId, reason: "created" });
      this.deps.peer.emit("sidebar.changed", {});
    } catch {
      // The transaction already committed. Never offer a rollback retry for failed delivery.
      this.deps.logger.warn("Team import event delivery unavailable");
      throw new RpcError(RpcErrorCodes.closed, "team_import_unconfirmed");
    }
    const value = {
      botIds: result.created,
      groupIds: result.groupIds,
      sidebarGroupId: result.sidebarGroupId as string,
    };
    // Bounded like the protocol field, so an oversized list cannot fail an already committed import.
    return skippedSkills.length ? { ...value, skippedSkills: skippedSkills.slice(0, 1000) } : value;
  }
  private dismiss(previewId: string) {
    this.repo.dismiss(previewId);
    this.previewSkills.delete(previewId);
  }
  async cancel(previewId?: string) {
    if (previewId) this.dismiss(previewId);
    else {
      this.current?.abort();
      await this.cancelFiles();
    }
    return { ok: true as const };
  }
  async stop() {
    this.closed = true;
    this.shutdown.abort();
    this.current?.abort();
    await this.cancelFiles();
    await Promise.allSettled([...this.pending]);
    this.repo.dispose();
    this.previewSkills.clear();
  }
}

export function registerTeamRpc(handle: RegisterRpc, teams: TeamService) {
  handle("teams.previewSkillSource", (params, context) =>
    teams.previewSkillSource(params, context.signal),
  );
  handle("teams.export", (params) => teams.export(params));
  handle("teams.preview", ({ file }) => teams.preview(file));
  handle("teams.pickFile", () => teams.pickFile());
  handle("teams.import", async ({ previewId }) => teams.import(previewId));
  handle("teams.cancel", ({ previewId }) => teams.cancel(previewId));
  handle("teams.previewFile", (params) => teams.previewText(params));
}
