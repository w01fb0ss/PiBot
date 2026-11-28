import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appArmorExecutable } from "@pibot/execution/isolation-remedy";
import {
  linuxUserNamespaceRestriction,
  linuxUserNamespaceSettings,
} from "@pibot/execution/linux-userns";
import { type TranslationKey, t } from "@pibot/i18n";
import { installedFromDeb } from "./package-type.ts";

/**
 * This check runs on the bundled helper Node (Pi Bot's executable has RunAsNode off);
 * the launcher names Pi Bot's own binary for the Chromium probe.
 */
function appBinary() {
  const binary = process.env.PIBOT_APP_BINARY;
  if (!binary?.startsWith("/")) throw new Error("linux_sandbox_check_binary");
  return binary;
}

const unsafeSwitch =
  /^--(?:no-sandbox|single-process|no-zygote(?:-sandbox)?|disable-(?:namespace|seccomp-filter|gpu|renderer)-sandbox)(?:=|$)/;

/** Kill the entire probe group, including Chromium's zygote/renderers, even on timeout/abort. */
function command(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout: number,
  input?: string,
): Promise<{ ok: boolean; output: string; exitCode?: number | null }> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ ok: false, output: "" });
    const child = spawn(file, args, { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    // Dialogs may close before consuming their static text; a closed stdin is harmless.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    let output = "";
    let settled = false;
    let failed = false;
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group may already have exited. Never log OS errors containing paths/env.
      }
    };
    const abort = () => {
      failed = true;
      kill();
    };
    const timer = setTimeout(abort, timeout);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 1024) abort();
      else output += data.toString("utf8");
    });
    child.once("error", () => {
      failed = true;
    });
    child.once("exit", kill);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      resolve({ ok: !failed && code === 0, output, exitCode: failed ? undefined : code });
    });
  });
}

async function chromiumWorks(signal: AbortSignal): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), "pibot-chromium-probe-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const result = await command(
      appBinary(),
      ["--disable-setuid-sandbox", "--pibot-sandbox-probe", `--user-data-dir=${directory}`],
      env,
      signal,
      15_000,
    );
    return result.ok && result.output.includes("pibot_chromium_sandbox_ready\n");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function failure(signal: AbortSignal): Promise<TranslationKey | undefined> {
  if (
    process.env.ELECTRON_DISABLE_SANDBOX ||
    process.argv.slice(2).some((arg) => unsafeSwitch.test(arg))
  )
    return "linuxStartup.flags";
  if (process.getuid?.() === 0) return "linuxStartup.root";
  // ACP attaches over stdio/socket to an existing owner; it never creates Chromium windows.
  if (process.argv.slice(2).includes("--acp")) return undefined;
  const settings = await linuxUserNamespaceSettings(signal);
  const blocked = linuxUserNamespaceRestriction(settings);
  if (blocked === "kernel.unprivileged_userns_clone") return "linuxStartup.clone";
  if (blocked === "user.max_user_namespaces") return "linuxStartup.max";
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return "linuxStartup.runtime";
  if (await chromiumWorks(signal)) return undefined;
  // A profile may allow userns with the sysctl still set. Only explain it after a real failure.
  if (settings.apparmor !== 1) return "linuxStartup.runtime";
  return (await installedFromDeb(appBinary()))
    ? "linuxStartup.apparmorDeb"
    : "linuxStartup.apparmor";
}

function startupLanguage() {
  // The gate runs before user preferences can be loaded. Follow the desktop locale.
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  return /^zh(?:[-_.]|$)/i.test(locale ?? "") ? "zh" : "en";
}

