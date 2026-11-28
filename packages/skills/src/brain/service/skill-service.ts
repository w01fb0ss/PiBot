import { basename, join, relative, sep } from "node:path";
import type { SkillPromptEntry } from "@pibot/agent";
import type { BuiltinMethodsPort, CapabilityContext, SkillInventoryItem } from "@pibot/brain/kit";
import {
  copyScannedSkillPackage,
  folderEntries,
  importedDocument,
  PackageError,
  type PackageFile,
  parseSkillFile,
  redactValue,
  renderSkillFile,
  requireGroupMember,
  type ScannedSkillPackage,
  type SkillCopyProgress,
  scanSkillPackage,
  skillFingerprint,
  skillResourceDigests,
  skillSlug,
  storedParams,
  storedWorkflow,
} from "@pibot/brain/kit";
import { isSafeSecretEnvName } from "@pibot/execution";
import {
  type MethodParams,
  RpcError,
  SKILL_CONTRACT_MAX_CHARS,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  SKILL_PACKAGE_VERIFY_TIMEOUT_MS,
  type Skill,
  type SkillCompatibilityReport,
  SkillContractSchema,
  SkillDirSchema,
  type SkillDocument,
  type SkillDocumentInput,
  type SkillDocumentPatch,
  SkillDocumentSchema,
  type SkillFileChange,
  type SkillImportSource,
  type SkillLabels,
  type SkillPackageFile,
  type SkillSource,
  type SkillUpdateState,
  type TeamSkill,
  withProgressDeadline,
} from "@pibot/skills-contract/full";
import { AuditRepo, BotsRepo, GroupsRepo, transaction } from "@pibot/storage";
import {
  BuiltinSkillsRepo,
  GroupSkillsRepo,
  SkillDocumentMetadataRepo,
  type SkillRecord,
  type SkillRepository,
  SkillsRepo,
  type SkillUpdateRecord,
  type SkillUpdateScope,
  SkillUpdatesRepo,
  toSkill,
} from "../../store/index.ts";
import { BuiltinSkillInstaller } from "./builtin-skills.ts";
import { SharedSkillPackages } from "./shared-packages.ts";
import {
  allowedToolValues,
  compatibilityFrontmatter,
  skillCompatibility,
} from "./skill-compatibility.ts";
import { exportSkillPackages } from "./skill-export.ts";
import { applyFileChanges, SkillUploads, uploadIdsOf } from "./skill-file-edits.ts";
import {
  botSkillsRoot,
  listSkillFiles,
  type PackageWrite,
  readSkillFile,
  readSkillPackageFiles,
  readSupportingFile,
  removeSkillFolder,
  skillFilePath,
  skillFolder,
  writeSkillAttachment,
  writeSkillFile,
  writeSkillPackage,
} from "./skill-files.ts";
import { SkillImports } from "./skill-import.ts";
import { SkillProposals } from "./skill-proposals.ts";
import { skillProvenance } from "./skill-provenance.ts";
import { copySkillAsOwn, editSharedSkill } from "./skill-shared-edits.ts";
import { replaceImportedBody, sourceSkillText } from "./skill-source-text.ts";

type SkillDeps = Pick<
  CapabilityContext,
  "db" | "dataDir" | "peer" | "redactor" | "logger" | "host"
> & {
  packages?: SharedSkillPackages;
  local?: Pick<CapabilityContext["local"], "userSecrets"> & {
    deps?: Pick<CapabilityContext["local"]["deps"], "platform">;
  };
  roleSkillLabels?: (botId: string, name: string, description: string) => SkillLabels | undefined;
  builtinMethods?: (
    botId: string,
    language?: "zh" | "en",
  ) => ReturnType<BuiltinMethodsPort["methods"]>;
};
export type SkillChange =
  | "created"
  | "imported"
  | "updated"
  | "removed"
  | "enabled"
  | "disabled"
  | "proposed"
  | "accepted"
  | "declined"
  // Built-in sync: merging copies of one method, updates and the user's choices.
  | "builtin_merged"
  | "builtin_archived"
  | "builtin_merge_skipped"
  | "builtin_updated"
  | "builtin_replaced"
  | "builtin_renamed"
  | "builtin_kept";

const invalid = (message: string) => new RpcError(-32602, message);
/** The detail report reads only documents SKILL.md names, bounded like the import preview. */
const MAX_DOCUMENTS = 8;
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Validate structured editor input without ever copying its values into an RPC error. */
export function canonicalWorkflowContract(
  input: unknown,
  prefix: string,
  scope?: { db: SkillDeps["db"]; groupId?: string },
): string {
  const parsed = SkillContractSchema.safeParse(input);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String).join(".");
    throw invalid(path ? `${prefix}.${path}` : prefix);
  }
  if (parsed.data.steps?.length) {
    if (!scope?.groupId) throw invalid(`${prefix}.steps`);
    const group = new GroupsRepo(scope.db).get(scope.groupId);
    if (!group) throw invalid(`${prefix}.steps`);
    const bots = new BotsRepo(scope.db);
    parsed.data.steps.forEach((step, index) => {
      const owner = step.owner;
      if ("botId" in owner) {
        const bot = bots.get(owner.botId);
        if (!group.members.some((member) => member.botId === owner.botId) || !bot || bot.archivedAt)
          throw invalid(`${prefix}.steps.${index}.owner.botId`);
        return;
      }
      const matches = group.members.filter((member) => {
        const bot = bots.get(member.botId);
        return !!bot && !bot.archivedAt && bot.role?.id === owner.role;
      });
      if (matches.length !== 1) throw invalid(`${prefix}.steps.${index}.owner.role`);
    });
  }
  const canonical = JSON.stringify(parsed.data);
  if (canonical.length > SKILL_CONTRACT_MAX_CHARS) throw invalid(prefix);
  return canonical;
}

/**
 * Bot skills: metadata in `skills`, the text in `bots/<id>/skills/<slug>/SKILL.md`.
 * Writes are serialized so a file and its row never interleave with another change; the file is
 * written first and removed (or restored) when the row cannot be committed.
 */
