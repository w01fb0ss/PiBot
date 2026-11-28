import type { IsolationStatus } from "@pibot/execution";
import { IsolationStatusSchema } from "@pibot/execution/isolation-probe";
// The subpath keeps `pibot status` from loading the whole execution package at startup.
import { linuxIsolationRemedy } from "@pibot/execution/isolation-remedy";

/**
 * The runner's log and `pibot runner status` are the only evidence on a headless Linux
 * box, so one record must carry the cause and the fix. Fields stay flat scalars because the logger
 * only accepts them; both languages are kept because the operator and the log reader may differ.
 */
export function isolationFields(isolation: IsolationStatus): Record<string, string | boolean> {
  const remedy = linuxIsolationRemedy(isolation.reason);
  return {
    available: isolation.available,
    ...(isolation.reason ? { reason: isolation.reason } : {}),
    ...(isolation.probe ? { probeStage: isolation.probe.stage } : {}),
    ...(isolation.probe?.stderr ? { probeStderr: isolation.probe.stderr } : {}),
    ...(remedy ? { remedyZh: remedy.zh, remedyEn: remedy.en } : {}),
  };
}

/** The control socket is local and token-guarded, but a stale peer may still answer anything. */
export function parseIsolation(value: unknown): IsolationStatus | undefined {
  const parsed = IsolationStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
