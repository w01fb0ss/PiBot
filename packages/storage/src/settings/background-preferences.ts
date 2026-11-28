import type { DatabaseSync } from "node:sqlite";
import { type BackgroundPreferences, BackgroundPreferencesSchema } from "@pibot/protocol-base";

// The shared settings table already supports independent namespaces; no schema migration.
export class BackgroundPreferencesRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(): BackgroundPreferences {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("independentBackground");
    let raw: unknown = {};
    try {
      raw = row ? JSON.parse(String(row.value)) : {};
    } catch {
      // Unreadable JSON is treated as unset: every field falls back to its default below.
    }
    const parsed = BackgroundPreferencesSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // One invalid value (an older or hand-edited row) must not stop the background from starting
    // in a loop: keep the valid fields and default the rest.
    const shape = BackgroundPreferencesSchema.shape;
    const kept: Record<string, unknown> = {};
    if (raw && typeof raw === "object")
      for (const [key, value] of Object.entries(raw))
        if (Object.hasOwn(shape, key) && shape[key as keyof typeof shape].safeParse(value).success)
          kept[key] = value;
    return BackgroundPreferencesSchema.parse(kept);
  }
  set(value: BackgroundPreferences): BackgroundPreferences {
    const parsed = BackgroundPreferencesSchema.parse(value);
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("independentBackground", JSON.stringify(parsed));
    return parsed;
  }
}
