import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fail } from "../../../tools/dev/process.ts";
import { SETUP_BUDGET_MS, scenarioBudget } from "./scenarios.ts";

for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-group-plan-")));
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  workerData: { root, selected: process.argv[2] },
});
type Progress = { type: "loaded" | "start" | "end"; name?: string; ms?: number };
// Transpiling the product sources without a cache is pure CPU work that took 150-250s at load
// 100; it is not part of any scenario, so it gets its own bound and the setup budget starts after it.
const LOAD_BUDGET_MS = 600_000;
const finished: string[] = [];
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  const result = await new Promise((resolve, reject) => {
    // The suite used to share one 300s deadline, which on a loaded machine expired before
    // any scenario returned and reported nothing but "timed out". Each scenario is real CPU work
    // (fixture ~2s, runs 30-80s measured at load 10), so the budget is per scenario: an overrunning
    // scenario is named, and the outer bound follows the scenario list instead of a fixed number
    // that goes stale whenever one is added.
    const timeout = (ms: number, message: string) => {
      clearTimeout(deadline);
      deadline = setTimeout(() => reject(new Error(message)), ms);
    };
    const remaining = () => (finished.length ? `; finished: ${finished.join(", ")}` : "");
    const expectStart = () =>
      timeout(
        SETUP_BUDGET_MS,
        `Dynamic plan acceptance did not start a scenario within ${SETUP_BUDGET_MS}ms${remaining()}`,
      );
    timeout(LOAD_BUDGET_MS, `Dynamic plan acceptance did not load within ${LOAD_BUDGET_MS}ms`);
    worker.on("message", (message: { progress?: Progress; result?: unknown; error?: string }) => {
      const progress = message.progress;
      if (progress?.type === "loaded") {
        expectStart();
        return;
      }
      if (progress?.type === "start" && progress.name) {
        const budget = scenarioBudget(progress.name);
        timeout(
          budget,
          `Dynamic plan scenario "${progress.name}" exceeded ${budget}ms${remaining()}`,
        );
        return;
      }
      if (progress?.type === "end") {
        finished.push(`${progress.name} ${progress.ms}ms`);
        console.log(`[group-plan] ${progress.name} done in ${progress.ms}ms`);
        expectStart();
        return;
      }
      if (message.error) {
        reject(new Error(message.error));
        return;
      }
      resolve(message.result);
    });
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`Acceptance worker exited before a result: ${code}`)),
    );
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  fail(error);
} finally {
  clearTimeout(deadline);
  // A failed product drain may retain timers/clients. Delete fixtures only after the worker exits.
  await worker.terminate();
  await rm(root, { recursive: true, force: true });
}
