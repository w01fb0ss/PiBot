import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fail } from "../../../tools/dev/process.ts";

// Probe (+ owner decisions 2026-10-23): paid generation asks first (also under YOLO), a
// remembered Bot + model and a routine pre-approval skip the card, a denied card sends nothing, an allowed
// request comes first, followed by compact guidance and norms, and no prompt text reaches the audit.
// IMAGE-RUN-UX: a held request times out (error + Retry + audit "timeout"), a stop stays aborted,
// and each request writes one diagnostic log line with lengths only.
// Run: node tests/e2e/image-norms/index.ts
// Output: structural facts only (states, counts, section markers), never the prompt or keys.
for (const name of Object.keys(process.env)) {
  if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR"].includes(name))
    delete process.env[name];
}
const root = await realpath(await mkdtemp(join(tmpdir(), "pibot-image-norms-")));
try {
  const desktop = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const vite = createRequire(desktop.resolve("vite/package.json"));
  const { createJiti } = vite("jiti");
  const loader = createJiti(import.meta.url, { fsCache: false });
  const { runImageNormsProbe } = await loader.import("./probe.ts");
  console.log(JSON.stringify(await runImageNormsProbe(root), null, 2));
} catch (error) {
  fail(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
