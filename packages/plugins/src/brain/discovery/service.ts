import type { DatabaseSync } from "node:sqlite";
import type { SkillsPort } from "@pibot/brain/kit";
import {
  type BringOverPreview,
  type BringOverReason,
  type BringOverResult,
  type ConnectorImportHost,
  connectorAuditEvents,
  type DiscoveredItem,
  DiscoveredItemSchema,
  type DiscoveryResult,
  RpcError,
  RpcErrorCodes,
  requiresPluginSetup,
} from "@pibot/plugins-contract/full";
import { SkillImportDetailsSchema } from "@pibot/skills-contract";
import type { AuditRepo } from "@pibot/storage";
import {
  DiscoveryConsentRepo,
  freeInstalledName,
  installedManifestNames,
} from "../../store/index.ts";
import type { ConnectorService } from "../service/connector-service.ts";
import { sourceLayouts } from "./locations.ts";
import { broughtOverId, entryDescription, entryManifest, McpEntryError } from "./mcp.ts";
import {
  currentDigest,
  digestOf,
  readMcpFile,
  type ScannedItem,
  type ScannedSource,
  scanSource,
} from "./scan.ts";

/** Upper bound of one scan; a slow or huge home folder yields what was read so far. */
const SCAN_TIMEOUT_MS = 10_000;
const ITEM_TIMEOUT_MS = 60_000;
// A skill package is scanned file by file (licenses, variables, scripts): ppt-master's 13,000
// files took ~58 s under load on 2026-11-14, so 60 s failed big but valid skills.
const SKILL_ITEM_TIMEOUT_MS = 300_000;

type Conflict = DiscoveredItem["conflict"];

export interface DiscoveryDeps {
  db: DatabaseSync;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  logger: { warn(message: string): void; info(message: string): void };
  audit: AuditRepo;
  actorBotId: string;
  connectors: ConnectorService;
  skills():
    | Pick<
        SkillsPort,
        "bringOver" | "previewBringOver" | "cancelPreview" | "knownSkills" | "freeSkillName"
      >
    | undefined;
  /** Whether Pi Bot's keychain already holds a user key of this name (never its value). */
  secretExists(name: string): boolean;
  importHost?: ConnectorImportHost;
  shutdown: AbortSignal;
}

class ItemTimeout extends Error {}

function reasonOf(error: unknown): BringOverReason {
  if (error instanceof McpEntryError) return "invalid";
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "ENOENT" || code === "ENOTDIR") return "changed";
  }
  if (error instanceof RpcError) {
    if (error.code === RpcErrorCodes.busy) return "busy";
    if (/too_large|too_many_files/.test(error.message)) return "too_large";
    // Not "can't read its settings": the package itself is readable but holds something refused.
    if (
      error.message.startsWith("skill_import_unsafe") ||
      error.message === "connector_import_symlink" ||
      error.message.startsWith("connector_import_symlink:") ||
      error.message === "connector_import_path_outside_plugin"
    )
      return "unsafe";
    if (/already exists with a different value|secret conflict/i.test(error.message))
      return "secret_conflict";
    if (error.message === "skill_name_exists") return "name_exists";
    if (error.code === RpcErrorCodes.unsupported) return "unsupported";
    if (
      error.code === RpcErrorCodes.pluginImportInvalid ||
      error.code === RpcErrorCodes.invalidParams
    )
      return "invalid";
  }
  if (error instanceof Error && error.message === "discovery_too_large") return "too_large";
  return "failed";
}

/** Waits for shared work, but lets this caller leave early without cancelling it for others. */
function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const leave = () => reject(signal.reason);
    signal.addEventListener("abort", leave, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", leave));
  });
}

/**
 * Looks at other AI tools' user-level skills, MCP servers and plugins, only
 * after the person agreed, read-only, and brings chosen items over through the import paths Pi
 * Bot already has. The latest scan's file locations stay here; the renderer gets opaque keys.
 */
export class DiscoveryService {
  private readonly consent: DiscoveryConsentRepo;
  private latest = new Map<string, { item: ScannedItem; conflict: Conflict }>();
  private scanning: { work: Promise<DiscoveryResult>; stop: AbortController } | undefined;
  private bringing = false;
  private previewing = false;
  /**
   * Both the copy batch and the preview batch register here under the id the renderer
   * picked before dispatch — a preview has no id of its own until it is made, and a dialog must
   * still be able to wait for its cleanup before it closes.
   */
  private readonly batches = new Map<string, { abort: AbortController; done: Promise<void> }>();