async function explain(key: TranslationKey, signal: AbortSignal) {
  const language = startupLanguage();
  const title = t("linuxStartup.title", undefined, language);
  const message = [
    t("linuxStartup.intro", undefined, language),
    t(key, undefined, language),
    ...(key === "linuxStartup.apparmor" ? [t("linuxStartup.useDeb", undefined, language)] : []),
  ].join("\n\n");
  const detailKeys: Partial<Record<TranslationKey, TranslationKey>> = {
    "linuxStartup.apparmor": "linuxStartup.apparmorDetails",
    "linuxStartup.apparmorDeb": "linuxStartup.apparmorDebDetails",
    "linuxStartup.flags": "linuxStartup.flagsDetails",
    "linuxStartup.clone": "linuxStartup.cloneDetails",
    "linuxStartup.max": "linuxStartup.maxDetails",
  };
  const detailKey = detailKeys[key];
  const advanced = t("linuxStartup.advanced", undefined, language);
  const details =
    detailKey &&
    t(
      detailKey,
      { appImagePath: appArmorExecutable(process.env.APPIMAGE ?? process.env.PIBOT_APP_BINARY) },
      language,
    );
  const fullMessage = details ? `${message}\n\n${advanced}\n${details}` : message;
  process.stderr.write(
    `${JSON.stringify({
      module: "linux-startup",
      event: "sandbox_refused",
      reason:
        key === "linuxStartup.clone"
          ? "linux_userns_disabled"
          : key === "linuxStartup.max"
            ? "linux_userns_limit_zero"
            : key === "linuxStartup.apparmor" || key === "linuxStartup.apparmorDeb"
              ? "linux_userns_restricted"
              : "sandbox_dependencies_or_runtime_unavailable",
      detail: key,
    })}\n${title}\n\n${fullMessage}\n`,
  );
  const dialogEnv = { ...process.env };
  // AppImage's bundled libraries/schemas are for Electron, not the system's GTK/Qt dialog.
  delete dialogEnv.LD_LIBRARY_PATH;
  delete dialogEnv.GSETTINGS_SCHEMA_DIR;
  const close = t("linuxStartup.close", undefined, language);
  // Native dialogs work even when the app's window cannot start.
  if (details) {
    for (const [file, args] of [
      [
        "/usr/bin/zenity",
        [
          "--question",
          `--title=${title}`,
          `--text=${message}`,
          "--no-markup",
          `--ok-label=${advanced}`,
          `--cancel-label=${close}`,
        ],
      ],
      [
        "/usr/bin/kdialog",
        ["--title", title, "--yes-label", advanced, "--no-label", close, "--yesno", message],
      ],
      [
        "/usr/bin/xmessage",
        ["-center", "-title", title, "-buttons", `${close}:1,${advanced}:0`, message],
      ],
    ] as const) {
      if (signal.aborted) return;
      const choice = await command(file, [...args], dialogEnv, signal, 60_000);
      if (choice.exitCode === 1) return;
      if (choice.ok) {
        await showExplanation(title, details, dialogEnv, signal);
        return;
      }
    }
  }
  await showExplanation(title, fullMessage, dialogEnv, signal);
}

async function showExplanation(
  title: string,
  message: string,
  dialogEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  for (const [file, args] of [
    ["/usr/bin/zenity", ["--text-info", "--width=800", "--height=600", `--title=${title}`]],
    ["/usr/bin/kdialog", ["--title", title, "--error", message]],
    ["/usr/bin/xmessage", ["-center", "-geometry", "900x650", "-title", title, message]],
  ] as const) {
    if (signal.aborted) break;
    if (
      (
        await command(
          file,
          [...args],
          dialogEnv,
          signal,
          60_000,
          file === "/usr/bin/zenity" ? message : undefined,
        )
      ).ok
    )
      break;
  }
}

async function main() {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  try {
    let key: TranslationKey | undefined;
    try {
      key = await failure(AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]));
    } catch {
      key = "linuxStartup.runtime";
    }
    if (key) await explain(key, lifetime.signal);
    process.exitCode = key || lifetime.signal.aborted ? 1 : 0;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}

void main().catch(() => {
  // No raw probe stderr, filesystem paths, environment values or exceptions cross this boundary.
  process.stderr.write(`${t("linuxStartup.runtime", undefined, startupLanguage())}\n`);
  process.exitCode = 1;
});
