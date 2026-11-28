import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { matchesFileIdentity } from "@pibot/execution";
import { type KernelMethodParams, RpcError } from "@pibot/protocol-base";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { selectGroupFolder } from "./group-folder-selection.ts";

/** A draft folder choice is short-lived and group-scoped; it never mutates live folder settings. */
export class GroupTopicFolderChoices {
  private readonly picking = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly choices = new Map<
    string,
    {
      groupId: string;
      path: string;
      displayPath: string;
      location?: string;
      expires: number;
      device: string;
      inode: string;
    }
  >();
  constructor(
    private readonly service: GroupOrchestrationPort,
    private readonly shutdown: AbortController,
  ) {}
  get(id: string) {
    return this.choices.get(id);
  }
  clear() {
    this.choices.clear();
  }
  pick(
    groupId: string,
    remote: Pick<KernelMethodParams["groups.topics.pickFolder"], "location" | "path"> = {},
    parent?: AbortSignal,
  ) {
    const operation = this.pickOwned(groupId, remote, parent).finally(() =>
      this.pending.delete(operation),
    );
    this.pending.add(operation);
    return operation;
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
  private async pickOwned(
    groupId: string,
    remote: Pick<KernelMethodParams["groups.topics.pickFolder"], "location" | "path">,
    parent?: AbortSignal,
  ) {
    if (this.picking.has(groupId) || this.picking.size >= 8)
      throw new RpcError(-32011, "group_topic_busy");
    this.picking.add(groupId);
    try {
      const signal = AbortSignal.any([
        this.shutdown.signal,
        this.service.deps.local.shutdown.signal,
        AbortSignal.timeout(630000),
        ...(parent ? [parent] : []),
      ]);
      const selected = await selectGroupFolder(
        this.service.deps.local,
        !remote.location,
        remote,
        signal,
      );
      signal.throwIfAborted();
      if (!selected) return null;
      for (const [id, choice] of this.choices)
        if (choice.expires < Date.now()) this.choices.delete(id);
      if (this.choices.size >= 128) throw new RpcError(-32011, "Folder picker busy");
      const choiceId = randomUUID();
      this.choices.set(choiceId, {
        groupId,
        ...selected,
        expires: Date.now() + 30 * 60 * 1000,
      });
      return {
        choiceId,
        path: selected.displayPath,
        name: selected.name,
        location: selected.location,
      };
    } finally {
      this.picking.delete(groupId);
    }
  }
  async verify(
    choice: { path: string; location?: string; device: string; inode: string },
    parent?: AbortSignal,
  ) {
    const owner = AbortSignal.any([
      this.shutdown.signal,
      this.service.deps.local.shutdown.signal,
      ...(parent ? [parent] : []),
    ]);
    owner.throwIfAborted();
    if (choice.location) {
      const signal = AbortSignal.any([owner, AbortSignal.timeout(20_000)]);
      const current = await selectGroupFolder(this.service.deps.local, false, choice, signal);
      if (
        !current ||
        current.path !== choice.path ||
        current.device !== choice.device ||
        current.inode !== choice.inode
      )
        throw new RpcError(-32602, "group_topic_folder_expired");
      return;
    }
    const info = await stat(choice.path, { bigint: true });
    owner.throwIfAborted();
    if (
      !info.isDirectory() ||
      (await realpath(choice.path)) !== choice.path ||
      !matchesFileIdentity(info, choice)
    )
      throw new RpcError(-32602, "group_topic_folder_expired");
    owner.throwIfAborted();
  }
}
