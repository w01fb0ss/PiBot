import type { DatabaseSync } from "node:sqlite";
import { ModelHealthReasonSchema } from "@pibot/models-contract";
import { z } from "zod";

const outcome = z.object({
  provider: z.string(),
  model: z.string(),
  error: z.string().nullable(),
  at: z.string(),
});

/** Bounded recent evidence, never a probe; only an explicitly recorded model owns a failure. */
export function recentModelOutcomes(db: DatabaseSync, cutoff: string) {
  const rows = db
    .prepare(`
    SELECT json_extract(m.usage,'$.runModel.provider') AS provider,
      json_extract(m.usage,'$.runModel.id') AS model,
      m.error_code AS error, r.finished_at AS at
    FROM (SELECT message_id,finished_at FROM runs ORDER BY rowid DESC LIMIT 200) r
    JOIN messages m ON m.id=r.message_id
    WHERE r.finished_at>=? AND m.status IN ('done','error') AND json_valid(m.usage)
    UNION ALL
    SELECT e.model_provider,e.model_id,e.error,e.finished_at
    FROM (SELECT * FROM memory_extractions ORDER BY rowid DESC LIMIT 100) e
    WHERE e.finished_at>=? AND (e.status='done' OR (e.status='failed' AND EXISTS (
      SELECT 1 FROM background_task_health h
      WHERE h.task='memory_extraction' AND h.subject=e.bot_id AND h.reason_code=e.error)))
    UNION ALL
    SELECT e.model_provider,e.model_id,e.error,e.finished_at
    FROM (SELECT * FROM memory_organizations ORDER BY rowid DESC LIMIT 100) e
    WHERE e.finished_at>=? AND (e.status='done' OR (e.status='failed' AND EXISTS (
      SELECT 1 FROM background_task_health h
      WHERE h.task='memory_organization' AND h.subject=e.bot_id AND h.reason_code=e.error)))
    UNION ALL
    SELECT json_extract(e.payload,'$.provider'),json_extract(e.payload,'$.model'),
      json_extract(e.payload,'$.error'),e.at
    FROM (SELECT payload,at FROM run_events WHERE kind='model.startup_failed' AND at>=?
          ORDER BY at DESC LIMIT 100) e
    ORDER BY at DESC
  `)
    .all(cutoff, cutoff, cutoff, cutoff);
  return rows.flatMap((row) => {
    const parsed = outcome.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Only an explicitly recorded model owns a warning in the model picker. */
export function recordedModelHealth(
  db: DatabaseSync,
  models: readonly { provider: string; id: string }[],
) {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const latest = new Map<string, z.infer<typeof outcome>>();
  for (const row of recentModelOutcomes(db, cutoff)) {
    const key = JSON.stringify([row.provider, row.model]);
    if (!latest.has(key)) latest.set(key, row);
  }
  return models.map((model) => {
    const row = latest.get(JSON.stringify([model.provider, model.id]));
    if (!row) return null;
    // Saving credentials/configuration retires older evidence. A later successful run also
    // replaces the failure, so changing an account does not leave a permanent warning.
    const changed = db.prepare("SELECT updated_at FROM providers WHERE id=?").get(model.provider);
    if (typeof changed?.updated_at === "string" && changed.updated_at > row.at) return null;
    const reason = ModelHealthReasonSchema.safeParse(row.error);
    return reason.success ? reason.data : null;
  });
}
