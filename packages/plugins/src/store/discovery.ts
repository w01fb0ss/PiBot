import type { DatabaseSync } from "node:sqlite";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";

const CONSENT_KEY = "connections.discoverConsent";

/**
 * Whether the person agreed that Pi Bot may look at other AI tools' skills and
 * MCP settings. Kept in the app settings table under its own key (default: not agreed).
 */
export class DiscoveryConsentRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(CONSENT_KEY);
    return row?.value === "true";
  }

  set(allow: boolean): boolean {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(CONSENT_KEY, JSON.stringify(allow));
    return allow;
  }
}

/** The other AI tool an installation was brought over from, if any. */
export function installationOrigin(db: DatabaseSync, installationId: string) {
  const row = db
    .prepare("SELECT origin_tool AS tool FROM plugin_installations WHERE id=?")
    .get(installationId);
  return row?.tool == null ? undefined : String(row.tool);
}

/** Bots and groups that received a copy of an imported plugin's skills (bounded). */
export function skillCopyTargets(db: DatabaseSync, installationId: string) {
  const rows = db
    .prepare(
      "SELECT DISTINCT target_kind AS kind, target_id AS id FROM plugin_skill_copies WHERE installation_id=? LIMIT 500",
    )
    .all(installationId);
  return {
    bots: rows.filter((row) => row.kind === "bot").map((row) => String(row.id)),
    groups: rows.filter((row) => row.kind === "group").map((row) => String(row.id)),
  };
}

/** Ids and names of installed plugins / MCP configurations, for marking scan clashes. */
export function installedManifestNames(
  db: DatabaseSync,
): { pluginId: string; originKey: string | null; names: string[] }[] {
  return db
    .prepare(
      "SELECT plugin_id AS pluginId, origin_key AS originKey, manifest_json AS manifest FROM plugin_installations WHERE status='installed' LIMIT 2000",
    )
    .all()
    .map((row) => {
      let names: string[] = [];
      try {
        const manifest = JSON.parse(String(row.manifest)) as {
          name?: { zh?: string; en?: string };
        };
        names = [manifest.name?.zh, manifest.name?.en].filter(
          (value): value is string => typeof value === "string",
        );
      } catch {
        // A row that predates manifest_json simply has no name to clash with.
      }
      return {
        pluginId: String(row.pluginId),
        originKey: row.originKey == null ? null : String(row.originKey),
        names,
      };
    });
}

export function freeInstalledName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name.slice(0, 190)} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new RpcError(RpcErrorCodes.invalidParams, "skill_name_exists");
}
