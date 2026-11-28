import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { samePathSpelling, windowsHostNames, windowsPathName } from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import {
  type ExecutionLocationTarget,
  type FolderSelection,
  FolderSelectionSchema,
  IdSchema,
  type ResolvedWorkplace,
  RpcError,
  type WorkingFolder,
  type Workplaces,
} from "@pibot/protocol-base";
import {
  BotsRepo,
  ConversationsRepo,
  GroupsRepo,
  ManagedWorktreesRepo,
  TopicFoldersRepo,
  TopicsRepo,
  WorkplacesRepo,
} from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { BrainHost } from "../../index.ts";
import type { ExecutionTargets } from "./execution-targets.ts";
import { refuseFolderCapacity } from "./folder-capacity.ts";
import { ensureOwnHome } from "./own-home.ts";
import { runnerWorkplace } from "./runner-workplace.ts";
import { workspaceBoundary } from "./workspace-boundary.ts";

type FolderRole = "primary" | "readonly" | "writable";
type RoleFolder = WorkingFolder & { role: FolderRole };
/** A folder that no longer exists, named for the person (never its full path). */
export interface GoneFolder {
  id: string;
  name: string;
}

/** Explicit topic roots are an authority ceiling, independent of the Bot's used-folder registry. */
export interface SelectionContext {
  selection: FolderSelection;
  /** The owner's revision (topic `workplace_revision`, or the registry's for Bot-level reads). */
  revision?: number;
}