  constructor(private readonly deps: DiscoveryDeps) {
    this.consent = new DiscoveryConsentRepo(deps.db);
  }

  setConsent(allow: boolean) {
    const consent = this.consent.set(allow);
    if (!consent) {
      // Withdrawing stops a scan in flight; nothing it read is kept.
      this.scanning?.stop.abort();
      this.latest.clear();
    }
    return { consent };
  }

  /** Concurrent page opens share one scan; a caller that leaves does not cancel it for others. */
  discover(signal: AbortSignal): Promise<DiscoveryResult> {
    if (!this.consent.get()) {
      this.latest.clear();
      return Promise.resolve({ scannedAt: null, consent: false, sources: [] });
    }
    if (!this.scanning) {
      const stop = new AbortController();
      const work = this.scan(
        AbortSignal.any([stop.signal, this.deps.shutdown, AbortSignal.timeout(SCAN_TIMEOUT_MS)]),
        stop.signal,
      ).finally(() => {
        if (this.scanning?.work === work) this.scanning = undefined;
      });
      this.scanning = { work, stop };
    }
    return raced(this.scanning.work, signal);
  }

  private async scan(signal: AbortSignal, withdrawn: AbortSignal): Promise<DiscoveryResult> {
    const seen = new Set<string>();
    const scanned: ScannedSource[] = [];
    const skip = (source: string, label: string, reason: string) =>
      this.deps.logger.warn(
        JSON.stringify({
          module: "plugins",
          event: "discovery_skipped",
          source,
          file: label,
          reason,
        }),
      );
    for (const layout of sourceLayouts(this.deps.home, this.deps.env)) {
      withdrawn.throwIfAborted();
      this.deps.shutdown.throwIfAborted();
      if (signal.aborted) {
        skip(layout.id, "", "scan_timeout");
        scanned.push({ layout, installed: false, items: [] });
        continue;
      }
      try {
        scanned.push(await scanSource(layout, seen, signal, skip, this.deps.home));
      } catch {
        withdrawn.throwIfAborted();
        skip(layout.id, "", signal.aborted ? "scan_timeout" : "unreadable");
        scanned.push({ layout, installed: false, items: [] });
      }
    }
    // Consent may have been withdrawn while files were being read: publish nothing then.
    withdrawn.throwIfAborted();
    if (!this.consent.get()) throw new RpcError(RpcErrorCodes.unsupported, "discovery_withdrawn");
    const conflict = this.conflicts();
    const latest = new Map<string, { item: ScannedItem; conflict: Conflict }>();
    const sources = scanned.map(({ layout, installed, items }) => ({
      id: layout.id,
      name: layout.name,
      installed,
      items: items.flatMap((item) => {
        const state = conflict(item);
        const shown = DiscoveredItemSchema.safeParse({
          key: item.key,
          kind: item.kind,
          name: item.name,
          description: item.description,
          secrets: item.secrets.map((secret) => ({
            ...secret,
            existing: secret.kind === "needed" && this.deps.secretExists(secret.name),
          })),
          conflict: state,
          ...(item.contains ? { contains: item.contains } : {}),
          ...(item.needsSetup ? { needsSetup: true } : {}),
          ...(item.workingDirectory ? { workingDirectory: item.workingDirectory } : {}),
          ...(item.registrySites?.length ? { registrySites: item.registrySites } : {}),
        });
        if (!shown.success) {
          skip(layout.id, item.kind, "item_unsupported");
          return [];
        }
        latest.set(item.key, { item, conflict: state });
        return [shown.data];
      }),
    }));
    this.latest = latest;
    return { scannedAt: new Date().toISOString(), consent: true, sources };
  }

