import { homedir, tmpdir } from "node:os";
import { linuxIsolationRemedy } from "@pibot/execution";
import { sandboxDiagnosticMarkdown, sandboxDoctor } from "@pibot/execution/sandbox-doctor";
import { createTranslator, isolationReasonText, resolveLanguage } from "@pibot/i18n";

/** Print the host-side remedy because the doctor also runs without a graphical session. */
function sandboxRepairText(
  rows: Awaited<ReturnType<typeof sandboxDoctor>>,
  env: Readonly<NodeJS.ProcessEnv>,
): string {
  const language = resolveLanguage(
    "system",
    env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? env.LANGUAGE ?? "",
  );
  const translate = createTranslator(language);
  const reasons = [
    ...new Set(rows.filter((row) => row.status === "failed").map((row) => row.reason)),
  ];
  const repairs = reasons.flatMap((reason) => {
    const remedy =
      process.platform === "linux" && reason !== "sandbox_dependencies_or_runtime_unavailable"
        ? linuxIsolationRemedy(reason)
        : undefined;
    const text = remedy?.[language] ?? isolationReasonText(reason, translate);
    return text ? [`\n${language === "zh" ? "修复办法" : "Fix"} (${reason})\n${text}`] : [];
  });
  return repairs.length ? `${repairs.join("\n")}\n` : "";
}

/** Before normal startup: never creates an owner, a window or a database writer. */
export async function startSandboxDoctor(env: Readonly<NodeJS.ProcessEnv>, resourcesDir?: string) {
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  const timer = setTimeout(interrupt, 120_000);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    process.stdout.write(
      "Pi Bot 沙箱自检 / Sandbox doctor\n固定诊断规则（仅 example.com）；不读取或改变应用设置。 / Fixed diagnostic profile (example.com only); app settings are not read or changed.\n",
    );
    if (process.platform === "win32")
      process.stdout.write(
        "Windows：命令无隔离，保护/拒绝检查跳过。 / Windows: commands are unisolated; containment checks are skipped.\n",
      );
    const rows = await sandboxDoctor({
      platform: process.platform,
      env,
      systemHome: homedir(),
      tempDir: tmpdir(),
      resourcesDir,
      signal: stop.signal,
    });
    process.stdout.write(sandboxDiagnosticMarkdown(rows));
    process.stdout.write(sandboxRepairText(rows, env));
    return rows.some((row) => row.status === "failed") ? 1 : 0;
  } catch {
    // Neither thrown paths nor native command errors belong in the shareable report.
    process.stderr.write("沙箱自检未完成 / Sandbox doctor incomplete\n");
    return 1;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
