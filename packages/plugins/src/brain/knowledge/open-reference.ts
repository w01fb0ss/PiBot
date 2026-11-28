import { lstat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { abortable, activeGroup, visibleGroupMessage } from "@pibot/brain/kit";
import { type FileIdentity, fileIdentity } from "@pibot/execution";
import { IdSchema, RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { BotsRepo, ConversationsRepo, MessagesRepo, RunsRepo } from "@pibot/storage";
import type { KnowledgeRepo } from "../../store/index.ts";
import {
  localDocumentKind,
  type ObsidianVault,
  obsidianVault,
  readNote,
  type VaultAccess,
  vaultRoot,
} from "./obsidian.ts";

// The click half of a knowledge reference. A reply links a note with
// `obsidian://open?vault=…&file=…`; the link itself is only a hint. What may be opened is decided
// here from the stored message, the current assignment and the recorded vault identity, and the
// host rebuilds the URI from those identities rather than from the href the renderer sent.

/** How much of a reply is scanned for the link: a note reference sits in prose, not in a dump. */
const MAX_LINK_SCAN = 256 * 1024;
const MAX_HREF = 8192;
const MAX_VAULT_NAME = 200;

/** The identity a stored reply proves: which Bot, which group (if any) and which run. */
export interface ReferenceScope {
  botId: string;
  groupId?: string;
  runId: string;
  /** The conversation the reply lives in; the policy gate resolves its workplace and topic scope. */
  conversationId: string;
  /** The reply's own text; only scanned to prove the href was one of its rendered links. */
  content: string;
}

export interface ReferenceCandidate {
  sourceId: string;
  kind: "obsidian" | "folder";
  vault: ObsidianVault;
  /** Vault-relative document path derived from the link, not from any model or renderer path. */
  relativePath: string;
  legacyMarkdownAlternative?: string;
}

export interface VerifiedReference {
  sourceId: string;
  kind: "obsidian" | "folder";
  vaultPath: string;
  vaultIdentity: FileIdentity;
  notePath: string;
  noteIdentity: FileIdentity;
}

/**
 * Rebuilds the reply's own scope from durable ownership. The renderer names a message, never a
 * Bot or a group: trusting its ids would let one conversation open a source assigned elsewhere.
 */
export function referenceScope(db: DatabaseSync, messageId: string): ReferenceScope {
  const message = new MessagesRepo(db).get(messageId);
  // Only a settled assistant reply can carry a reference the person may click: a streaming or
  // failed reply has no final text to compare the href against.
  if (message?.role !== "assistant" || message.status !== "done" || !message.botId)
    throw referenceMissing();
  const conversation = new ConversationsRepo(db).get(message.conversationId);
  if (!conversation) throw referenceMissing();
  if (conversation.archivedAt) throw referenceMissing();
  const bot = new BotsRepo(db).get(message.botId);
  if (!bot) throw referenceMissing();
  if (bot.archivedAt) throw referenceMissing();
  const run = message.runId ? new RunsRepo(db).get(message.runId) : undefined;
  // A reply copied out of another run (or restored without its run) cannot prove which assignment
  // applied when it was written, so it is not a clickable reference.
  if (!run) throw referenceMissing();
  if (
    run.status !== "done" ||
    run.botId !== message.botId ||
    run.conversationId !== conversation.id
  )
    throw referenceMissing();
  if (conversation.groupId) {
    let group: ReturnType<typeof activeGroup>;
    try {
      group = activeGroup(db, conversation.groupId, message.botId, conversation.id);
    } catch (error) {
      // Membership, archived Bots and archived topics all read as "not visible here"; the
      // original message would only tell the renderer why a group it cannot see changed.
      if (error instanceof RpcError) throw referenceMissing();
      throw error;
    }
    if (!visibleGroupMessage(db, group, message)) throw referenceMissing();
    return {
      botId: message.botId,
      groupId: group.id,
      runId: run.id,
      conversationId: conversation.id,
      content: message.content,
    };
  }
  // Without a group the only other place a reply can live is the Bot's own conversation; a thread
  // or routine conversation reaching here means the ownership chain is not the one we can prove.
  if (conversation.kind !== "dm" || conversation.botId !== message.botId) throw referenceMissing();
  return {
    botId: message.botId,
    runId: run.id,
    conversationId: conversation.id,
    content: message.content,
  };
}

/**
 * The same Markdown pipeline the chat renders with, so "did this reply render that link" is asked
 * of the renderer's own syntax rather than of a second, partial one kept here. ReactMarkdown parses
 * CommonMark plus GFM, drops raw HTML (`skipHtml`) and renders code as code, so an `html`, `code` or
 * `inlineCode` node simply is not a link; containers (blockquotes, lists) and multi-line code spans
 * are handled by the parser instead of by line scanning.
 *
 * Parsing is linear in the text and the scan stays bounded; a reply is prose, not a document, so a
 * reference beyond the bound is not one the person could reasonably have been meant to click.
 */
async function parseMarkdown(text: string): Promise<MarkdownNode> {
  // remark/micromark (~100 modules) load on the first reference click, not with the brain
  //; a click already waits on policy and file checks, so a one-time import is noise.
  const [{ default: remarkGfm }, { default: remarkParse }, { unified }] = await Promise.all([
    import("remark-gfm"),
    import("remark-parse"),
    import("unified"),
  ]);
  return unified().use(remarkParse).use(remarkGfm).parse(text) as unknown as MarkdownNode;
}

/** Only the parts of an mdast node this file reads; the tree itself comes from the parser. */
interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

export async function referenceInMessage(text: string, href: string): Promise<boolean> {
  const tree = await parseMarkdown(text.slice(0, MAX_LINK_SCAN));
  // A reference-style link resolves through a definition that CommonMark lets appear after the
  // link itself; the first definition of a label wins, which is what the renderer does too.
  const definitions = definitionsIn(tree);
  return targetsIn(tree, definitions).some((target) => sameTarget(target, href));
}

function definitionsIn(tree: MarkdownNode): Map<string, string> {
  const definitions = new Map<string, string>();
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop() as MarkdownNode;
    if (node.type === "definition" && node.identifier && node.url !== undefined) {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    }
    // Reverse the push order so the stack visits the renderer's first definition first,
    // including when it is nested inside a blockquote or another container.
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push(children[index] as MarkdownNode);
    }
  }
  return definitions;
}