export class WorkplaceService {
  beforeChange?: (botId: string) => Promise<() => void>;
  readonly repo: WorkplacesRepo;
  readonly topics: TopicFoldersRepo;
  private readonly bots: BotsRepo;
  constructor(
    private readonly db: DatabaseSync,
    private readonly dataDir: string,
    private readonly host: BrainHost,
    private readonly shutdown: AbortSignal,
    private readonly platform: "darwin" | "linux" | "win32",
    private readonly executionLocation?: {
      target: ExecutionLocationTarget;
      platform: "darwin" | "linux" | "win32";
    },
    private readonly blockedFolders?: (
      value: Workplaces,
      signal: AbortSignal,
    ) => Promise<Set<string>>,
    private readonly targets?: ExecutionTargets,
    private readonly assertWritable?: (
      paths: readonly string[],
      home: string,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    this.repo = new WorkplacesRepo(db, dataDir);
    this.topics = new TopicFoldersRepo(db);
    this.bots = new BotsRepo(db);
  }
  /** Every folder a Bot can write to in this install; an SSH Include there must be refused. */
  workplaceRoots(): string[] {
    return this.bots
      .list()
      .flatMap((bot) => [this.repo.home(bot.id), ...this.repo.allPaths(bot.id)]);
  }
  /** The Bot's visible "used folders" registry, after making sure its own home is sound. */
  async list(botId: string, parent = this.shutdown): Promise<Workplaces> {
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
    return this.withBlocked(await this.registered(botId, signal), signal);
  }
  private async registered(botId: string, signal: AbortSignal): Promise<Workplaces> {
    await this.botHome(botId, signal);
    return this.repo.list(botId);
  }
  async botHome(botId: string, parent = this.shutdown): Promise<string> {
    if (!this.bots.get(botId)) throw new RpcError(-32602, "Unknown Bot");
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
    await ensureOwnHome(this.dataDir, ["bots", botId, "home"], signal);
    return this.repo.home(botId);
  }
  async groupHome(groupId: string, parent = this.shutdown) {
    IdSchema.parse(groupId);
    if (!new GroupsRepo(this.db).get(groupId)) throw new RpcError(-32602, "Unknown group");
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
    return ensureOwnHome(this.dataDir, ["groups", groupId, "home"], signal);
  }
  private async withBlocked(value: Workplaces, signal: AbortSignal): Promise<Workplaces> {
    const blocked = await this.blockedFolders?.(value, signal);
    return {
      ...value,
      folders: value.folders.map((folder) => ({
        ...folder,
        ...(blocked?.has(folder.id) ? { commandReadBlocked: true } : {}),
      })),
    };
  }
  /** The system dialog's choice as a canonical directory, or null when cancelled. */
  private async pickPath(
    create: boolean,
    parent: AbortSignal,
    defaultPath?: string,
  ): Promise<{ path: string; displayPath?: string } | null> {
    if (!this.host.pickFolder) throw new RpcError(-32603, "Folder picker unavailable");
    // The host allows ten minutes in the dialog plus a short canonical-path check.
    const picking = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(630_000)]);
    const selected = await abortable(
      this.host.pickFolder(picking, { create, defaultPath }),
      picking,
    );
    picking.throwIfAborted();
    if (!selected) return null;
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
    if (!isAbsolute(selected) || /[\p{Cc}\p{Cf}]/u.test(selected))
      throw new RpcError(-32602, "Invalid folder");
    const path = await abortable(realpath(selected), signal);
    if (!(await abortable(stat(path), signal)).isDirectory())
      throw new RpcError(-32602, "Not a directory");
    signal.throwIfAborted();
    return {
      path: this.spelling(path),
      ...(this.platform === "win32" && !samePathSpelling(resolve(selected), path)
        ? { displayPath: this.spelling(selected) }
        : {}),
    };
  }
  /**
   * One spelling per folder: on Windows an admin share of this machine (`\\localhost\c$\...`) opens
   * the same files as its drive path, but the sensitive boundaries are spelled with the drive, so an
   * alias root hid them. Another machine's share keeps its spelling.
   */
  private spelling(path: string): string {
    if (this.platform !== "win32") return path;
    const name = windowsPathName(path, windowsHostNames(hostname()));
    return name.kind === "drive" ? name.path : path;
  }
  /**
   * Registers the folder the user picks ("used folders"); binding it to a topic, routine or
   * draft is the caller's next step, so registering changes no run's boundary.
   */
  async pick(
    botId: string,
    create = false,
    remote?: { location?: string; path?: string },
    parent = this.shutdown,
    defaultPath?: string,
    association: "user" | "monitor" | "session" = "user",
  ): Promise<{ folder: WorkingFolder | null }> {
    await this.list(botId, parent);
    if (remote?.location) {
      if (!/^runner:[a-f0-9]{64}$/.test(remote.location) || !remote.path || create || !this.targets)
        throw new RpcError(-32602, "runner_folder_invalid");
      const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
      const entry = this.targets.require(remote.location);
      const canonical = await entry.target.canonicalizePath(remote.path, remote.path, signal);
      if (!canonical.device || !canonical.inode)
        throw new RpcError(-32602, "runner_folder_invalid");
      await entry.target.listDir({
        path: canonical.path,
        cwd: canonical.path,
        signal,
        writeRoots: [],
        rootIdentities: [
          {
            canonicalPath: canonical.path,
            device: canonical.device,
            inode: canonical.inode,
            role: "readonly",
          },
        ],
      });
      signal.throwIfAborted();
      try {
        return {
          folder: this.repo.register(
            botId,
            canonical.path,
            canonical.path,
            association,
            remote.location,
          ),
        };
      } catch (error) {
        refuseFolderCapacity(error);
      }
    }
    if (remote?.path) throw new RpcError(-32602, "runner_folder_invalid");
    const selected = await this.pickPath(create, parent, defaultPath);
    parent.throwIfAborted();
    if (!selected) return { folder: null };
    const { path, displayPath } = selected;
    if (!this.bots.get(botId)) throw new RpcError(-32602, "Unknown Bot");
    if (displayPath) {
      const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
      await this.assertWritable?.([path], this.repo.home(botId), signal);
      signal.throwIfAborted();
    }
    return {
      folder: this.registerLocal(botId, { path, displayPath: displayPath ?? null }, association),
    };
  }
  /** Persists a local folder already resolved by a picker or confirmed dispatch. */
  registerLocal(
    botId: string,
    { path, displayPath }: { path: string; displayPath?: string | null },
    association: "user" | "monitor" | "session" = "user",
  ): WorkingFolder {
    try {
      return this.repo.register(
        botId,
        path,
        basename(path) || path,
        association,
        "local",
        displayPath,
      );
    } catch (error) {
      return refuseFolderCapacity(error);
    }
  }
  /** @deprecated Registers the picked folder and returns the registry (older clients). */
  async add(botId: string): Promise<Workplaces> {
    await this.pick(botId);
    return this.list(botId);
  }
  /** "Remove record": hidden from the list; topics and routines using it keep working. */
  async forget(botId: string, folderId: string) {
    await this.list(botId);
    try {
      return { ok: true as const, inUse: this.repo.hide(botId, folderId) };
    } catch (error) {
      if (error instanceof TypeError) throw new RpcError(-32602, error.message);
      throw error;
    }
  }
  /** @deprecated The old "remove folder" is now "remove record". */
  async remove(botId: string, folderId: string) {
    await this.forget(botId, folderId);
    return this.list(botId);
  }
  async used(botId: string) {
    await this.list(botId);
    return { folders: this.repo.used(botId) };
  }
  /**
   * @deprecated Older clients set the Bot's folder for "its chat": keep that meaning for the
   * Bot's current topic only (when it is idle) plus the legacy default for a Bot without topics.
   * No other topic follows it any more.
   */
  async setCurrent(botId: string, folderId: string) {
    const current = await this.list(botId);
    if (folderId !== "home" && !current.folders.some((folder) => folder.id === folderId))
      throw new RpcError(-32602, "Unknown working folder");
    const release = await this.beforeChange?.(botId);
    try {
      this.repo.setCurrent(botId, folderId);
      const topic = new ConversationsRepo(this.db).currentDm(botId);
      const topics = new TopicsRepo(this.db);
      if (!topics.busy(topic.id)) topics.setWorkplace(botId, topic.id, folderId);
      return await this.list(botId);
    } finally {
      release?.();
    }
  }
  /** The default a new topic starts with: the previous topic's folders. */
  initial(botId: string): FolderSelection {
    return this.topics.initial(botId);
  }
  /** A DM topic's selection and revision, as stored (the source for run and approval snapshots). */
  topic(topicId: string): SelectionContext {
    const topic = new ConversationsRepo(this.db).get(topicId);
    if (topic?.kind !== "dm") throw new RpcError(-32602, "Unknown topic");
    return { selection: this.topics.selection(topicId), revision: topic.workplaceRevision ?? 0 };
  }
  /**
   * Resolves a selection into the folder boundary: the primary and explicit writable folders are
   * write roots, references are
   * read-only. Without a selection it resolves the Bot's default (what a new topic would get).
   */
  async context(
    botId: string,
    parent = this.shutdown,
    place?: SelectionContext,
    options: { annotateCommandReadBlocked?: boolean } = {},
  ): Promise<ResolvedWorkplace & { gone?: GoneFolder[] }> {
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(20_000)]);
    // Only selected folders affect this decision. The registry's display annotations would
    // repeat the same sensitive-root scan, and the selected set is checked below regardless.
    const registered = await this.registered(botId, signal);
    const selection = FolderSelectionSchema.parse(place?.selection ?? this.initial(botId));
    const ids = [
      ...(selection.primary === "home" ? [] : [selection.primary]),
      ...(selection.writable ?? []),
      ...selection.readonly.filter((id) => id !== selection.primary),
    ];
    const rows = this.repo.folders(botId, ids);
    const folders: RoleFolder[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      const role: FolderRole =
        id === selection.primary
          ? "primary"
          : selection.writable?.includes(id)
            ? "writable"
            : "readonly";
      // A reference whose record was deleted is skipped like a deleted one; failing here
      // would turn one stale reference into "the task never runs again".
      if (!row) {
        if (role === "readonly") continue;
        throw new RpcError(-32602, "Unknown working folder");
      }
      folders.push({
        ...row,
        // A stored alias would keep hiding the drive-spelled sensitive roots on every run.
        ...(row.location ? {} : { path: this.spelling(row.path) }),
        role,
      });
    }
    const selected = {
      home: registered.home,
      folders,
      currentId: selection.primary,
      revision: place?.revision ?? registered.revision ?? 0,
    };
    const value =
      options.annotateCommandReadBlocked === false
        ? selected
        : await this.withBlocked(selected, signal);
    const cwd =
      value.currentId === "home"
        ? value.home
        : value.folders.find((folder) => folder.id === value.currentId)?.path;
    if (!cwd) throw new RpcError(-32602, "Unknown working folder");
    if (
      selection.writable?.length &&
      ((this.executionLocation?.target && this.executionLocation.target !== "local") ||
        folders.some((f) => f.location && f.location !== "local"))
    )
      throw new RpcError(-32601, "runner_writable_unsupported");
    if (this.targets) {
      const remote = await runnerWorkplace(value, this.targets, signal);
      if (remote) return remote;
    }
    const home = await abortable(realpath(value.home), signal);
    const { roots, kept, gone } = await this.localRoots(folders, home, signal);
    const resolved = gone.length ? { ...value, folders: kept } : value;
    if (selection.writable?.length) {
      if (!this.assertWritable) throw new RpcError(-32601, "writable_folders_unsupported");
      await this.assertWritable(
        kept.filter((f) => f.role === "writable").map((f) => f.path),
        home,
        signal,
      );
    }
    const boundary = await workspaceBoundary(
      [
        // Internal log/session resources are not associated user work roots.
        ...(resolved.currentId === "home"
          ? [{ id: "home", path: home, role: "primary" as const }]
          : []),
        ...resolved.folders.map((f) => ({
          id: f.id,
          path: f.path,
          role:
            f.id === selection.primary
              ? ("primary" as const)
              : selection.writable?.includes(f.id)
                ? ("writable" as const)
                : ("readonly" as const),
        })),
      ],
      value.revision ?? 0,
      this.platform,
      signal,
      new ManagedWorktreesRepo(this.db).byPath(cwd),
      this.executionLocation,
    );
    return {
      value: resolved,
      cwd: boundary.primaryPath,
      roots,
      home,
      boundary,
      ...(gone.length ? { gone } : {}),
    };
  }
  /**
   * The names (never paths) of a selection's folders that no longer resolve, so the task
   * page can say which folder to pick again. Display only; a run uses `context`.
   */
  async goneFolders(
    botId: string,
    place: SelectionContext | undefined,
    parent = this.shutdown,
  ): Promise<string[]> {
    const selection = FolderSelectionSchema.parse(place?.selection ?? this.initial(botId));
    const ids = [
      ...(selection.primary === "home" ? [] : [selection.primary]),
      ...(selection.writable ?? []),
      ...selection.readonly.filter((id) => id !== selection.primary),
    ];
    const rows = this.repo.folders(botId, ids);
    const signal = AbortSignal.any([parent, this.shutdown, AbortSignal.timeout(5_000)]);
    const gone: string[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) continue;
      try {
        await abortable(realpath(row.path), signal);
      } catch {
        signal.throwIfAborted();
        // Any path that does not resolve is one the task cannot use any more.
        if (row.name && !gone.includes(row.name)) gone.push(row.name);
      }
    }
    return gone.slice(0, 8);
  }
  /**
   * The local roots of a run. A read-only reference or watched folder that the person
   * deleted is reported and dropped, so the task keeps running in its own folder; the primary (and
   * the writable roots) must still resolve, or the run fails with the explicit missing-folder code.
   */
  private async localRoots(
    folders: readonly RoleFolder[],
    home: string,
    signal: AbortSignal,
  ): Promise<{ roots: string[]; kept: RoleFolder[]; gone: GoneFolder[] }> {
    const roots: string[] = [];
    const kept: RoleFolder[] = [];
    const gone: GoneFolder[] = [];
    // Only a folder row can be the primary; without one the Bot's own home is the primary root.
    if (!folders.some((folder) => folder.role === "primary")) roots.push(home);
    for (const folder of folders) {
      let canonical: string;
      try {
        canonical = await abortable(realpath(folder.path), signal);
      } catch (error) {
        signal.throwIfAborted();
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          if (folder.role === "readonly") {
            gone.push({ id: folder.id, name: folder.name });
            continue;
          }
          // A folder deleted or moved outside Pi Bot is a state the person can fix (pick another
          // folder), not a program error: "internal" left the chat showing only "couldn't load".
          throw new RpcError(-32602, "workplace_folder_missing");
        }
        throw error;
      }
      if (!samePathSpelling(canonical, resolve(folder.path)))
        throw new RpcError(-32602, "Working folder changed; associate it again");
      roots.push(canonical);
      kept.push(folder);
    }
    return { roots, kept, gone };
  }
  /** `files.open` may open what any of the Bot's conversations could show: home + its folders. */
  async open(botId: string, path: string) {
    const registered = await this.list(botId);
    if (
      this.repo
        .remoteFolders(botId)
        .some((folder) =>
          containsPath(
            folder.path,
            path,
            /^[A-Za-z]:[\\/]|^\\\\/.test(folder.path) ? "win32" : "linux",
          ),
        )
    )
      throw new RpcError(-32601, "runner_file_open_unsupported");
    if (!isAbsolute(path)) throw new RpcError(-32602, "Absolute file path required");
    const signal = AbortSignal.any([this.shutdown, AbortSignal.timeout(20_000)]);
    const canonical = await abortable(realpath(path), signal);
    const candidates = [registered.home, ...this.repo.allPaths(botId)]
      .filter((root) => containsPath(resolve(root), canonical, this.platform))
      .sort((a, b) => b.length - a.length);
    let allowedRoot: string | undefined;
    for (const root of candidates) {
      // A moved or deleted folder only drops out of the allowed roots.
      const resolved = await abortable(realpath(root), signal).catch(() => {
        signal.throwIfAborted();
        return undefined;
      });
      if (resolved && samePathSpelling(resolved, resolve(root))) {
        allowedRoot = resolved;
        break;
      }
    }
    if (!allowedRoot) throw new RpcError(-32602, "File is outside workplaces");
    if (!this.host.openPath) throw new RpcError(-32603, "File opener unavailable");
    // The host needs only the narrowest verified root for this path, not the whole registry.
    await abortable(
      this.host.openPath({ path: canonical, allowedRoots: [allowedRoot] }, signal),
      signal,
    );
    return { ok: true as const };
  }
}
