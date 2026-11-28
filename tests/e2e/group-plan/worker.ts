import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const { runGroupPlanProbe } = await createJiti(import.meta.url, { fsCache: false }).import(
    "./probe.ts",
  );
  parentPort?.postMessage({ progress: { type: "loaded" } });
  parentPort?.postMessage({
    result: await runGroupPlanProbe(workerData.root, workerData.selected, (progress: unknown) =>
      // Forward scenario boundaries so the supervisor times one scenario at a time.
      parentPort?.postMessage({ progress }),
    ),
  });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : "acceptance_failed" });
}
