import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { abortable, type BrainHost, type RegisterRpc } from "@pibot/brain/kit";
import { fileIdentity } from "@pibot/execution";
import {
  type EventPayloads,
  type KnowledgeAccount,
  type KnowledgeConfig,
  type KnowledgeNotionWriteTools,
  type KnowledgeSource,
  type KnowledgeTargets,
  type NotionWriteAction,
  type PluginMethodParams,
  type PluginMethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { transaction } from "@pibot/storage";
import type { KnowledgeRepo } from "../../store/index.ts";
import { knowledgeMissing } from "../../store/knowledge.ts";
import { inspectLocalFolder } from "../knowledge/local-index.ts";
import { obsidianVault, type VaultAccess } from "../knowledge/obsidian.ts";
import {
  type ReferenceScope,
  referenceCandidate,
  referenceChanged,
  referenceInMessage,
  referenceInvalid,
  referenceScope,
  referenceUnsupported,
  sameReference,
  type VerifiedReference,
  verifyReference,
} from "../knowledge/open-reference.ts";

export type Emit = <K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) => void;
type LocalConfig = Extract<KnowledgeConfig, { kind: "folder" | "obsidian" }>;
type FolderPreview = NonNullable<PluginMethodResults["knowledge.repoint"]["preview"]>;

/**
 * Knowledge sources: the person's Obsidian vaults and Notion workspaces, registered as
 * read-only references. Adding a vault goes through the host folder dialog, so the renderer never
 * hands the brain an arbitrary read root.
 */
export class KnowledgeService {
  /** A second dialog would race the first one and could insert the same vault twice. */
  private picking = false;
  private folderChoice?: {
    token: string;
    expires: number;
    source: KnowledgeSource;
    recipients: FolderPreview["recipients"];
    origin: LocalConfig;
    selected: LocalConfig;
  };

  constructor(
    private readonly deps: {
      repo: KnowledgeRepo;
      host: BrainHost;
      emit: Emit;
      shutdown: AbortSignal;
      /** A click names a message, and its Bot/group scope comes from the store. */
      db: DatabaseSync;
      /**
       * The same `read_file` gate the knowledge tools use, rebuilt from the stored reply's
       * Bot/group/conversation. A click is not consent to read a folder the policy denies, and each
       * verification asks again so a decision that changed meanwhile is not remembered.
       */
      readAccess(
        scope: Pick<ReferenceScope, "botId" | "runId" | "conversationId" | "groupId">,
        signal: AbortSignal,
      ): Promise<VaultAccess>;
      /**
       * The same `read_file`/`list_dir` gate and protected-path boundary for `knowledge.inspect`,
       * so denied files stay outside PDF content extraction.
       */
      inspectAccess(targets: KnowledgeTargets, signal: AbortSignal): Promise<VaultAccess>;
      /** One audit row per click and its fixed outcome; never the note, path or href. */
      audit(entry: {
        botId: string;
        runId: string;
        sourceId: string;
        status: "requested" | "opened" | "unknown" | "failed";
      }): void;
      /**
       * A Notion source reads through a remote MCP connection this service owns. The connector
       * service creates it and answers whether a stored one still exists, so nothing here touches
       * the pool or the OAuth credential.
       */
      notion: {
        create(): string;
        exists(connectorId: string): boolean;
        /** Copy the source's assignments onto the connection it owns. */
        sync(sourceId: string): void;
        /** Startup repair for installations that predate `selected` + targets. */
        reconcile(): void;
        /** Remove the managed connection when its source goes away. */
        uninstall(connectorId: string): void;
        /** Read the signed-in account through the connection's ordinary call channel. */
        account(
          input: { sourceId: string; connectorId: string; targets: KnowledgeTargets },
          signal: AbortSignal,
        ): Promise<KnowledgeAccount>;
        /** How many Notion write tools exist and how many are enabled on the managed connector. */
        writeToolsState?(
          connectorId: string,
          confirmed: NotionWriteAction[],
        ): KnowledgeNotionWriteTools | undefined;
        /** Enable or disable Notion's write tools on the managed connector after explicit user action. */
        setWriteToolsEnabled?(connectorId: string, actions: NotionWriteAction[]): void;
      };
    },
  ) {}

  /**
   * Startup repair for managed connections written before access targets existed. Calling it from
   * capability setup means an upgraded app tightens them before any RPC can read a source.
   */
  reconcile(): void {
    this.deps.notion.reconcile();
  }

