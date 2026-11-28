import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ResourceVerificationTimeout } from "@pibot/execution/resource-manifest";
import { verifyResources } from "./verify-resources.ts";

declare const __PIBOT_RUNNER_FIXTURE__: boolean;

async function main() {
  await verifyResources(dirname(process.execPath));
  if (process.argv[2] === "--pibot-internal") {
    const mode = process.argv[3];
    if (mode === "rtc") {
      const { runRtcChild } = await import("./rtc-child.ts");
      runRtcChild();
      return;
    }
    if (
      mode !== "sandbox-host" &&
      mode !== "violation-log" &&
      mode !== "uninstall-credentials" &&
      !(mode === "runner-fixture" && __PIBOT_RUNNER_FIXTURE__)
    )
      throw new Error("runner_helper_unsupported");
    process.argv.splice(2, 2);
    // A fixed CJS entry can be required from disk; SEA's own import() only accepts builtins.
    createRequire(process.execPath)(
      join(dirname(process.execPath), "resources", "entry", `${mode}.cjs`),
    );
  } else {
    await import("./index.ts");
  }
}
void main().catch((error: unknown) => {
  const code =
    error instanceof ResourceVerificationTimeout
      ? "runner_resources_timeout"
      : "runner_resources_invalid";
  process.stderr.write(
    `${JSON.stringify({ level: "error", event: "runner.resources_failed", code })}\n`,
  );
  process.exitCode = 78;
});