  private conflicts() {
    const skills = this.deps.skills()?.knownSkills?.() ?? {
      names: new Set<string>(),
      originKeys: new Set<string>(),
    };
    const installed = installedManifestNames(this.deps.db);
    const ids = new Set(installed.map((row) => row.pluginId));
    const keys = new Set(installed.flatMap((row) => (row.originKey ? [row.originKey] : [])));
    const names = new Set(installed.flatMap((row) => row.names.map((name) => name.toLowerCase())));
    return (item: ScannedItem): Conflict => {
      const name = item.name.toLowerCase();
      if (item.kind === "skill") {
        // Matched by the scan key stored with it, so a renamed 「x 2」 is still recognised.
        if (skills.originKeys.has(item.key)) return "imported";
        return skills.names.has(name) ? "same_name" : "none";
      }
      if (
        keys.has(item.key) ||
        (item.kind === "mcp" && ids.has(broughtOverId(item.locator.source, item.name)))
      )
        return "imported";
      return names.has(name) ? "same_name" : "none";
    };
  }

  async bringOver(keys: readonly string[], requestSignal: AbortSignal, batchId?: string) {
    if (!this.consent.get())
      return { results: keys.map((key) => ({ key, outcome: "failed", reason: "no_consent" })) };
    if (this.bringing) throw new RpcError(RpcErrorCodes.busy, "bring_over_busy");
    this.bringing = true;
    // The renderer aborts this call when its dialog closes, but a local abort only proves
    // the stop frame was sent. With a batch id the same caller can await `cancelBringOver`, which
    // resolves after this batch — including any rollback — has actually finished.
    const batch = new AbortController();
    const done = this.importBatch(keys, AbortSignal.any([requestSignal, batch.signal]));
    this.trackBatch(batchId, batch, done);
    try {
      return await done;
    } finally {
      this.untrackBatch(batchId, batch);
      this.bringing = false;
    }
  }

  private trackBatch(batchId: string | undefined, abort: AbortController, work: Promise<unknown>) {
    if (!batchId) return;
    this.batches.set(batchId, {
      abort,
      done: work.then(
        () => undefined,
        () => undefined,
      ),
    });
  }

  /** Only this batch's own entry may go: a newer batch may already hold the same id's slot. */
  private untrackBatch(batchId: string | undefined, abort: AbortController) {
    if (!batchId) return;
    if (this.batches.get(batchId)?.abort === abort) this.batches.delete(batchId);
  }

  private async importBatch(keys: readonly string[], signal: AbortSignal) {
    const results: BringOverResult[] = [];
    for (const key of keys) {
      const result = await this.one(key, signal);
      results.push(result);
      const entry = this.latest.get(key);
      if (entry)
        this.deps.audit.append({
          botId: this.deps.actorBotId,
          kind: "plugin.changed",
          summary: connectorAuditEvents.broughtOver,
          detail: {
            originTool: entry.item.locator.source,
            itemKind: entry.item.kind,
            itemName: result.name ?? entry.item.name,
            outcome: result.outcome,
            ...(result.reason ? { reasonCode: result.reason } : {}),
          },
        });
      if (result.outcome === "imported" && entry) entry.conflict = "imported";
    }
    return { results };
  }

  /**
   * Waits until the identified batch has stopped. Unknown or already finished batches
   * report ok — they hold nothing, so closing cannot hide a live write.
   */
  async cancelBringOver(batchId: string) {
    const batch = this.batches.get(batchId);
    // Unknown or finished: it holds nothing, so closing cannot hide a live write.
    if (!batch) return { ok: true as const };
    batch.abort.abort();
    await batch.done;
    return { ok: true as const };
  }

  /**
   * What a skill would look like once saved — size, licence, compatibility and the name it
   * gets — read through the same skill preview a picked folder uses. Reading only; the renderer
   * imports the returned previewId itself, so nothing is written before the person confirms.
   */
  async previewBringOver(keys: readonly string[], requestSignal: AbortSignal, batchId?: string) {
    if (!this.consent.get())
      return {
        results: keys.map(
          (key): BringOverPreview => ({ key, outcome: "failed", reason: "no_consent" }),
        ),
      };
    // One scan-backed pass at a time: two previews would compete for the skill import slots.
    if (this.bringing || this.previewing) throw new RpcError(RpcErrorCodes.busy, "bring_over_busy");
    this.previewing = true;
    const batch = new AbortController();
    const stop = batchId ? AbortSignal.any([requestSignal, batch.signal]) : requestSignal;
    const created: string[] = [];
    const work = (async () => {
      try {
        const results: BringOverPreview[] = [];
        for (const key of keys) {
          const result = await this.previewOne(key, stop);
          if (result.outcome === "previewed") created.push(result.preview.previewId);
          results.push(result);
          // A stop can land while the last preview is being made; without this check the call
          // would return an id the cancelled renderer never receives, and that slot would leak.
          stop.throwIfAborted();
          this.deps.shutdown.throwIfAborted();
        }
        return { results };
      } catch (error) {
        // These previews hold import slots, and a cancelled batch never returns their
        // ids, so the renderer cannot drop them. Release them here and wait before the call ends.
        await this.dropPreviews(created);
        throw error;
      }
    })();
    this.trackBatch(batchId, batch, work);
    try {
      return await work;
    } finally {
      this.untrackBatch(batchId, batch);
      this.previewing = false;
    }
  }