  list(params: PluginMethodParams["knowledge.list"]): PluginMethodResults["knowledge.list"] {
    // The list is the knowledge tab's first read after a restart; tightening before it means an
    // upgraded app never shows a source whose connection is still usable by every Bot.
    this.reconcile();
    return this.deps.repo.list(params);
  }

  get(params: PluginMethodParams["knowledge.get"]): PluginMethodResults["knowledge.get"] {
    const source = this.deps.repo.get(params.id);
    if (!source) knowledgeMissing();
    const origin = this.deps.repo.origin(params.id);
    const notionWriteTools =
      origin.kind === "notion"
        ? this.deps.notion.writeToolsState?.(origin.connectorId, origin.writeActions ?? [])
        : undefined;
    return {
      source,
      origin,
      ...(notionWriteTools ? { notionWriteTools } : {}),
    };
  }

  /**
   * Read-only summary of a local source's folder identity and recognized/unsupported files.
   * Returns null for non-local sources (Notion).
   */
  async inspect(
    params: PluginMethodParams["knowledge.inspect"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.inspect"]> {
    const source = this.deps.repo.get(params.id);
    if (!source) knowledgeMissing();
    const origin = this.deps.repo.origin(params.id);
    if (origin.kind !== "obsidian" && origin.kind !== "folder") return { summary: null };
    const operation = lifetime(this.deps.shutdown, signal);
    const access = await this.deps.inspectAccess(source.targets, operation);
    const summary = await inspectLocalFolder(obsidianVault(origin), access, {
      db: this.deps.db,
      sourceId: source.id,
    });
    return { summary };
  }

  /**
   * Cache successful account details only. Every unavailable result may change after an
   * assignment, policy or catalog change, including results cached by earlier versions.
   */
  async account(
    params: PluginMethodParams["knowledge.account"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.account"]> {
    const { repo, notion } = this.deps;
    const source = repo.get(params.id);
    if (!source) knowledgeMissing();
    const origin = repo.origin(params.id);
    if (origin.kind !== "notion") return { account: null };
    const stored = repo.account(params.id);
    if (stored?.status === "ok" && !params.refresh) return { account: stored };
    const accountRevision = repo.accountRevision;
    const operation = lifetime(this.deps.shutdown, signal);
    const account = await notion.account(
      { sourceId: source.id, connectorId: origin.connectorId, targets: source.targets },
      operation,
    );
    operation.throwIfAborted();
    if (accountRevision !== repo.accountRevision) return { account: null };
    if (repo.get(source.id)?.updatedAt === source.updatedAt) {
      const currentOrigin = repo.origin(source.id);
      if (currentOrigin.kind === "notion" && currentOrigin.connectorId === origin.connectorId)
        repo.setAccount(source.id, account.status === "ok" ? account : null);
    }
    return { account };
  }

  /**
   * What this computer already keeps. Only names, paths and installed flags come back —
   * no note content is read — and a host without detection (`brain` on a server, tests) answers
   * "nothing found" so the tab still renders its empty state instead of failing.
   */
  async detect(
    _params: PluginMethodParams["knowledge.detect"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.detect"]> {
    const { host, repo } = this.deps;
    const empty = { obsidian: { installed: false, vaults: [] }, notion: { installed: false } };
    if (!host.knowledge) return empty;
    const detected = await host.knowledge.detect(lifetime(this.deps.shutdown, signal));
    const vaults: PluginMethodResults["knowledge.detect"]["obsidian"]["vaults"] = [];
    const seen = new Set<string>();
    for (const vault of detected.obsidian.vaults) {
      // Canonicalize exactly like adding does, so "already added" is decided on one path and a
      // symlinked or differently cased folder does not show up twice.
      let path: string;
      try {
        path = await realpath(vault.path);
      } catch {
        continue; // the vault disappeared between the host scan and this call
      }
      if (seen.has(path)) continue;
      seen.add(path);
      const existing = repo.findObsidian(path);
      vaults.push({ name: existing?.name ?? vault.name, path, added: existing !== undefined });
    }
    return { ...detected, obsidian: { ...detected.obsidian, vaults } };
  }

  async addObsidian(
    params: PluginMethodParams["knowledge.addObsidian"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.addObsidian"]> {
    const { host, repo } = this.deps;
    const lifetimeSignal = lifetime(this.deps.shutdown, signal);
    const picker = host.pickFolder;
    if (this.picking) throw new RpcError(RpcErrorCodes.busy, "knowledge_busy");
    this.picking = true;
    try {
      // Same shape as workplaces.pickPath — the host may never answer (a network
      // volume, or a dialog that does not resolve), so the pick is bounded and abortable;
      // otherwise `picking` stays true and every later add is rejected as busy. A vault
      // the host detected is re-checked against a fresh scan under the same bound.
      const pick = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(630_000)]);
      let picked: string | null;
      if (params.detectedPath === undefined) {
        if (!picker) throw new RpcError(RpcErrorCodes.unsupported, "knowledge_picker_unavailable");
        picked = await abortable(picker(pick, { create: false }), pick);
        pick.throwIfAborted();
      } else {
        picked = await detectedVaultPath(host, params.detectedPath, pick);
      }
      if (!picked) return { source: null };
      // The host is a separate process; validate what it returns before treating it as a path.
      if (!isAbsolute(picked) || /[\p{Cc}\p{Cf}]/u.test(picked)) throw vaultInvalid();
      const vault = await vaultFolder(picked, pick);
      const localKind =
        params.detectedPath !== undefined ? "obsidian" : (params.kind ?? "obsidian");
      // A repeat Add opens the existing record so the person can review its grants before
      // changing access or accepting a restored folder under those grants.
      const existing = repo.findObsidian(vault.path);
      if (existing) return { source: existing, alreadyAdded: true };
      const initialTargets: KnowledgeTargets = params.targets
        ? {
            all: params.targets.all ?? false,
            bots: params.targets.bots,
            groups: params.targets.groups,
          }
        : { all: false, bots: [], groups: [] };
      const source = repo.create({
        kind: localKind,
        name: basename(vault.path) || vault.path,
        config: {
          kind: localKind,
          path: vault.path,
          device: vault.identity.device,
          inode: vault.identity.inode,
        },
        targets: initialTargets,
      });
      this.deps.emit("knowledge.changed", { id: source.id, reason: "added" });
      return { source };
    } finally {
      this.picking = false;
    }
  }

  /**
   * The picker stages one exact folder. A second user action confirms transferring the displayed
   * assignments and edit setting to that folder.
   */
  async repoint(
    params: PluginMethodParams["knowledge.repoint"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.repoint"]> {
    if (params.confirmationToken)
      return this.confirmFolder(params.id, params.confirmationToken, signal);
    const { host, repo } = this.deps;
    const source = repo.get(params.id);
    if (!source) knowledgeMissing();
    const origin = repo.origin(params.id);
    if (origin.kind !== "obsidian" && origin.kind !== "folder") throw vaultInvalid();
    const picker = host.pickFolder;
    if (!picker) throw new RpcError(RpcErrorCodes.unsupported, "knowledge_picker_unavailable");
    if (this.picking) throw new RpcError(RpcErrorCodes.busy, "knowledge_busy");
    this.folderChoice = undefined;
    this.picking = true;
    try {
      const lifetimeSignal = lifetime(this.deps.shutdown, signal);
      const pick = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(630_000)]);
      const picked = await abortable(picker(pick, { create: false }), pick);
      pick.throwIfAborted();
      if (!picked) return { source: null };
      if (!isAbsolute(picked) || /[\p{Cc}\p{Cf}]/u.test(picked)) throw vaultInvalid();
      const vault = await vaultFolder(picked, pick);
      const existing = repo.findObsidian(vault.path);
      if (existing && existing.id !== source.id)
        return { source: null, conflict: { id: existing.id, name: existing.name } };
      const token = randomUUID();
      const current = this.folderSource(source, origin);
      const recipients = current.targets.all ? [] : repo.repointRecipients(current.id);
      this.folderChoice = {
        token,
        expires: Date.now() + 5 * 60_000,
        source: current,
        recipients,
        origin,
        selected: { kind: origin.kind, path: vault.path, ...vault.identity },
      };
      return { source: null, preview: { token, path: vault.path, source: current, recipients } };
    } finally {
      this.picking = false;
    }
  }

  private folderSource(source: KnowledgeSource, origin: LocalConfig): KnowledgeSource {
    const current = this.deps.repo.get(source.id);
    if (
      !current ||
      current.name !== source.name ||
      current.writable !== source.writable ||
      !isDeepStrictEqual(current.targets, source.targets) ||
      !isDeepStrictEqual(this.deps.repo.origin(source.id), origin)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_repoint_stale");
    return current;
  }

  private async confirmFolder(id: string, token: string, signal?: AbortSignal) {
    const choice = this.folderChoice;
    if (
      !choice ||
      choice.source.id !== id ||
      choice.token !== token ||
      Date.now() >= choice.expires
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_repoint_stale");
    this.folderChoice = undefined;
    const operation = AbortSignal.any([
      lifetime(this.deps.shutdown, signal),
      AbortSignal.timeout(20_000),
    ]);
    const vault = await vaultFolder(choice.selected.path, operation);
    operation.throwIfAborted();
    if (
      vault.path !== choice.selected.path ||
      vault.identity.device !== choice.selected.device ||
      vault.identity.inode !== choice.selected.inode
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_repoint_stale");
    this.folderSource(choice.source, choice.origin);
    if (
      !choice.source.targets.all &&
      !isDeepStrictEqual(this.deps.repo.repointRecipients(id), choice.recipients)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_repoint_stale");
    const existing = this.deps.repo.findObsidian(vault.path);
    if (existing && existing.id !== id)
      return { source: null, conflict: { id: existing.id, name: existing.name } };
    const source = this.deps.repo.repoint(id, choice.selected);
    this.deps.emit("knowledge.changed", { id, reason: "updated" });
    return { source };
  }

  /**
   * Creates the remote MCP connection the source will read through and returns it, so the UI can
   * run `connectors.authorize` next. The connection is installed disabled like any other import:
   * enabling it is exactly what the OAuth grant does.
   */
  addNotion(
    params: PluginMethodParams["knowledge.addNotion"],
  ): PluginMethodResults["knowledge.addNotion"] {
    const { repo, notion } = this.deps;
    const existing = repo.findNotion();
    if (existing && notion.exists(existing.connectorId)) {
      // A connection installed before this task may still be open to every Bot; copying the
      // source's assignments here repairs it on the same click that opens the source.
      notion.sync(existing.source.id);
      return { source: existing.source, connectorId: existing.connectorId };
    }
    const connectorId = notion.create();
    const config = { kind: "notion" as const, connectorId };
    const initialTargets: KnowledgeTargets = params.targets
      ? {
          all: params.targets.all ?? false,
          bots: params.targets.bots,
          groups: params.targets.groups,
        }
      : { all: false, bots: [], groups: [] };
    const source = existing
      ? repo.repoint(existing.source.id, config)
      : repo.create({
          kind: "notion",
          name: "Notion",
          config,
          targets: initialTargets,
        });
    this.deps.emit("knowledge.changed", {
      id: source.id,
      reason: existing ? "updated" : "added",
    });
    notion.sync(source.id);
    return { source, connectorId };
  }

  update(params: PluginMethodParams["knowledge.update"]): PluginMethodResults["knowledge.update"] {
    const origin = this.deps.repo.origin(params.id);
    const targets = { ...params.targets, all: params.targets.all ?? false };
    const source = transaction(this.deps.db, () => {
      let config: KnowledgeConfig | undefined;
      if (params.writable === true && origin.kind === "notion") {
        const writeState = this.deps.notion.writeToolsState?.(
          origin.connectorId,
          origin.writeActions ?? [],
        );
        if (writeState?.readOnlyMode) {
          throw new RpcError(RpcErrorCodes.unsupported, "knowledge_notion_read_only");
        }
        if (
          !writeState ||
          writeState.availableWrites.length === 0 ||
          !this.deps.notion.setWriteToolsEnabled
        ) {
          throw new RpcError(RpcErrorCodes.unsupported, "knowledge_notion_write_tools_missing");
        }
        if (!writeState.readAvailable)
          throw new RpcError(RpcErrorCodes.unsupported, "knowledge_notion_read_tool_missing");
        const actions = params.notionWriteActions;
        if (
          !actions ||
          params.notionConnectorRevision !== writeState.revision ||
          !isDeepStrictEqual(actions, writeState.availableWrites) ||
          !isDeepStrictEqual(targets, this.deps.repo.get(params.id)?.targets)
        )
          throw new RpcError(
            RpcErrorCodes.connectorStale,
            "knowledge_notion_write_consent_changed",
          );
        this.deps.notion.setWriteToolsEnabled(origin.connectorId, actions);
        config = { ...origin, writeActions: actions };
      } else if (params.writable === false && origin.kind === "notion") {
        config = { kind: "notion", connectorId: origin.connectorId };
        this.deps.notion.setWriteToolsEnabled?.(origin.connectorId, []);
      }
      const source = this.deps.repo.update({
        ...params,
        targets,
        config,
      });
      this.deps.notion.sync(source.id);
      return source;
    });
    this.deps.emit("knowledge.changed", { id: source.id, reason: "updated" });
    return source;
  }

  remove(params: PluginMethodParams["knowledge.remove"]): PluginMethodResults["knowledge.remove"] {
    const origin = this.deps.repo.origin(params.id);
    // Only the connection this source created is removed; a vault, the Notion workspace and a
    // connection the person imported themselves are left untouched.
    if (origin.kind === "notion") this.deps.notion.uninstall(origin.connectorId);
    this.deps.repo.remove(params.id);
    this.deps.emit("knowledge.changed", { id: params.id, reason: "removed" });
    return { ok: true };
  }

  /**
   * Opens the library's settings for a chat citation. Derives the source strictly from the
   * stored reply and current assignment.
   */
  async repointReference(
    params: PluginMethodParams["knowledge.repointReference"],
  ): Promise<PluginMethodResults["knowledge.repointReference"]> {
    const scope: ReferenceScope = referenceScope(this.deps.db, params.messageId);
    if (!(await referenceInMessage(scope.content, params.href))) throw referenceInvalid();
    const candidate = referenceCandidate(this.deps.repo, scope, params.href, {
      allowMissingIdentity: true,
    });
    return { sourceId: candidate.sourceId };
  }

  /**
   * Opens the note behind a reference in one settled reply. The href is only a hint: the
   * Bot and group come from the stored message, the source from the current assignment, and the
   * host receives identities it re-checks itself before rebuilding the URI.
   */
  async openReference(
    params: PluginMethodParams["knowledge.openReference"],
    signal?: AbortSignal,
  ): Promise<PluginMethodResults["knowledge.openReference"]> {
    const operation = lifetime(this.deps.shutdown, signal);
    const verified = await this.verifyOpen(params, operation);
    const openNote = this.deps.host.knowledge?.openNote;
    // A brain without a desktop host (server, tests) has no way to open an app: say so instead of
    // pretending the click worked or falling back to a file path or a shell command.
    if (!openNote) throw referenceUnsupported();
    // The request is recorded before the host starts reading configuration: a click that hangs or
    // dies in the host still happened, and the record names only the source and the run.
    this.deps.audit({ ...auditScope(verified), status: "requested" });
    let outcome: Awaited<ReturnType<typeof openNote>>;
    try {
      outcome = await openNote(
        {
          requestId: randomUUID(),
          sourceId: verified.sourceId,
          vault: {
            path: verified.vaultPath,
            device: verified.vaultIdentity.device,
            inode: verified.vaultIdentity.inode,
          },
          note: {
            relativePath: verified.notePath,
            device: verified.noteIdentity.device,
            inode: verified.noteIdentity.inode,
          },
          preferReveal: verified.kind === "folder" || !/\.md$/i.test(verified.notePath),
        },
        operation,
        // Reading Obsidian's own configuration takes seconds, and the person may revoke the source
        // or archive the Bot meanwhile. The host asks once more immediately before the system open,
        // and only a fresh verification of the same reference lets it proceed.
        async () => {
          const again = await this.verifyOpen(params, operation);
          if (!sameReference(verified, again)) throw referenceChanged();
        },
      );
    } catch (error) {
      // "unknown" means the host had already handed the URI to the system: the person may see the
      // note open even though this call failed, so the outcome is recorded as unknown rather than
      // as a failure and the UI does not suggest a blind retry.
      this.deps.audit({
        ...auditScope(verified),
        status: unknownOutcome(error) ? "unknown" : "failed",
      });
      throw error;
    }
    // The system open returned; the row records completion for the same source and run.
    this.deps.audit({ ...auditScope(verified), status: "opened" });
    return outcome;
  }

  private async verifyOpen(
    params: PluginMethodParams["knowledge.openReference"],
    operation: AbortSignal,
  ): Promise<VerifiedReference & { botId: string; runId: string }> {
    const scope: ReferenceScope = referenceScope(this.deps.db, params.messageId);
    // The page sends a href it found in the reply; a link this reply never rendered (edited text,
    // another message's id) is refused before any assignment is even looked at.
    if (!(await referenceInMessage(scope.content, params.href))) throw referenceInvalid();
    const candidate = referenceCandidate(this.deps.repo, scope, params.href);
    // Every verification gets its own policy gate, so the answer at confirm time is the current one
    // and not the one from the first click.
    const access = await this.deps.readAccess(scope, operation);
    return {
      ...(await verifyReference(candidate, access)),
      botId: scope.botId,
      runId: scope.runId,
    };
  }
}

/**
 * The dialog returns whatever the person clicked; canonicalizing here keeps duplicate detection
 * and the later reads looking at the same folder (symlinks, trailing separators, case). The
 * identity is recorded once, here, because the folder must be the same entity the person chose:
 * every later query compares against it and asks them to choose again when it moved.
 */
async function vaultFolder(
  picked: string,
  signal: AbortSignal,
): Promise<{ path: string; identity: { device: string; inode: string } }> {
  // Network volumes can hang in realpath/lstat; the pick's own timeout is not enough once the
  // dialog has returned, so the filesystem checks get their own bounded signal.
  const operation = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  let canonical: string;
  try {
    canonical = await abortable(realpath(picked), operation);
  } catch (error) {
    operation.throwIfAborted();
    if (unreadable(error)) throw vaultUnreadable();
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_missing");
  }
  try {
    // Bigint stats: the same encoding execution uses for workspace roots, so NTFS file ids
    // compare exactly instead of through a rounded double.
    const info = await abortable(lstat(canonical, { bigint: true }), operation);
    if (!info.isDirectory()) {
      throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_not_directory");
    }
    return { path: canonical, identity: fileIdentity(info) };
  } catch (error) {
    operation.throwIfAborted();
    if (error instanceof RpcError) throw error;
    if (unreadable(error)) throw vaultUnreadable();
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_missing");
  }
}

/** The audit row's fixed fields: which source, which Bot and which run — never the note or href. */
function auditScope(verified: VerifiedReference & { botId: string; runId: string }) {
  return { botId: verified.botId, runId: verified.runId, sourceId: verified.sourceId };
}

/**
 * The host says "unknown" only after it handed the URI to the system: the call failed, but the note
 * may still have opened, so a retry is not safe to suggest and the outcome is recorded as such.
 */
function unknownOutcome(error: unknown): boolean {
  return error instanceof RpcError && error.message === "knowledge_reference_unknown";
}

/** Only durable answers are cached; policy denials and transient failures always re-check. */
/** The operation ends when the caller gives up or the brain shuts down, whichever comes first. */
function lifetime(shutdown: AbortSignal, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, shutdown]) : shutdown;
}

/**
 * A detected vault comes back as a path the renderer echoes. Re-running the host scan
 * keeps this add limited to folders Obsidian itself lists, so a page bug cannot turn it into
 * "read any folder" — the dialog is still the only other way in. Paths are compared canonically
 * because detection already returned them canonicalized.
 */
async function detectedVaultPath(
  host: BrainHost,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!host.knowledge) {
    throw new RpcError(RpcErrorCodes.unsupported, "knowledge_picker_unavailable");
  }
  const wanted = await canonicalOrNull(path);
  const detected = await host.knowledge.detect(signal);
  for (const vault of detected.obsidian.vaults) {
    if ((await canonicalOrNull(vault.path)) === wanted) return wanted;
  }
  throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_not_detected");
}

async function canonicalOrNull(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // A folder the person moved or deleted since the scan: not a detected vault any more.
    return path;
  }
}

/** Privacy denials and I/O failures are not the same as "the folder was replaced". */
function unreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EIO";
}

