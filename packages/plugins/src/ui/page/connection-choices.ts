import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useRpc, useRpcEvent, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { useCallback } from "react";
import { connectorError, useConnectorRead } from "../shell/remote.ts";
import {
  type AccessTarget,
  accessIsOn,
  toggleConnectionAccess,
} from "./connections/access-grant.ts";

const load = async (peer: Peer, signal: AbortSignal) => {
  const [summaries, connectors] = await Promise.all([
    peer.call("plugins.available", { limit: 100 }, { signal }),
    peer.call("connectors.list", { limit: 100 }, { signal }),
  ]);
  return { summaries: summaries.items, connectors: connectors.items };
};

/**
 * The connections page's MCP list (MCP configurations, and plugin packages that carry servers) as
 * on / off choices for one Bot or group, for the skills tab's 「从连接选择」. Applying flips each
 * changed row through the same who-can-use write as the connection panel's faces.
 */
export function useConnectionChoices(target: AccessTarget) {
  const { language } = useSettings();
  const { peer } = useRpc();
  const workspace = useWorkspace();
  const read = useConnectorRead(load);
  const refresh = read.refresh;
  const changed = useCallback(() => refresh(), [refresh]);
  useRpcEvent("plugins.changed", changed);
  useRpcEvent("connectors.changed", changed);
  const connectorsOf = (installationId: string) =>
    read.value?.connectors.filter((row) => row.pluginInstallationId === installationId) ?? [];
  const items = (read.value?.summaries ?? []).filter(
    (summary) =>
      !summary.managedByKnowledge &&
      (summary.sourceKind === "json" ||
        (summary.sourceKind === "directory" && connectorsOf(summary.installationId).length > 0)),
  );
  const rows = items.map((summary) => ({
    id: summary.installationId,
    name: summary.name[language],
    description: summary.description[language],
    on: accessIsOn(summary.access, target),
  }));
  const apply = async (
    wanted: ReadonlyMap<string, boolean>,
  ): Promise<TranslationKey | undefined> => {
    if (!peer) return "connectors.offline";
    const botIds = workspace.bots.filter((bot) => !bot.archivedAt).map((bot) => bot.id);
    const signal = AbortSignal.timeout(30_000);
    try {
      for (const summary of items) {
        const on = wanted.get(summary.installationId);
        if (on === undefined || on === accessIsOn(summary.access, target)) continue;
        await toggleConnectionAccess(peer, signal, {
          summary,
          connectors: connectorsOf(summary.installationId),
          botIds,
          target,
        });
      }
      return undefined;
    } catch (failure) {
      return connectorError(failure);
    } finally {
      // A stale revision or a partial batch must show the server's current access, not the clicks.
      refresh();
    }
  };
  return { rows, loading: read.loading, error: read.error, retry: refresh, apply };
}