function targetsIn(tree: MarkdownNode, definitions: Map<string, string>): string[] {
  const targets: string[] = [];
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop() as MarkdownNode;
    if (node.type === "link" && node.url !== undefined) targets.push(node.url);
    if (node.type === "linkReference" && node.identifier) {
      const target = definitions.get(node.identifier);
      if (target !== undefined) targets.push(target);
    }
    if (node.children) pending.push(...node.children);
  }
  return targets;
}

/**
 * The renderer hands over the href it rendered, and the parser keeps the destination as written;
 * comparing canonical URLs keeps encoding differences (a space, a percent escape) from deciding
 * this on behalf of the person.
 */
function sameTarget(target: string, href: string): boolean {
  if (target === href) return true;
  try {
    return new URL(target).href === new URL(href).href;
  } catch {
    return false;
  }
}

/**
 * The strict shape Obsidian's own open handler understands: one action, one vault, one file and
 * nothing else. Anything that could name a different action, a second target or a remote location
 * is refused here instead of being argued about in the host.
 */
export function parseObsidianOpen(href: string): { vault: string; file: string; source?: string } {
  if (href.length > MAX_HREF || /[\p{Cc}\p{Cf}]/u.test(href)) throw referenceInvalid();
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw referenceInvalid();
  }
  if (url.protocol !== "obsidian:" || url.hostname !== "open") throw referenceInvalid();
  if (url.pathname !== "" && url.pathname !== "/") throw referenceInvalid();
  if (url.username || url.password || url.port || url.hash) throw referenceInvalid();
  const keys = [...url.searchParams.keys()];
  const vaultCount = keys.filter((key) => key === "vault").length;
  const fileCount = keys.filter((key) => key === "file").length;
  const sourceCount = keys.filter((key) => key === "source").length;
  if (
    vaultCount !== 1 ||
    fileCount !== 1 ||
    sourceCount > 1 ||
    keys.length !== vaultCount + fileCount + sourceCount
  )
    throw referenceInvalid();
  const vault = url.searchParams.get("vault") ?? "";
  const file = url.searchParams.get("file") ?? "";
  const rawSource = sourceCount === 1 ? (url.searchParams.get("source") ?? "") : undefined;
  let source: string | undefined;
  if (rawSource !== undefined) {
    const parsedSource = IdSchema.safeParse(rawSource);
    if (!parsedSource.success) throw referenceInvalid();
    source = parsedSource.data;
  }
  if (
    !vault ||
    vault.length > MAX_VAULT_NAME ||
    vault === "." ||
    vault === ".." ||
    vault.includes("/") ||
    vault.includes("\\")
  )
    throw referenceInvalid();
  return {
    vault,
    file: notePathFromLink(file, source !== undefined),
    ...(source ? { source } : {}),
  };
}

function notePathFromLink(file: string, hasSource: boolean): string {
  if (!file || file.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(file) || file.includes("\\"))
    throw referenceInvalid();
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file)) throw referenceInvalid();
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")))
    throw referenceInvalid();
  const extension = extname(file).toLowerCase();
  // Before source IDs, Pi Bot only cited Markdown and stripped its final extension.
  if (!hasSource) return extension === ".md" ? file : `${file}.md`;
  if (!extension) return `${file}.md`;
  if (!localDocumentKind(file)) throw referenceInvalid();
  return file;
}

/**
 * Resolve an assigned local source. Legacy links could only name an Obsidian vault.
 */