export class SkillService {
  readonly repo: SkillRepository;
  readonly packages: SharedSkillPackages;
  readonly builtins: BuiltinSkillInstaller;
  readonly proposals: SkillProposals;
  readonly imports: SkillImports;
  readonly uploads: SkillUploads;
  readonly updates: SkillUpdatesRepo;
  readonly documentMetadata: SkillDocumentMetadataRepo;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  get canRelease() {
    return (
      this.pending === 0 && this.builtins.idle && !this.imports.retained && !this.uploads.retained
    );
  }
  constructor(
    readonly deps: SkillDeps,
    readonly groupId?: string,
    readonly prepareBuiltins?: (botId: string) => Promise<void>,
  ) {
    if (groupId && !deps.packages) throw new Error("skill_package_owner_required");
    this.packages = deps.packages ?? new SharedSkillPackages(deps.dataDir, deps.db, deps.logger);
    this.repo = groupId ? new GroupSkillsRepo(deps.db, groupId) : new SkillsRepo(deps.db);
    this.builtins = new BuiltinSkillInstaller(this);
    this.proposals = new SkillProposals(this);
    this.imports = new SkillImports(this, deps.host);
    this.uploads = new SkillUploads(deps.host);
    this.updates = new SkillUpdatesRepo(deps.db);
    this.documentMetadata = new SkillDocumentMetadataRepo(deps.db);
  }
  /** The editor's 「上传」 for one of this store's Bots. */
  pickFiles(botId: string, from: "file" | "folder", signal: AbortSignal) {
    this.activeBot(botId);
    return this.uploads.pick(from, signal);
  }
  async secretVariables(id: string, signal: AbortSignal): Promise<string[]> {
    const record = this.require(id);
    const { folder } = this.runtimeTarget(id);
    await this.readLocation(record, signal);
    const pack = await scanSkillPackage(folder, "folder", signal);
    return pack.summary.bindableEnvironmentVariables ?? [];
  }

  secretChoices(botId: string) {
    this.activeBot(botId);
    return this.deps.local?.userSecrets.choices?.(botId) ?? [];
  }

  secretBindings(id: string) {
    return this.deps.db
      .prepare(
        "SELECT variable, secret_name AS secretName FROM skill_secret_bindings WHERE scope = ? AND skill_id = ? ORDER BY variable",
      )
      .all(this.groupId ?? "", id) as { variable: string; secretName: string }[];
  }

  bindSecrets(
    record: SkillRecord,
    bindings: MethodParams["skills.setSecretBindings"]["bindings"],
    allowed: readonly string[],
  ) {
    if (record.builtinKey) throw invalid("skill_secret_invalid");
    this.validateSecretBindings(record.botId, bindings, allowed);
    transaction(this.deps.db, () => this.writeSecretBindings(record, bindings));
  }

  validateSecretBindings(
    botId: string,
    bindings: MethodParams["skills.setSecretBindings"]["bindings"],
    allowed: readonly string[],
  ) {
    for (const { variable, secretName } of bindings) {
      if (!isSafeSecretEnvName(variable)) throw invalid("skill_secret_invalid");
      if (secretName === null) continue;
      if (this.deps.local?.deps?.platform === "win32") throw invalid("skill_secret_windows");
      const meta = this.deps.local?.userSecrets.metadata(secretName);
      if (
        !allowed.includes(variable) ||
        !meta?.hasValue ||
        (meta.assignment.kind === "bots" && !meta.assignment.bots.includes(botId))
      )
        throw invalid("skill_secret_invalid");
    }
  }

