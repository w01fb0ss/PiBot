import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import {
  canonicalExistingPathSync,
  fileIdentity,
  samePathSpelling,
  sensitiveReadBoundary,
} from "@pibot/execution";
import { containsPath } from "@pibot/policy";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import type { ChangesTarget, WorkspaceSnapshot } from "@pibot/workspaces-contract/full";
import type { ChangesScope } from "../changes/changes-scope.ts";
import {
  type ManagedAction,
  managedError,
  primaryManagedScope,
  writableManagedScope,
} from "./managed-resource-ports.ts";

const writes = new Set<ManagedAction>([
  "allocate",
  "create",
  "integrate",
  "remove",
  "changes_write",
  "checkpoint_restore",
]);
const commandWrites = new Set<ManagedAction>([
  "allocate",
  "create",
  "integrate",
  "remove",
  "changes_write",
  "checkpoint_restore",
]);
export const managedTarget = (scope: ChangesScope): ChangesTarget => ({
  conversationKey: scope.conversationKey,
  ...(scope.topicId ? { topicId: scope.topicId } : {}),
  rootId: scope.root.id,
});

/** Captures the original source, never a synthetic run or a persistent approval grant. */
export class ManagedResourceAuthority {
  constructor(
    private readonly local: LocalService,
    private readonly resourceRevision: () => string,
  ) {}
  private source(scope: ChangesScope) {
    const { db } = this.local.deps;
    const bot = new BotsRepo(db).get(scope.botId);
    if (!bot || bot.archivedAt) managedError("managed_source_changed");
    const conversations = new ConversationsRepo(db);
    const group = scope.groupId ? new GroupsRepo(db).get(scope.groupId) : undefined;
    if (
      scope.groupId &&
      (!group ||
        group.coordinatorBotId !== scope.botId ||
        (scope.conversationId !== undefined && group.conversationId !== scope.conversationId))
    )
      managedError("managed_source_changed");
    const conversationId = group?.conversationId ?? scope.conversationId;
    const topic = conversationId ? conversations.get(conversationId) : undefined;
    if (conversationId && (!topic || topic.archivedAt || conversations.isInternal(conversationId)))
      managedError("managed_source_changed");
    if (!group && topic && (topic.kind !== "dm" || topic.botId !== scope.botId))
      managedError("managed_source_changed");
    // Without a DM topic, a management click cannot inherit some other topic's Execute mode.
    const execution = conversationId
      ? this.local.execution.get({ botId: scope.botId, conversationId })
      : undefined;
    return {
      bot: [bot.id, bot.archivedAt],
      source: group
        ? [
            group.id,
            group.coordinatorBotId,
            group.conversationId,
            group.workspaceRevision,
            group.folders,
            group.members,
          ]
        : [
            topic?.id,
            topic?.workplaceFolderId,
            topic?.workplaceRevision,
            topic?.archivedAt,
            topic ? undefined : this.local.workplaces.initial(scope.botId),
          ],
      execution,
      settings: group
        ? this.local.permissions.effectiveGroup(group.id)
        : this.local.permissions.effective(scope.botId),
    };
  }
  private rootsCurrent(scope: ChangesScope) {
    for (const root of scope.roots) {
      const info = lstatSync(root.path, { bigint: true });
      const current = fileIdentity(info);
      // A root without a recorded identity (null) never matches: unproven roots stay rejected.
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePathSpelling(canonicalExistingPathSync(root.path), resolve(root.path)) ||
        current.device !== root.device ||
        current.inode !== root.inode
      )
        managedError("managed_root_changed");
    }
  }
  private snapshot(scope: ChangesScope) {
    this.rootsCurrent(scope);
    return JSON.stringify(this.source(scope));
  }
  private path(path: string, scope: ChangesScope) {
    if (!path || path.length > 32_768 || /[\p{Cc}\p{Cf}]/u.test(path))
      managedError("managed_invalid_path");
    const absolute = resolve(scope.primary.path, path);
    // A relative checkpoint path is source-root relative; absolute management paths are core-issued.
    if (!isAbsolute(path) && !containsPath(scope.primary.path, absolute, this.local.deps.platform))
      managedError("managed_readonly_root");
    let parent = absolute;
    for (;;) {
      try {
        const info = lstatSync(parent);
        if (info.isSymbolicLink() || !samePathSpelling(canonicalExistingPathSync(parent), parent))
          managedError("managed_path_changed");
        if (!info.isDirectory()) parent = dirname(parent);
        return { absolute, parent, ...fileIdentity(lstatSync(parent, { bigint: true })) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const next = dirname(parent);
        if (next === parent) throw error;
        parent = next;
      }
    }
  }
  async read(scope: ChangesScope, signal: AbortSignal) {
    await this.authorize(scope, "checkpoint_create", [scope.root.path], signal, true);
  }
  async authorize(
    scope: ChangesScope,
    action: ManagedAction,
    paths: string[],
    signal: AbortSignal,
    readOnly = false,
  ) {
    signal.throwIfAborted();
    if (!paths.length || paths.length > 504) managedError("managed_invalid_path");
    if (!readOnly && action !== "inspect") {
      if (["changes_write", "checkpoint_restore", "checkpoint_create"].includes(action))
        writableManagedScope(scope);
      else primaryManagedScope(scope);
    }
    const snapshot = this.snapshot(scope),
      source = this.source(scope);
    const writing = !readOnly && writes.has(action);
    if (writing && source.execution?.mode !== "execute") managedError("managed_plan_readonly");
    if (writing && commandWrites.has(action) && source.settings.levels.run_command === "never")
      managedError("managed_permission_never");
    const resolved = paths.map((path) => this.path(path, scope));
    if (action === "remove")
      for (const item of resolved) {
        if (!scope.roots.some((root) => root.path === item.parent)) {
          item.parent = dirname(item.parent);
          Object.assign(item, fileIdentity(lstatSync(item.parent, { bigint: true })));
        }
      }
    const sensitive = await sensitiveReadBoundary(
      this.local.deps.platform,
      [this.local.deps.userHome],
      this.local.deps.env,
      { dataDir: this.local.deps.dataDir, botHome: scope.home },
    );
    const protectedRead = (path: string) =>
      sensitive.denyRead.some((root) => containsPath(root, path, this.local.deps.platform)) &&
      !sensitive.allowRead.some((root) => containsPath(root, path, this.local.deps.platform));
    const readonly = scope.roots
      .filter((root) => root.role === "readonly" && root.path !== scope.readonlySource)
      .map((root) => root.path);
    for (const { absolute } of resolved) {
      if (
        protectedRead(absolute) ||
        (writing &&
          (!sensitive.permitsWriteRoot(absolute) ||
            readonly.some(
              (root) =>
                containsPath(root, absolute, this.local.deps.platform) ||
                containsPath(absolute, root, this.local.deps.platform),
            )))
      )
        managedError("managed_readonly_root");
    }
    const policy = await this.local.getPolicy(signal);
    const readRoots = [
      ...new Set([
        ...scope.roots.map((root) => root.path),
        ...resolved.map((item) => item.absolute),
      ]),
    ];
    // Only a trusted typed operation gets these temporary roots. No ordinary run receives them.
    const boundary: WorkspaceSnapshot = {
      boundaryVersion: 1,
      location: { target: "local", platform: this.local.deps.platform },
      conflict: scope.boundaryConflict ? "readonly_overlaps_primary" : "none",
      roots: scope.roots.map((root) => ({
        id: root.id,
        path: root.path,
        canonicalPath: root.path,
        role: root.role,
        device: root.device,
        inode: root.inode,
      })),
      revision: 0,
      primaryId: scope.primary.id,
      primaryPath: scope.primary.path,
      readRoots,
      writeRoots: writing ? resolved.map((item) => item.absolute) : [],
      denyWriteRoots: [
        ...readonly,
        ...sensitive.readOnly,
        ...sensitive.denyRead.filter(
          (root) =>
            !sensitive.allowRead.some((allowed) =>
              containsPath(root, allowed, this.local.deps.platform),
            ),
        ),
      ],
    };
    const workplace = {
      home: scope.home,
      currentId: "home" as const,
      folders: scope.roots
        .filter((root) => root.id !== "home")
        .map((root) => ({ id: root.id, name: root.name, path: root.path })),
    };
    for (const { absolute } of resolved) {
      for (const category of writing
        ? (["read_file", "write_file"] as const)
        : (["read_file"] as const)) {
        const result = await policy.evaluate({
          botId: scope.botId,
          request: { category, path: absolute },
          settings: source.settings,
          permissionSources: this.local.permissions.sources(scope.botId, scope.groupId),
          workplace,
          boundary,
          cwd: scope.primary.path,
          signal,
        });
        if (result.decision === "deny")
          managedError(
            result.reason === "permission_never"
              ? "managed_permission_never"
              : "managed_policy_denied",
          );
        // The explicit user button consents only to this bound operation's ask; no grant is saved.
      }
    }
    const listing = await policy.evaluate({
      botId: scope.botId,
      request: { category: "list_dir", path: scope.root.path },
      settings: source.settings,
      permissionSources: this.local.permissions.sources(scope.botId, scope.groupId),
      workplace,
      boundary,
      cwd: scope.primary.path,
      signal,
    });
    if (listing.decision === "deny") managedError("managed_policy_denied");
    const revision = this.resourceRevision();
    const assertAuthorized = () => {
      signal.throwIfAborted();
      this.local.shutdown.signal.throwIfAborted();
      if (snapshot !== this.snapshot(scope) || revision !== this.resourceRevision())
        managedError("managed_authority_changed");
      for (const item of resolved) {
        const info = lstatSync(item.parent, { bigint: true });
        const current = fileIdentity(info);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          !samePathSpelling(canonicalExistingPathSync(item.parent), item.parent) ||
          current.device !== item.device ||
          current.inode !== item.inode
        )
          managedError("managed_path_changed");
      }
    };
    assertAuthorized();
    return { assertAuthorized };
  }
}
