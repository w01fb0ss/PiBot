import {
  type GrantListItem,
  type KernelMethodParams,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { ConversationsRepo } from "@pibot/storage";
import type { LocalService } from "../../local-service.ts";

/** Display the current authority, never the stale root where a topic grant was first created. */
export async function grantList(
  local: LocalService,
  params: KernelMethodParams["grants.list"],
  parent: AbortSignal,
): Promise<GrantListItem[]> {
  const signal = AbortSignal.any([parent, local.shutdown.signal, AbortSignal.timeout(20_000)]);
  const topics = new ConversationsRepo(local.deps.db);
  const metadata = new Map<string, NonNullable<GrantListItem["topicWorkplace"]>>();
  const result: GrantListItem[] = [];
  for (const grant of local.approvals.grants.list(params)) {
    signal.throwIfAborted();
    const scope = grant.scope;
    if (scope.kind === "paid_image") {
      const providerName = local.models?.providerName(scope.provider);
      result.push(providerName ? { ...grant, providerName } : grant);
      continue;
    }
    if ((scope.kind !== "programs" && scope.kind !== "workplace") || !scope.topicId) {
      result.push(grant);
      continue;
    }
    const target = scope.target ?? "local";
    const key = `${grant.botId}:${scope.topicId}:${target}`;
    let value = metadata.get(key);
    if (!value) {
      const topic = topics.get(scope.topicId);
      value = {
        title: topic?.botId === grant.botId ? (topic.title ?? "") : "",
        writeRoots: [],
        available: false,
      };
      if (topic?.kind === "dm" && topic.botId === grant.botId && !topic.archivedAt) {
        try {
          const snapshot = local.workplaces.topic(topic.id);
          const place = await local.workplaces.context(grant.botId, signal, snapshot);
          if (local.workplaces.topic(topic.id).revision !== snapshot.revision)
            throw new RpcError(RpcErrorCodes.invalidParams, "topic_workplace_changed");
          const available = (place.boundary.location?.target ?? "local") === target;
          value = {
            title: topic.title ?? "",
            writeRoots: available ? place.boundary.writeRoots : [],
            available,
          };
        } catch (error) {
          signal.throwIfAborted();
          const errno = (error as { code?: unknown } | null)?.code;
          // Missing/moved or unsupported workplaces remain revocable and explicitly unavailable.
          if (
            !(
              error instanceof RpcError &&
              [
                RpcErrorCodes.invalidParams,
                RpcErrorCodes.unsupported,
                RpcErrorCodes.methodNotFound,
              ].some((code) => code === error.code)
            ) &&
            !(
              typeof errno === "string" &&
              ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(errno)
            )
          )
            throw error;
        }
      }
      metadata.set(key, value);
    }
    result.push({ ...grant, topicWorkplace: value });
  }
  return result;
}