function vaultInvalid(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_invalid");
}

function vaultUnreadable(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_vault_unreadable");
}

/** The knowledge RPCs, through brain's single wrapper (validation, logging, error mapping). */
export function registerKnowledgeRpc(handle: RegisterRpc, service: KnowledgeService) {
  handle("knowledge.detect", (params, context) => service.detect(params, context?.signal));
  handle("knowledge.list", (params) => Promise.resolve(service.list(params)));
  handle("knowledge.get", (params) => Promise.resolve(service.get(params)));
  handle("knowledge.inspect", (params, context) => service.inspect(params, context?.signal));
  handle("knowledge.account", (params, context) => service.account(params, context?.signal));
  handle("knowledge.addObsidian", (params, context) =>
    service.addObsidian(params, context?.signal),
  );
  handle("knowledge.repoint", (params, context) => service.repoint(params, context?.signal));
  handle("knowledge.repointReference", (params) => service.repointReference(params));
  handle("knowledge.addNotion", (params) => Promise.resolve(service.addNotion(params)));
  handle("knowledge.update", (params) => Promise.resolve(service.update(params)));
  handle("knowledge.remove", (params) => Promise.resolve(service.remove(params)));
  handle("knowledge.openReference", (params, context) =>
    service.openReference(params, context?.signal),
  );
}