  writeSecretBindings(
    record: SkillRecord,
    bindings: MethodParams["skills.setSecretBindings"]["bindings"],
  ) {
    const names = new Set(this.secretBindings(record.id).map(({ variable }) => variable));
    for (const { variable, secretName } of bindings) {
      if (secretName === null) names.delete(variable);
      else names.add(variable);
    }
    if (names.size > 64) throw invalid("skill_secret_invalid");
    for (const { variable, secretName } of bindings) {
      if (secretName === null) {
        this.deps.db
          .prepare(
            "DELETE FROM skill_secret_bindings WHERE scope = ? AND skill_id = ? AND variable = ?",
          )
          .run(this.groupId ?? "", record.id, variable);
      } else {
        this.deps.db
          .prepare(
            "INSERT INTO skill_secret_bindings (scope, skill_id, variable, secret_name) VALUES (?, ?, ?, ?) ON CONFLICT(scope, skill_id, variable) DO UPDATE SET secret_name = excluded.secret_name",
          )
          .run(this.groupId ?? "", record.id, variable, secretName);
      }
    }
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId: record.botId,
      kind: "skill.changed",
      summary: "Skill token bindings updated / 技能密钥设置已更新",
      detail: { actor: "user", target: record.name, reasonCode: "skill_secret_bindings" },
    });
  }
  /** One supporting file's text for the editor (read-only; binary gives null). */
  async readFile(
    id: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; text: string | null }> {
    const record = this.require(id);
    const location = await this.readLocation(record, signal);
    try {
      return {
        path,
        text: await readSupportingFile(this.deps.dataDir, record.botId, location, path, signal),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (
        error instanceof PackageError ||
        (error instanceof Error && error.message === "skill_path_unsafe")
      )
        throw invalid("skill_files_invalid");
      throw new RpcError(-32603, "skill_file_unavailable");
    }
  }
  /** Package files after an edit, from the saved ones (none for a new skill) and the changes. */
  private editedFiles(
    existing: readonly { path: string; data: Buffer }[],
    changes: readonly SkillFileChange[],
    text: string,
  ) {
    return applyFileChanges(existing, changes, Buffer.byteLength(text), {
      upload: (uploadId, path) => this.uploads.take(uploadId, path),
      redact: (value) => this.deps.redactor.redact(value),
    });
  }
  /** The methods this Bot's role ships (app resources); installed rows are ordinary skills. */
  builtinMethods(botId: string, language?: "zh" | "en") {
    this.activeBot(botId);
    return this.deps.builtinMethods?.(botId, language) ?? [];
  }
  location(record: SkillRecord) {
    if (record.packageId && !this.packages.has(record.packageId))
      throw new RpcError(-32603, "skill_file_unavailable");
    return {
      path: record.path,
      packageId: record.packageId,
      packageDataDir: this.packages.dataDir,
    };
  }
  async readLocation(record: SkillRecord, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (record.packageId && !this.packages.has(record.packageId)) {
      if (!(await this.packages.ensureReadable(record.packageId, signal)))
        throw new RpcError(-32603, "skill_file_unavailable");
      const current = this.require(record.id);
      if (current.packageId !== record.packageId || current.botId !== record.botId)
        throw new RpcError(-32603, "skill_file_unavailable");
    }
    return this.location(record);
  }
  async preparePromptPackages(botId: string, parent: AbortSignal) {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(SKILL_PACKAGE_VERIFY_TIMEOUT_MS)]);
    const ids = new Set(this.repo.enabledForPrompt(botId).map((record) => record.packageId));
    for (const id of ids) {
      signal.throwIfAborted();
      if (id) await this.packages.ensureReadable(id, signal);
    }
  }
  packageIds(botId: string): string[] {
    this.activeBot(botId);
    return [
      ...new Set(
        this.repo
          .enabledForPrompt(botId)
          .flatMap((row) =>
            row.packageId && this.packages.has(row.packageId) ? [row.packageId] : [],
          ),
      ),
    ].sort();
  }
  roots(botId: string): string[] {
    return [
      this.root(botId),
      ...this.packageIds(botId).map((id) => join(this.packages.dataDir, "skill-packages", id)),
    ];
  }
  root(botId: string) {
    return botSkillsRoot(this.deps.dataDir, botId);
  }
  exclusive<T>(action: () => Promise<T>, queueSignal?: AbortSignal): Promise<T> {
    this.pending++;
    const start = () => {
      // Cancellation only retracts work that has not entered its serialized write section. Once
      // started, the atomic file + transaction/rollback sequence must run to a definite outcome.
      queueSignal?.throwIfAborted();
      return action();
    };
    const next = this.queue.then(start, start);
    this.queue = next.catch(() => undefined);
    return next.finally(() => {
      this.pending--;
    });
  }
  async settled() {
    await this.builtins.settled();
    await this.queue;
  }
  list({ botId, enabled, builtin, ...page }: MethodParams["skills.list"]): Skill[] {
    this.activeBot(botId);
    return this.present(
      botId,
      this.repo.list(
        botId,
        {
          ...(enabled === undefined ? {} : { enabled }),
          ...(builtin === false ? { builtin } : {}),
        },
        page,
      ),
    );
  }
  roleSkillLabels(record: SkillRecord) {
    return record.source === "team"
      ? this.deps.roleSkillLabels?.(record.botId, record.name, record.description)
      : undefined;
  }
  /** 「有新版本」 is derived from what this build ships, so it is never stale in the database. */
  private present(botId: string, rows: readonly SkillRecord[]): Skill[] {
    const shipped = rows.some((row) => row.builtinState?.modified)
      ? new Map(this.builtinMethods(botId).map((method) => [method.key, method.document]))
      : undefined;
    const labels = this.builtinLabels(botId, rows);
    return rows.map((row) => {
      const display = row.builtinKey ? labels.get(row.builtinKey) : this.roleSkillLabels(row);
      const skill: Skill = {
        ...toSkill(row),
        ...(display ? { builtinLabels: display } : {}),
      };
      const latest = row.builtinKey ? shipped?.get(row.builtinKey)?.version : undefined;
      const state = skill.builtinState;
      // Only an edited copy is offered one, and not again for a version the user kept theirs over.
      if (
        !state?.modified ||
        latest === undefined ||
        latest <= (state.version ?? -1) ||
        latest <= (row.builtin?.keptVersion ?? -1)
      )
        return skill;
      return { ...skill, builtinState: { ...state, newVersion: latest } };
    });
  }
  /**
   * A built-in copy keeps the labels of the language it was installed in; the panel and
   * the connections page show the interface language instead. Both shipped versions are read from
   * the app resources (never from the copy), so the SKILL.md, its prompt entry and the prompt
   * cache stay exactly as installed.
   */
  private builtinLabels(botId: string, rows: readonly SkillRecord[]): Map<string, SkillLabels> {
    const keys = new Set(rows.flatMap((row) => (row.builtinKey ? [row.builtinKey] : [])));
    const partial = new Map<string, { zh?: SkillLabels["zh"]; en?: SkillLabels["en"] }>();
    for (const language of ["zh", "en"] as const) {
      if (!keys.size) break;
      for (const method of this.builtinMethods(botId, language))
        if (keys.has(method.key))
          partial.set(method.key, {
            ...partial.get(method.key),
            [language]: { name: method.document.name, description: method.document.description },
          });
    }
    const labels = new Map<string, SkillLabels>();
    for (const [key, value] of partial)
      if (value.zh && value.en) labels.set(key, { zh: value.zh, en: value.en });
    return labels;
  }
  require(id: string): SkillRecord {
    const record = this.repo.get(id);
    if (!record) throw invalid("skill_not_found");
    if (this.groupId) this.activeBot(record.botId);
    return record;
  }
  activeBot(botId: string) {
    if (this.groupId) requireGroupMember(this.deps, this.groupId, botId);
    const bot = new BotsRepo(this.deps.db).get(botId);
    if (!bot || bot.archivedAt) throw invalid("skill_bot_unavailable");
    return bot;
  }
  async get(
    id: string,
    signal?: AbortSignal,
    includeResources = true,
  ): Promise<{
    skill: Skill;
    document: SkillDocument;
    files: (SkillPackageFile & { text: boolean })[];
    compatibility?: SkillCompatibilityReport;
    update?: SkillUpdateState;
  }> {
    const record = this.require(id);
    const { document, sourceFields, fields } = await this.readDocument(record, signal);
    const [skill = toSkill(record)] = this.present(record.botId, [record]);
    const update = this.updateView(record.id);
    const detail = { skill, document, ...(update ? { update } : {}) };
    signal?.throwIfAborted();
    if (!includeResources) return { ...detail, files: [] };
    let files: (SkillPackageFile & { text: boolean })[] = [];
    let filesUnavailable = false;
    try {
      files = await listSkillFiles(this.deps.dataDir, record.botId, this.location(record), signal);
    } catch {
      signal?.throwIfAborted();
      // The document itself was readable; an unreadable extra file only hides the file list.
      filesUnavailable = true;
      this.deps.logger.warn(JSON.stringify({ module: "skills", event: "files_unreadable" }));
    }
    return {
      ...detail,
      files,
      compatibility: skillCompatibility({
        frontmatter: compatibilityFrontmatter(document.sourceFields ?? sourceFields),
        body: document.body,
        allowedTools: allowedToolValues(fields["allowed-tools"]),
        documents: await this.referencedDocuments(record, document, files, signal),
        files,
        filesUnavailable,
      }),
    };
  }
  /**
   * A skill's commands often live in the documents SKILL.md points at. Only the files the body
   * names are read, and a read failure only makes the advisory report poorer.
   */
  private async referencedDocuments(
    record: SkillRecord,
    document: SkillDocument,
    files: readonly (SkillPackageFile & { text: boolean })[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const texts: string[] = [];
    for (const file of files) {
      if (texts.length >= MAX_DOCUMENTS) break;
      if (!/\.(?:md|markdown)$/i.test(file.path)) continue;
      if (!document.body.includes(file.path) && !document.body.includes(basename(file.path)))
        continue;
      if (file.bytes > MAX_DOCUMENT_BYTES) continue;
      try {
        const text = await readSupportingFile(
          this.deps.dataDir,
          record.botId,
          this.location(record),
          file.path,
          signal,
        );
        if (text) texts.push(text);
      } catch {
        signal?.throwIfAborted();
        // Advisory only; an unreadable extra document must not hide the skill itself.
      }
    }
    return texts;
  }
  /** The recorded source version of one skill; null when it was not imported with a package. */
  updateView(id: string): SkillUpdateState | null {
    const state = this.updates.get(this.updateScope, id);
    if (!state) return null;
    return {
      sourceVersion: state.sourceVersion,
      digest: state.digest,
      importedAt: state.importedAt,
      checkedAt: state.checkedAt,
      available: state.pending ?? null,
      rollback: state.previous ?? null,
    };
  }
  /**
   * Publishes newer source bytes without touching any row. A check therefore never
   * changes what a Bot runs, and applying later needs neither the network nor the source again.
   */
  async publishUpdate(pack: ScannedSkillPackage, signal: AbortSignal, touch: () => void) {
    const parsed = parseSkillFile(pack.skillText);
    const imported = importedDocument(parsed, pack.folder);
    const document = this.clean({
      ...imported,
      sourceFields: imported.sourceFields ?? parsed.sourceFields,
    });
    const packageId = await this.packages.publish(
      await sourceSkillText(pack, signal, touch),
      [],
      (stage) => copyScannedSkillPackage(pack, stage, signal, touch),
      signal,
      touch,
    );
    const digest = this.packages.digest(packageId);
    if (!digest) throw new RpcError(-32603, "skill_package_invalid");
    return { packageId, digest, document };
  }
  /** Updates the recorded state alone (a check's outcome) under the write queue. */
  recordUpdateState(
    id: string,
    next: (current: SkillUpdateRecord | undefined, now: string) => SkillUpdateRecord,
    queueSignal?: AbortSignal,
    metadata?: { packageId: string; document: SkillDocument },
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = this.require(id);
      this.activeBot(record.botId);
      transaction(this.deps.db, () => {
        this.putUpdateState(record.id, next);
        if (metadata)
          this.documentMetadata.put(
            this.updateScope,
            id,
            metadata.packageId,
            this.clean(metadata.document),
          );
      });
    }, queueSignal);
  }
  /** The only place a skill's package reference moves; the trees themselves stay put. */
  switchPackage(
    id: string,
    packageId: string | undefined,
    next: (current: SkillUpdateRecord | undefined, now: string) => SkillUpdateRecord,
    counts: { files: number; scripts?: number } | undefined,
    queueSignal?: AbortSignal,
  ): Promise<void> {
    return this.exclusive(async () => {
      const record = this.require(id);
      this.activeBot(record.botId);
      // The retention window may have collected the package since the check or the update.
      if (packageId && !this.packages.has(packageId)) throw invalid("skill_update_expired");
      transaction(this.deps.db, () => {
        this.repo.setPackage(record.id, packageId);
        this.repo.touchUpdated(record.id);
        this.putUpdateState(record.id, next);
        this.audit(record.botId, record.name, "updated", undefined, counts);
      });
      this.changed(record.botId, "updated", record.id);
    }, queueSignal);
  }
  private putUpdateState(
    id: string,
    next: (current: SkillUpdateRecord | undefined, now: string) => SkillUpdateRecord,
  ) {
    const now = new Date().toISOString();
    this.updates.put(this.updateScope, id, next(this.updates.get(this.updateScope, id), now), now);
  }
  private get updateScope(): SkillUpdateScope {
    return this.groupId ? "group" : "bot";
  }
  /** Name and description come from the row (what the list shows); body and params from the file. */
  async document(record: SkillRecord, signal?: AbortSignal): Promise<SkillDocument> {
    return (await this.readDocument(record, signal)).document;
  }
  private async readDocument(record: SkillRecord, signal?: AbortSignal) {
    const location = await this.readLocation(record, signal);
    let parsed: ReturnType<typeof parseSkillFile>;
    try {
      parsed = parseSkillFile(
        await readSkillFile(this.deps.dataDir, record.botId, location, signal),
      );
    } catch {
      signal?.throwIfAborted();
      throw new RpcError(-32603, "skill_file_unavailable");
    }
    try {
      const saved = this.documentMetadata.get(this.updateScope, record.id, record.packageId);
      const metadata =
        saved ??
        (record.source === "imported"
          ? {
              ...importedDocument(parsed, record.name),
              ...storedWorkflow(parsed),
              sourceFields: storedWorkflow(parsed).sourceFields ?? parsed.sourceFields,
            }
          : { params: storedParams(parsed), ...storedWorkflow(parsed) });
      const document = this.clean({
        ...metadata,
        name: record.name,
        description: record.description,
        body: parsed.body,
      });
      return {
        document,
        sourceFields: document.sourceFields ?? parsed.sourceFields,
        fields: parsed.fields,
      };
    } catch {
      throw new RpcError(-32603, "skill_file_unavailable");
    }
  }
  preservesSource(record: SkillRecord): boolean {
    return (
      !record.builtinKey &&
      (record.source === "imported" ||
        this.documentMetadata.get(this.updateScope, record.id, record.packageId) !== undefined)
    );
  }
  private clean(input: SkillDocumentInput): SkillDocument {
    const parsed = SkillDocumentSchema.safeParse(redactValue(input, this.deps.redactor));
    if (!parsed.success) throw invalid("skill_invalid");
    return parsed.data;
  }
  /**
   * Saves a new skill for a Bot. Shared by the panel import, `skill_propose` confirmation, team
   * import and 「教它做一次」 (`source: "taught"`).
   */
  create(
    botId: string,
    input: SkillDocumentInput,
    source: SkillSource,
    options: {
      enabled?: boolean;
      uniqueName?: boolean;
      reason?: SkillChange;
      afterInsert?(record: SkillRecord): void;
      /** Supporting files of an imported package, saved next to SKILL.md in one atomic step. */
      files?: readonly PackageFile[];
      scannedPackage?: ScannedSkillPackage;
      /** In-memory plugin source; never a renderer-supplied option. */
      originalSkillText?: string;
      /** A private copy of an external skill keeps its original author header. */
      preserveSource?: boolean;
      /** Trusted catalog assignment only, never a wire parameter. */
      packageId?: string;
      importSource?: SkillImportSource;
      /** A team file's public reimport must reproduce the exact shared package. */
      expectedHash?: string;
      copySignal?: AbortSignal;
      onProgress?: (progress: SkillCopyProgress) => void;
      /**
       * Any step of the package write moved (the copy, but also the digest and seal passes that
       * report no file progress); lets a caller's own idle deadline follow the same work.
       */
      onActivity?: () => void;
      /** Supporting files written in the editor (text or uploads), saved the same way. */
      fileChanges?: readonly SkillFileChange[];
      /** Preferred folder name (a `.pibot` package's own); falls back to one made from the name. */
      folder?: string;
      /** Recheck the originating run after the serialized/file-write waits. */
      assertCurrent?: () => void;
      /** An interactive caller may withdraw while this write is still waiting for the queue. */
      queueSignal?: AbortSignal;
      builtin?: { key: string; digest: string; version: number };
      automatic?: { runId: string; toolCallId: string; conversationId?: string };
      /** The app's built-in sync rather than the user: recorded as such in the audit trail. */
      actor?: "system";
      /** The passed plan run this group workflow was saved from (already verified). */
      savedFromPlan?: { workflowRunId: string };
    } = {},
  ): Promise<Skill> {
    if (!options.builtin && this.prepareBuiltins) {
      this.pending++;
      return this.prepareBuiltins(botId)
        .then(() => this.createPrepared(botId, input, source, options))
        .finally(() => {
          this.pending--;
        });
    }
    return this.createPrepared(botId, input, source, options);
  }
  private createPrepared(
    botId: string,
    input: SkillDocumentInput,
    source: SkillSource,
    options: Parameters<SkillService["create"]>[3] = {},
  ): Promise<Skill> {
    return this.exclusive(async () => {
      options.assertCurrent?.();
      this.activeBot(botId);
      const document = this.clean(input);
      const sourceText = options.scannedPackage?.skillText ?? options.originalSkillText;
      if (source === "imported" && sourceText !== undefined && document.sourceFields === undefined)
        document.sourceFields = parseSkillFile(sourceText).sourceFields;
      const packageDocument = { ...document };
      const preserveSource = !options.builtin && (source === "imported" || options.preserveSource);
      if (options.uniqueName) {
        const base = document.name;
        let n = 2;
        while (this.repo.findByName(botId, document.name)) {
          if (n > 1000) throw invalid("skill_name_exists");
          const suffix = ` (${n++})`;
          document.name = `${base.slice(0, 80 - suffix.length)}${suffix}`;
        }
      } else if (this.repo.findByName(botId, document.name)) throw invalid("skill_name_exists");
      const dir = this.freeDir(botId, document.name, options.folder);
      const text = renderSkillFile(dir.slice("skills/".length), document);
      const files = options.fileChanges?.length
        ? this.editedFiles([], options.fileChanges, text)
        : options.files;
      let write: PackageWrite | undefined;
      let packageId = options.packageId;
      if (packageId && (source !== "imported" || !this.packages.has(packageId)))
        throw invalid("skill_package_invalid");
      if (packageId) {
        const id = packageId;
        await withProgressDeadline(
          options.copySignal ?? options.queueSignal ?? new AbortController().signal,
          (signal, touch) => this.packages.reuse(id, signal, touch),
        );
      }
      if (source === "imported" && !options.builtin && !packageId) {
        const pack = options.scannedPackage;
        packageId = await withProgressDeadline(
          options.copySignal ?? options.queueSignal ?? new AbortController().signal,
          async (signal, ownTouch) => {
            const touch = () => {
              ownTouch();
              options.onActivity?.();
            };
            return this.packages.publish(
              pack
                ? await sourceSkillText(pack, signal, touch)
                : (options.originalSkillText ?? text),
              files ?? [],
              pack
                ? (stage) =>
                    copyScannedSkillPackage(pack, stage, signal, (value) => {
                      touch();
                      options.onProgress?.(value);
                    })
                : undefined,
              signal,
              touch,
              options.expectedHash,
            );
          },
          pack?.summary.fileCount,
          pack?.totalBytes,
        );
      } else if (!packageId && options.scannedPackage) {
        const pack = options.scannedPackage;
        write = await withProgressDeadline(
          options.copySignal ?? new AbortController().signal,
          async (signal, touch) =>
            writeSkillPackage(
              this.deps.dataDir,
              botId,
              dir,
              preserveSource ? await sourceSkillText(pack, signal, touch) : text,
              [],
              (staging) =>
                copyScannedSkillPackage(pack, staging, signal, (value) => {
                  touch();
                  options.onProgress?.(value);
                }),
              signal,
            ),
          pack.summary.fileCount,
          pack.totalBytes,
        );
      } else if (!packageId && files?.length)
        write = await writeSkillPackage(this.deps.dataDir, botId, dir, text, files);
      else if (!packageId) await writeSkillFile(this.deps.dataDir, botId, dir, text);
      const counts = options.scannedPackage
        ? {
            files: options.scannedPackage.summary.fileCount,
            scripts: options.scannedPackage.summary.scriptCount,
          }
        : files && {
            files: files.length + 1,
            scripts: files.filter((file) => file.script).length,
          };
      let record: SkillRecord;
      try {
        record = transaction(this.deps.db, () => {
          options.copySignal?.throwIfAborted();
          options.assertCurrent?.();
          this.activeBot(botId);
          const created = this.repo.create({
            botId,
            name: document.name,
            description: document.description,
            source,
            enabled: options.enabled ?? true,
            path: dir,
            packageId,
            importSource: options.importSource,
          });
          if (options.builtin) {
            new BuiltinSkillsRepo(this.deps.db, this.groupId).bind(
              created.id,
              options.builtin.key,
              {
                digest: options.builtin.digest,
                version: options.builtin.version,
                modified: false,
              },
            );
            created.builtinKey = options.builtin.key;
            created.builtinState = { version: options.builtin.version, modified: false };
          }
          if (options.savedFromPlan) {
            if (!(this.repo instanceof GroupSkillsRepo)) throw invalid("skill_saved_plan_group");
            this.repo.markSavedFromPlan(created.id, options.savedFromPlan.workflowRunId);
            created.savedFromPlan = { workflowRunId: options.savedFromPlan.workflowRunId };
          }
          if (preserveSource)
            this.documentMetadata.put(this.updateScope, created.id, packageId, packageDocument);
          options.afterInsert?.(created);
          // Record the source content a later 「检查更新」 compares against.
          if (source === "imported" && packageId) {
            const digest = this.packages.digest(packageId);
            if (digest)
              this.updates.put(
                this.updateScope,
                created.id,
                {
                  // Source versions may be semantic strings; Pi Bot's workflow counter is separate.
                  sourceVersion:
                    packageDocument.sourceVersion ??
                    (packageDocument.version === undefined
                      ? null
                      : String(packageDocument.version)),
                  digest,
                  importedAt: new Date().toISOString(),
                  checkedAt: null,
                },
                new Date().toISOString(),
              );
          }
          this.audit(
            botId,
            document.name,
            options.reason ?? "created",
            options.automatic?.runId,
            counts,
            options.automatic,
            options.actor,
          );
          return created;
        });
      } catch (error) {
        if (write) await write.rollback().catch(() => this.discardFolder(botId, dir));
        else if (!packageId) await this.discardFolder(botId, dir);
        if (error instanceof TypeError && error.message === "Skill name exists")
          throw invalid("skill_name_exists");
        throw error;
      }
      await this.settleWrite(write);
      this.uploads.release(uploadIdsOf(options.fileChanges));
      this.changed(botId, "created", record.id);
      return toSkill(record);
    }, options.queueSignal);
  }
  /** The row committed; a leftover backup is only disk space, and the next write recovers it. */
  private async settleWrite(write: PackageWrite | undefined) {
    await write
      ?.commit()
      .catch(() =>
        this.deps.logger.warn(JSON.stringify({ module: "skills", event: "backup_not_removed" })),
      );
  }
  private freeDir(botId: string, name: string, folder?: string) {
    // A team or built-in package keeps its folder name (readable, stable) when it is a valid slug.
    const base =
      folder && SkillDirSchema.safeParse(`skills/${folder}`).success ? folder : skillSlug(name);
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? "" : `-${n}`;
      const dir = `skills/${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!this.repo.pathTaken(botId, dir)) return dir;
    }
    throw new RpcError(-32603, "skill_folder_unavailable");
  }
  private async discardFolder(botId: string, dir: string) {
    try {
      await removeSkillFolder(this.deps.dataDir, botId, dir);
    } catch {
      this.deps.logger.warn(JSON.stringify({ module: "skills", event: "orphan_folder", botId }));
    }
  }
  copyAsOwn(id: string, botId: string, signal: AbortSignal): Promise<Skill> {
    return copySkillAsOwn(
      {
        require: (id) => this.require(id),
        activeBot: (id) => this.activeBot(id),
        folder: (row) => skillFolder(this.deps.dataDir, row.botId, this.location(row)),
        document: (row) => this.document(row, signal),
        create: this.create.bind(this),
        preservesSource: (row) => this.preservesSource(row),
      },
      id,
      botId,
      signal,
    );
  }
  update(
    id: string,
    patch: SkillDocumentPatch,
    queueSignal?: AbortSignal,
    /** Supporting-file edits; without them only SKILL.md is rewritten, as before. */
    fileChanges?: readonly SkillFileChange[],
  ): Promise<Skill> {
    return this.exclusive(async () => {
      const record = this.require(id);
      this.activeBot(record.botId);
      if (record.packageId) {
        return editSharedSkill(
          {
            dataDir: this.deps.dataDir,
            db: this.deps.db,
            repo: this.repo,
            require: (id) => this.require(id),
            activeBot: (id) => this.activeBot(id),
            folder: (row) => skillFolder(this.deps.dataDir, row.botId, this.location(row)),
            document: (row) => this.document(row, queueSignal),
            clean: (input) => this.clean(input),
            saveMetadata: (row, packageId, document) =>
              this.documentMetadata.put(this.updateScope, row.id, packageId, document),
            canonicalContract: (input) =>
              canonicalWorkflowContract(input, "patch.contract", {
                db: this.deps.db,
                groupId: this.groupId,
              }),
            editedFiles: this.editedFiles.bind(this),
            audit: (id, name) => this.audit(id, name, "updated"),
            settleWrite: (write) => this.settleWrite(write),
            release: (changes) => this.uploads.release(uploadIdsOf(changes)),
            changed: (id, skill) => this.changed(id, "updated", skill),
          },
          record,
          patch,
          queueSignal,
          fileChanges,
        );
      }
      const before = await readSkillFile(
        this.deps.dataDir,
        record.botId,
        this.location(record),
      ).catch(() => undefined);
      const current = before === undefined ? undefined : await this.document(record);
      if (!current && (patch.body === undefined || patch.contract !== undefined))
        throw new RpcError(-32603, "skill_file_unavailable");
      const { contract, ...fields } = patch;
      const next = this.clean({
        name: record.name,
        description: record.description,
        body: "",
        params: [],
        ...current,
        ...fields,
        ...(contract === undefined
          ? {}
          : {
              contract: canonicalWorkflowContract(contract, "patch.contract", {
                db: this.deps.db,
                groupId: this.groupId,
              }),
              version: (current?.version ?? 0) + 1,
              verified: undefined,
            }),
      } as SkillDocumentInput);
      const clash = this.repo.findByName(record.botId, next.name);
      if (clash && clash.id !== record.id) throw invalid("skill_name_exists");
      const preserveSource = this.preservesSource(record);
      const bodyChanged = patch.body !== undefined && patch.body !== current?.body;
      const writeText = !preserveSource || bodyChanged || before === undefined;
      const slug = record.path.slice("skills/".length);
      const text =
        preserveSource && before !== undefined
          ? bodyChanged
            ? replaceImportedBody(before, next.body)
            : before
          : renderSkillFile(slug, next);
      let write: PackageWrite | undefined;
      let files: PackageFile[] | undefined;
      let editedCounts: { files: number; scripts?: number } | undefined;
      if (fileChanges?.length) {
        write = await withProgressDeadline(
          queueSignal ?? new AbortController().signal,
          async (signal, touch) => {
            if (before === undefined) {
              // Preserve the editor's bounded recovery path when SKILL.md itself was lost.
              const saved = await readSkillPackageFiles(
                this.deps.dataDir,
                record.botId,
                record.path,
                signal,
              ).catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
                throw new RpcError(-32603, "skill_file_unavailable");
              });
              files = this.editedFiles(saved, fileChanges, text);
              editedCounts = {
                files: files.length + 1,
                scripts: files.filter((file) => file.script).length,
              };
              return writeSkillPackage(
                this.deps.dataDir,
                record.botId,
                record.path,
                text,
                files,
                undefined,
                signal,
              );
            }
            const folder = skillFolder(this.deps.dataDir, record.botId, record.path);
            const saved =
              fileChanges.length === 1 && before !== undefined
                ? undefined
                : await scanSkillPackage(folder, "folder", signal, touch);
            const metadata =
              saved?.files ??
              (await folderEntries(folder, signal, touch)).files.filter(
                (entry) => entry.path !== "SKILL.md" && !entry.path.startsWith(".SKILL.md."),
              );
            files = this.editedFiles([], fileChanges, text);
            const changed = new Set(
              fileChanges.map((change) => change.path.normalize("NFC").toLowerCase()),
            );
            const kept = metadata.filter((file) => !changed.has(file.path.toLowerCase()));
            const all = [
              ...kept,
              ...files.map((file) => ({ path: file.path, bytes: file.data.length })),
            ];
            editedCounts = {
              files: all.length + 1,
              ...(saved
                ? {
                    scripts: [
                      ...saved.files.filter((file) => !changed.has(file.path.toLowerCase())),
                      ...files,
                    ].filter((file) => file.script).length,
                  }
                : {}),
            };
            const names = new Set(all.map((file) => file.path.toLowerCase()));
            for (const file of all) {
              const parts = file.path.toLowerCase().split("/");
              for (let i = 1; i < parts.length; i++)
                if (names.has(parts.slice(0, i).join("/"))) throw invalid("skill_files_invalid");
            }
            if (all.length + 1 > SKILL_IMPORT_MAX_FILES)
              throw invalid("skill_import_too_many_files");
            if (
              all.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(text)) >
              SKILL_IMPORT_MAX_BYTES
            )
              throw invalid("skill_import_too_large");
            if (!saved && before !== undefined) {
              const old = metadata.find((file) => changed.has(file.path.toLowerCase()));
              return writeSkillAttachment(
                this.deps.dataDir,
                record.botId,
                record.path,
                text,
                before,
                old,
                files[0],
                signal,
                touch,
              );
            }
            if (!saved) throw new Error("skill_file_unavailable");
            const pack = {
              ...saved,
              files: saved.files.filter((file) => !changed.has(file.path.toLowerCase())),
            };
            return writeSkillPackage(
              this.deps.dataDir,
              record.botId,
              record.path,
              text,
              files,
              (staging) => copyScannedSkillPackage(pack, staging, signal, touch),
              signal,
            );
          },
        );
      } else if (writeText)
        await writeSkillFile(this.deps.dataDir, record.botId, record.path, text);
      let updated: SkillRecord;
      try {
        updated = transaction(this.deps.db, () => {
          queueSignal?.throwIfAborted();
          const result = this.repo.updateMeta(record.id, {
            name: next.name,
            description: next.description,
          });
          if (preserveSource)
            this.documentMetadata.put(this.updateScope, record.id, undefined, next);
          this.repo.touchUpdated(record.id);
          this.audit(record.botId, next.name, "updated", undefined, editedCounts);
          return result;
        });
      } catch (error) {
        const restore = write
          ? write.rollback()
          : writeText && before !== undefined
            ? writeSkillFile(this.deps.dataDir, record.botId, record.path, before)
            : undefined;
        await restore?.catch(() =>
          this.deps.logger.warn(JSON.stringify({ module: "skills", event: "restore_failed" })),
        );
        if (error instanceof TypeError && error.message === "Skill name exists")
          throw invalid("skill_name_exists");
        throw error;
      }
      await this.settleWrite(write);
      this.uploads.release(uploadIdsOf(fileChanges));
      // An edited built-in method keeps the user's text; 「已修改」 and later 「有新版本」 follow.
      await this.builtins.refreshModified(updated, queueSignal ?? new AbortController().signal);
      this.changed(record.botId, "updated", record.id);
      return toSkill(this.repo.get(updated.id) ?? updated);
    }, queueSignal);
  }
  setEnabled(id: string, enabled: boolean): Skill {
    const record = this.require(id);
    const updated = transaction(this.deps.db, () => {
      const result = this.repo.setEnabled(record.id, enabled);
      if (!result) throw invalid("skill_not_found");
      this.audit(record.botId, record.name, enabled ? "enabled" : "disabled");
      return result;
    });
    this.changed(record.botId, enabled ? "enabled" : "disabled", record.id);
    return toSkill(updated);
  }
  remove(id: string): Promise<{ ok: true }> {
    return this.exclusive(async () => {
      const record = transaction(this.deps.db, () => {
        this.require(id);
        return this.removeRow(id);
      });
      await this.afterRemove(record);
      return { ok: true as const };
    });
  }
  /**
   * The database half of a delete, for a caller that removes several copies in one transaction
   * (inside this store's `exclusive`). Membership is not checked: a copy a former member left
   * behind is still deletable.
   */
  removeRow(id: string): SkillRecord {
    const removed = this.repo.remove(id);
    if (!removed) throw invalid("skill_not_found");
    this.deps.db
      .prepare("DELETE FROM skill_secret_bindings WHERE scope = ? AND skill_id = ?")
      .run(this.groupId ?? "", id);
    // A deleted method is not installed again until 「恢复自带方法」.
    if (removed.builtinKey)
      new BuiltinSkillsRepo(this.deps.db, this.groupId).markRemoved(
        removed.botId,
        removed.builtinKey,
      );
    this.audit(removed.botId, removed.name, "removed");
    return removed;
  }
  /** Only after the rows are committed: the row is gone, so a lingering folder is never offered. */
  async afterRemove(record: SkillRecord) {
    if (!record.packageId) await this.discardFolder(record.botId, record.path);
    this.changed(record.botId, "removed", record.id);
  }
  /**
   * Every own skill with a fingerprint of what is on disk (same function the built-in
   * history uses), read without following links. Unreadable files give null, i.e. "changed".
   */
  // Shared rows fingerprint the immutable source bytes, deliberately ignoring display-only renames.
  async inventory(
    botId: string,
    signal: AbortSignal,
    options?: { skipSharedContent?: boolean },
  ): Promise<SkillInventoryItem[]> {
    this.activeBot(botId);
    const items: SkillInventoryItem[] = [];
    for (const record of this.repo.forExport(botId)) {
      signal.throwIfAborted();
      const folder = record.path.slice("skills/".length);
      let fingerprint: string | null = null;
      let version: number | null = null;
      try {
        if (!record.packageId || !options?.skipSharedContent) {
          const location = await this.readLocation(record, signal);
          const text = await readSkillFile(this.deps.dataDir, botId, location, signal);
          const files = (
            await skillResourceDigests(
              (
                await folderEntries(skillFolder(this.deps.dataDir, botId, location), signal)
              ).files,
              signal,
            )
          ).filter((entry) => entry.path !== "SKILL.md" && !entry.path.startsWith(".SKILL.md."));
          const sourceDocument = importedDocument(parseSkillFile(text), folder);
          // Display-only renames do not change source identity; app params/contracts still do.
          const metadata = this.documentMetadata.get(this.updateScope, record.id, record.packageId);
          const document = { ...sourceDocument, ...metadata };
          fingerprint = skillFingerprint(document, files);
          version = document.version ?? null;
        }
      } catch {
        signal.throwIfAborted();
        // Missing or unreadable files cannot be shown to be unchanged; the caller keeps them.
      }
      items.push({
        id: record.id,
        folder,
        name: record.name,
        source: record.source,
        fingerprint,
        version,
      });
    }
    return items;
  }
  /**
   * A built-in update swaps one skill's package in place (same row, folder and enabled
   * switch). The name clash is checked before any file is touched; the change is audited.
   */
  replace(
    botId: string,
    id: string,
    input: SkillDocumentInput,
    files: readonly PackageFile[],
    queueSignal?: AbortSignal,
    reason: SkillChange = "updated",
    /** Set for the app's built-in sync: the audit line must not claim the user replaced it. */
    actor?: "system",
  ): Promise<Skill> {
    return this.exclusive(async () => {
      const record = this.require(id);
      if (record.botId !== botId) throw invalid("skill_not_found");
      this.activeBot(botId);
      const document = this.clean(input);
      const clash = this.repo.findByName(botId, document.name);
      if (clash && clash.id !== record.id) throw invalid("skill_name_exists");
      const slug = record.path.slice("skills/".length);
      const write = await writeSkillPackage(
        this.deps.dataDir,
        botId,
        record.path,
        renderSkillFile(slug, document),
        files,
      );
      let updated: SkillRecord;
      try {
        updated = transaction(this.deps.db, () => {
          const result = this.repo.updateMeta(record.id, {
            name: document.name,
            description: document.description,
          });
          this.repo.touchUpdated(record.id);
          if (record.packageId) this.repo.setPackage(record.id, undefined);
          this.audit(
            botId,
            document.name,
            reason,
            undefined,
            {
              files: files.length + 1,
              scripts: files.filter((file) => file.script).length,
            },
            undefined,
            actor,
          );
          return result;
        });
      } catch (error) {
        await write
          .rollback()
          .catch(() =>
            this.deps.logger.warn(JSON.stringify({ module: "skills", event: "restore_failed" })),
          );
        throw error;
      }
      await this.settleWrite(write);
      this.changed(botId, "updated", record.id);
      return toSkill(this.repo.get(updated.id) ?? updated);
    }, queueSignal);
  }
  /** Removal on behalf of a built-in update, limited to the named Bot's own skill. */
  async removeOwn(botId: string, id: string): Promise<void> {
    if (this.require(id).botId !== botId) throw invalid("skill_not_found");
    await this.remove(id);
  }
  /**
   * Enabled skills for one run's system prompt; a disabled skill disappears next run. A
   * built-in method is one of these rows, so each method reaches the Bot exactly once.
   */
  promptEntries(botId: string): SkillPromptEntry[] {
    return this.repo
      .enabledForPrompt(botId)
      .filter((record) => !record.packageId || this.packages.has(record.packageId))
      .map((record) => ({
        name: this.deps.redactor.redact(record.name),
        description: this.deps.redactor.redact(record.description),
        filePath: skillFilePath(this.deps.dataDir, botId, this.location(record)),
        baseDir: skillFolder(this.deps.dataDir, botId, this.location(record)),
        provenance: skillProvenance(record),
      }));
  }
  /** The skill whose SKILL.md is `path` (already canonical, from the read_file gate). */
  skillAt(botId: string, path: string): SkillRecord | undefined {
    const shared = this.repo
      .enabledForPrompt(botId)
      .find(
        (record) =>
          record.packageId &&
          this.packages.has(record.packageId) &&
          skillFilePath(this.deps.dataDir, botId, this.location(record)) === path,
      );
    if (shared) return shared;
    const inside = relative(this.root(botId), path);
    const parts = inside.split(sep);
    if (parts.length !== 2 || parts[1] !== "SKILL.md" || inside.startsWith("..")) return undefined;
    try {
      return this.repo.findByPath(botId, `skills/${parts[0]}`);
    } catch {
      return undefined;
    }
  }
  markUsed(record: SkillRecord) {
    this.repo.markUsed(record.id);
    // An open profile panel shows "last used"; without an event it stays at "never".
    this.changed(record.botId, "updated", record.id);
  }
  /** Every skill of a Bot for a `.pibot` v2 file; unreadable files are skipped, not invented. */
  async exportDocuments(botId: string): Promise<TeamSkill[]> {
    const skills: TeamSkill[] = [];
    for (const record of this.repo.forExport(botId)) {
      try {
        skills.push({ ...(await this.document(record)), enabled: record.enabled });
      } catch {
        this.deps.logger.warn(JSON.stringify({ module: "skills", event: "export_skipped", botId }));
      }
    }
    return skills;
  }
  /**
   * `.pibot` v3: every skill of a Bot with its supporting files, read without following
   * links (the same reader as a folder import). An unreadable skill is skipped, not invented.
   */
  exportPackages(
    botId: string,
    signal: AbortSignal,
    budget?: { bytes: number; files: number },
    options?: { source?: "team" },
  ) {
    return exportSkillPackages(
      {
        records: this.repo
          .forExport(botId)
          .filter((row) => !options?.source || row.source === options.source),
        document: (row) => this.document(row, signal),
        folder: (row) => skillFolder(this.deps.dataDir, botId, this.location(row)),
        digest: (id) => this.packages.digest(id),
        warn: () =>
          this.deps.logger.warn(
            JSON.stringify({ module: "skills", event: "export_skipped", botId }),
          ),
      },
      signal,
      budget,
    );
  }
  /**
   * What a runtime environment is built for. Resolved from the same row the detail view
   * uses, so a group skill gets the group's folder and the group id reaches the sandbox config.
   */
  runtimeTarget(id: string): {
    skillId: string;
    botId: string;
    name: string;
    folder: string;
    groupId?: string;
  } {
    const record = this.require(id);
    return {
      skillId: record.id,
      botId: record.botId,
      name: record.name,
      folder: skillFolder(this.deps.dataDir, record.botId, this.location(record)),
      ...(this.groupId ? { groupId: this.groupId } : {}),
    };
  }
  /** `counts` (imported packages) records how many files and scripts were saved, never content. */
  audit(
    botId: string,
    name: string,
    reason: SkillChange,
    runId?: string,
    counts?: { files: number; scripts?: number },
    automatic?: { toolCallId: string; conversationId?: string },
    /** `system` = the app's built-in sync, so the record does not claim the user did it. */
    actor?: "system",
  ) {
    new AuditRepo(this.deps.db, this.deps.redactor).append({
      botId,
      ...(runId ? { runId } : {}),
      kind: "skill.changed",
      summary: `Skill ${reason} / 技能变更`,
      detail: {
        ...(this.groupId ? { groupId: this.groupId } : {}),
        target: name.slice(0, 200),
        reasonCode: automatic ? "yolo" : reason,
        actor: actor ?? (automatic || reason === "proposed" ? "automatic" : "user"),
        ...(automatic
          ? { toolCallId: automatic.toolCallId, conversationId: automatic.conversationId }
          : {}),
        ...(counts
          ? {
              fileCount: counts.files,
              ...(counts.scripts === undefined ? {} : { scriptCount: counts.scripts }),
            }
          : {}),
      },
    });
  }
  changed(
    botId: string,
    reason: "created" | "updated" | "removed" | "enabled" | "disabled" | "proposed" | "resolved",
    skillId?: string,
    extra: { proposalId?: string; messageId?: string } = {},
  ) {
    this.deps.peer.emit("skills.changed", {
      ...(this.groupId ? { groupId: this.groupId } : {}),
      botId,
      reason,
      ...(skillId ? { skillId } : {}),
      ...extra,
    });
  }
}