  private async dropPreviews(previewIds: readonly string[]) {
    const cancel = this.deps.skills()?.cancelPreview;
    if (!cancel || !previewIds.length) return;
    await Promise.allSettled(previewIds.map((previewId) => cancel(previewId)));
  }

  private async previewOne(key: string, requestSignal: AbortSignal): Promise<BringOverPreview> {
    const entry = this.latest.get(key);
    if (!entry) return { key, outcome: "failed", reason: "unknown_item" };
    if (entry.conflict === "imported") return { key, outcome: "failed", reason: "name_exists" };
    const { item } = entry;
    const locator = item.locator;
    if (locator.kind !== "skill") return { key, outcome: "failed", reason: "unsupported" };
    const port = this.deps.skills();
    if (!port?.previewBringOver) return { key, outcome: "failed", reason: "unsupported" };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ItemTimeout()), SKILL_ITEM_TIMEOUT_MS);
    const signal = AbortSignal.any([requestSignal, this.deps.shutdown, timeout.signal]);
    try {
      const preview = await port.previewBringOver(
        this.deps.actorBotId,
        locator.folder,
        { tool: locator.source, key: item.key },
        signal,
      );
      // The port's declared result predates the full skill preview; what crosses to the renderer is
      // still checked against the contract rather than trusted.
      const parsed = SkillImportDetailsSchema.safeParse(preview);
      if (!parsed.success) return { key, outcome: "failed", reason: "invalid" };
      return { key, outcome: "previewed", preview: parsed.data };
    } catch (error) {
      requestSignal.throwIfAborted();
      this.deps.shutdown.throwIfAborted();
      return {
        key,
        outcome: "failed",
        reason: timeout.signal.aborted ? "failed" : reasonOf(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** One item; its own time limit fails only this item, the person's cancel stops the batch. */
  private async one(key: string, requestSignal: AbortSignal): Promise<BringOverResult> {
    const entry = this.latest.get(key);
    if (!entry) return { key, outcome: "failed", reason: "unknown_item" };
    if (entry.conflict === "imported") return { key, outcome: "skipped", reason: "name_exists" };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new ItemTimeout()), ITEM_TIMEOUT_MS);
    const signal = AbortSignal.any([requestSignal, this.deps.shutdown, timeout.signal]);
    try {
      const { item } = entry;
      // What was shown must still be what is there; values are re-read now, never cached.
      if (
        item.locator.kind !== "mcp" &&
        (await currentDigest(item.locator, signal)) !== item.digest
      )
        return { key, outcome: "failed", reason: "changed" };
      const locator = item.locator;
      // A skill never goes straight from a scan to a copy. It has to pass the same preview
      // (size, licence, compatibility, which Bot) the renderer shows and then `skills.import`; this
      // entry stays for MCP servers and plugins, whose own import already validates and previews.
      if (locator.kind === "skill") return { key, outcome: "failed", reason: "unsupported" };
      if (locator.kind === "mcp") return await this.mcp(key, entry, signal);
      return await this.plugin(key, entry, signal);
    } catch (error) {
      requestSignal.throwIfAborted();
      this.deps.shutdown.throwIfAborted();
      const reason = timeout.signal.aborted ? "failed" : reasonOf(error);
      if (reason === "failed")
        this.deps.logger.warn(
          JSON.stringify({
            module: "plugins",
            event: "bring_over_failed",
            source: entry.item.locator.source,
            itemKind: entry.item.kind,
            timedOut: timeout.signal.aborted,
          }),
        );
      return { key, outcome: "failed", reason };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The name it is saved under: its own, or "name 2" when an installed one has it. */
  private freeName(name: string) {
    const taken = new Set(
      installedManifestNames(this.deps.db).flatMap((row) =>
        row.names.map((value) => value.toLowerCase()),
      ),
    );
    return freeInstalledName(name, taken);
  }

  async previewSetup(key: string, signal: AbortSignal) {
    const entry = this.latest.get(key);
    if (
      !this.consent.get() ||
      !entry ||
      entry.conflict === "imported" ||
      entry.item.kind === "skill"
    )
      throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_bringOverSourceChanged");
    const { item } = entry;
    signal = AbortSignal.any([signal, this.deps.shutdown]);
    const locator = item.locator;
    if (locator.kind === "skill") throw new McpEntryError();
    const isMcp = locator.kind === "mcp";
    const prepared = isMcp
      ? await this.previewMcp(item, signal)
      : (await currentDigest(locator, signal)) === item.digest
        ? { preview: await this.previewPlugin(locator, signal) }
        : undefined;
    const preview = prepared?.preview;
    if (!preview)
      throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_bringOverSourceChanged");
    try {
      signal.throwIfAborted();
      if (!this.consent.get() || this.conflicts()(item) === "imported")
        throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_bringOverSourceChanged");
      this.deps.connectors.markDiscoveredPreview(preview.previewId, {
        tool: locator.source,
        key: item.key,
        ...(isMcp ? {} : { name: this.freeName(preview.manifest.name.en) }),
        path: isMcp ? `${locator.file}#${encodeURIComponent(locator.entry)}` : locator.folder,
      });
      return { ...preview, fromBringOver: true as const };
    } catch (error) {
      await this.deps.connectors.cancelPreview({ previewId: preview.previewId });
      throw error;
    }
  }

  private async previewMcp(item: ScannedItem, signal: AbortSignal) {
    const locator = item.locator;
    if (locator.kind !== "mcp") throw new McpEntryError();
    // Values (and any key written in them) come from the file at this moment and go straight into
    // the import, never through the renderer or the scan cache.
    const entries = await readMcpFile(locator.source, locator.file, locator.format, signal);
    const found = entries?.find(
      (candidate) => candidate.scope === locator.scope && candidate.name === locator.entry,
    );
    if (!found) return { reason: "changed" as const };
    if (!found.entry) return { reason: "invalid" as const };
    if (digestOf(found.entry) !== item.digest) return { reason: "changed" as const };
    const layout = sourceLayouts(this.deps.home, this.deps.env).find(
      (source) => source.id === locator.source,
    );
    const name = this.freeName(item.name);
    const summary = entryDescription(found.entry);
    const manifest = entryManifest(found.entry, {
      id: broughtOverId(locator.source, item.name),
      name,
      // The source tool is recorded separately (origin_tool) and shown beside this.
      description: {
        zh: summary || `来自 ${layout?.name ?? locator.source}`,
        en: summary || `From ${layout?.name ?? locator.source}`,
      },
    });
    const preview = await this.deps.connectors.previewImport(
      { kind: "json", text: JSON.stringify(manifest) },
      signal,
    );
    return { preview, name };
  }

  private async mcp(
    key: string,
    { item }: { item: ScannedItem },
    signal: AbortSignal,
  ): Promise<BringOverResult> {
    const prepared = await this.previewMcp(item, signal);
    if (!prepared.preview) return { key, outcome: "failed", reason: prepared.reason };
    const { preview, name } = prepared;
    if (preview.requiredKeys?.length || preview.savedKeys?.length) {
      await this.deps.connectors.cancelPreview({ previewId: preview.previewId });
      return { key, outcome: "failed", reason: "needs_setup" };
    }
    return this.commit(key, item, name, undefined, preview, false, signal);
  }

  private async previewPlugin(
    locator: Extract<ScannedItem["locator"], { kind: "plugin" }>,
    signal: AbortSignal,
  ) {
    if (!this.deps.importHost?.adopt) return;
    const { selectionId } = await this.deps.importHost.adopt({ path: locator.folder });
    try {
      return await this.deps.connectors.previewImport({ kind: "selection", selectionId }, signal);
    } catch (error) {
      // A failed read may already have released this selection.
      await this.deps.importHost.release({ selectionId }).catch(() => undefined);
      throw error;
    }
  }

  private async plugin(
    key: string,
    { item }: { item: ScannedItem },
    signal: AbortSignal,
  ): Promise<BringOverResult> {
    const locator = item.locator;
    if (locator.kind !== "plugin") throw new McpEntryError();
    const preview = await this.previewPlugin(locator, signal);
    if (!preview) return { key, outcome: "failed", reason: "unsupported" };
    // Settings the plugin needs (often an API key it reads from the environment) have to be
    // typed in; that is the 「导入插件」 dialog's job, not a silent bring-over.
    if (preview.plugin && requiresPluginSetup(preview.plugin.config)) {
      await this.deps.connectors.cancelPreview({ previewId: preview.previewId });
      return { key, outcome: "failed", reason: "needs_setup" };
    }
    // Checked now rather than from the scan's mark: an item earlier in the same batch may have
    // taken the name since.
    const free = this.freeName(preview.manifest.name.en);
    const rename = free === preview.manifest.name.en ? undefined : free;
    return this.commit(
      key,
      item,
      rename ?? preview.manifest.name.en,
      rename,
      preview,
      true,
      signal,
    );
  }

  /** Turns one discovered plugin folder into an import selection so ImportPlugin can configure it. */
  async adoptForSetup(key: string, requestSignal: AbortSignal): Promise<{ selectionId: string }> {
    if (!this.consent.get()) throw new RpcError(RpcErrorCodes.unsupported, "discovery_no_consent");
    const entry = this.latest.get(key);
    if (entry?.item.locator.kind !== "plugin")
      throw new RpcError(RpcErrorCodes.invalidParams, "unknown_item");
    if (this.conflicts()(entry.item) === "imported")
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_name_exists");
    if (!this.deps.importHost?.adopt)
      throw new RpcError(RpcErrorCodes.unsupported, "plugin_import_unavailable");
    const signal = AbortSignal.any([
      requestSignal,
      this.deps.shutdown,
      AbortSignal.timeout(ITEM_TIMEOUT_MS),
    ]);
    if ((await currentDigest(entry.item.locator, signal)) !== entry.item.digest)
      throw new RpcError(RpcErrorCodes.connectorStale, "source_changed");
    signal.throwIfAborted();
    let adopted: { selectionId: string };
    try {
      adopted = await this.deps.importHost.adopt({
        path: entry.item.locator.folder,
        bringOver: { tool: entry.item.locator.source, key: entry.item.key },
      });
    } catch (error) {
      throw this.deps.connectors.scrubSymlinkError(error);
    }
    if (signal.aborted) {
      await this.deps.importHost
        .release({ selectionId: adopted.selectionId })
        .catch(() => undefined);
      signal.throwIfAborted();
    }
    return adopted;
  }

  /**
   * Imported switched off and, in the same install transaction, given to nobody; the person picks
   * Bots on the page afterwards.
   */
  private async commit(
    key: string,
    item: ScannedItem,
    name: string,
    rename: string | undefined,
    preview: Awaited<ReturnType<ConnectorService["previewImport"]>>,
    plugin: boolean,
    signal: AbortSignal,
  ): Promise<BringOverResult> {
    let imported: Awaited<ReturnType<ConnectorService["import"]>>;
    try {
      imported = await this.deps.connectors.import(
        {
          previewId: preview.previewId,
          // Nothing starts until someone uses it; a skills-only plugin has nothing to start.
          enable: plugin && preview.manifest.servers.length === 0,
          expectedDigest: preview.digest,
          config: {},
          broughtOver: {
            tool: item.locator.source,
            key: item.key,
            ...(rename ? { name: rename } : {}),
          },
          sourcePath:
            item.locator.kind === "mcp"
              ? `${item.locator.file}#${encodeURIComponent(item.locator.entry)}`
              : item.locator.folder,
        },
        signal,
      );
    } catch (error) {
      await this.deps.connectors
        .cancelPreview({ previewId: preview.previewId })
        .catch(() => undefined);
      throw error;
    }
    return { key, outcome: "imported", name, installationId: imported.installation.id };
  }
}