export function referenceCandidate(
  repo: KnowledgeRepo,
  scope: ReferenceScope,
  href: string,
  options?: { allowMissingIdentity?: boolean },
): ReferenceCandidate {
  const { vault: name, file, source } = parseObsidianOpen(href);
  // When the citation carries a source ID, match by that assigned source even if the folder was
  // later moved or renamed and repointed. Legacy citations without a source ID match by folder name.
  const matches = repo
    .assigned({ botId: scope.botId, ...(scope.groupId ? { groupId: scope.groupId } : {}) })
    .filter((entry) => {
      if (entry.config.kind !== "obsidian" && entry.config.kind !== "folder") return false;
      return source
        ? entry.source.id === source
        : entry.config.kind === "obsidian" && basename(entry.config.path) === name;
    });
  if (matches.length > 1)
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_ambiguous");
  const entry = matches[0];
  if (!entry) throw referenceInvalid();
  const config = entry.config;
  if (config.kind !== "obsidian" && config.kind !== "folder") throw referenceInvalid();
  // A source recorded before identities were stored cannot prove the folder is still the one the
  // person chose; the tab (or repoint action) has to record it again instead of this path writing
  // a new consent.
  if (!options?.allowMissingIdentity && (!config.device || !config.inode))
    throw referenceReselect();
  return {
    sourceId: entry.source.id,
    kind: config.kind,
    vault: obsidianVault(config),
    relativePath: file,
    ...(!source && extname(new URL(href).searchParams.get("file") ?? "").toLowerCase() === ".md"
      ? { legacyMarkdownAlternative: `${file}.md` }
      : {}),
  };
}

async function legacyMarkdownPath(
  candidate: ReferenceCandidate,
  alternative: string,
  signal: AbortSignal,
): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const exists = async (path: string) => {
    try {
      await abortable(lstat(join(candidate.vault.path, ...path.split("/"))), deadline);
      return true;
    } catch (error) {
      deadline.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw referenceInvalid();
    }
  };
  const [literalExists, legacyExists] = await Promise.all([
    exists(candidate.relativePath),
    exists(alternative),
  ]);
  if (literalExists && legacyExists)
    throw new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_ambiguous");
  return legacyExists ? alternative : candidate.relativePath;
}

/**
 * Reads the note once and throws the text away: the point is that the Bot's current read policy
 * and execution's own checks (vault root identity, ancestor links, hard links, sensitive paths)
 * pass for exactly this file. The click is *not* a way around a `read_file` deny — `access` is the
 * same gate a knowledge tool call uses, and an ask is allowed only because assigning the vault was
 * the consent (owner decision 2026-11-05).
 */
export async function verifyReference(
  candidate: ReferenceCandidate,
  access: VaultAccess,
): Promise<VerifiedReference> {
  const { vault } = candidate;
  if (!vault.identity) throw referenceReselect();
  const signal = access.signal;
  // Verify vault root identity BEFORE read policy so a vault replaced by a symlink or junction
  // reports `knowledge_vault_changed` (offering folder reselection) instead of a generic read deny.
  await vaultRoot(vault, signal);
  const ref = candidate.legacyMarkdownAlternative
    ? await legacyMarkdownPath(candidate, candidate.legacyMarkdownAlternative, signal)
    : candidate.relativePath;
  // Asked before the read so a policy denial says what it is; `readNote` asks again from its cache.
  const requested = join(vault.path, ...ref.split("/"));
  if (!(await access.authorizePath(requested, "file", signal))) throw referenceDenied();
  let relativePath: string;
  try {
    const note = await readNote(vault, ref, access);
    relativePath = note.path;
  } catch (error) {
    signal.throwIfAborted();
    // The vault moved or lost its identity: that is the source's own error, not a bad link.
    if (error instanceof RpcError) throw error;
    throw referenceInvalid();
  }
  const absolute = join(vault.path, ...relativePath.split("/"));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await abortable(
      lstat(absolute, { bigint: true }),
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
  } catch {
    signal.throwIfAborted();
    throw referenceInvalid();
  }
  // The host re-checks this identity right before the system open; a link swapped for a symlink
  // between the read and here fails now instead of opening something outside the vault.
  if (!info.isFile() || info.isSymbolicLink()) throw referenceInvalid();
  return {
    sourceId: candidate.sourceId,
    kind: candidate.kind,
    vaultPath: vault.path,
    vaultIdentity: vault.identity,
    notePath: relativePath,
    noteIdentity: fileIdentity(info),
  };
}

/** Whether a fresh verification still describes the same source, vault and note. */
export function sameReference(a: VerifiedReference, b: VerifiedReference): boolean {
  return (
    a.sourceId === b.sourceId &&
    a.vaultPath === b.vaultPath &&
    a.vaultIdentity.device === b.vaultIdentity.device &&
    a.vaultIdentity.inode === b.vaultIdentity.inode &&
    a.notePath === b.notePath &&
    a.noteIdentity.device === b.noteIdentity.device &&
    a.noteIdentity.inode === b.noteIdentity.inode
  );
}

function referenceMissing(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_missing");
}

export function referenceInvalid(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_invalid");
}

function referenceReselect(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_reselect");
}

export function referenceDenied(): RpcError {
  return new RpcError(RpcErrorCodes.unsupported, "knowledge_reference_denied");
}

export function referenceUnsupported(): RpcError {
  return new RpcError(RpcErrorCodes.unsupported, "knowledge_reference_unsupported");
}

export function referenceChanged(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_changed");
}
