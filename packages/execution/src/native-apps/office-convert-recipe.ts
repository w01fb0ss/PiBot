import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { tempCommand } from "../command/command-context.ts";
import { commandEnvironment } from "../command/environment.ts";
import { executeHostedCommand } from "../command/foreground-host.ts";
import { cleanupRecord, type ProcessControl } from "../command/process.ts";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { createSandboxConfig } from "../sandbox/sandbox-config.ts";
import { engineCandidates, findEngine, libreOfficePlatformSupported } from "./office-convert.ts";
import type { createOfficeConvertCleanup } from "./office-convert-cleanup.ts";

const TIMEOUT_MS = 120_000;
/** Same ceiling as the in-process Office chain; a larger rendering is refused, never truncated. */
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export type OfficeConvertSource = "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt";
export type OfficeConvertTarget = "pdf" | "docx" | "xlsx" | "pptx";

export type OfficeLibreOfficeReason =
  | "libreoffice_missing"
  | "libreoffice_platform_unsupported"
  | "libreoffice_isolation_unavailable"
  | "libreoffice_unsupported_format"
  | "libreoffice_failed"
  | "libreoffice_cleanup_unconfirmed"
  | "libreoffice_timeout";

export type OfficeLibreOfficeResult =
  | { status: "converted"; bytes: Uint8Array }
  | { status: "unavailable"; reason: OfficeLibreOfficeReason };

export interface OfficeConvertInput {
  bytes: Uint8Array;
  source: OfficeConvertSource;
  target: OfficeConvertTarget;
  signal: AbortSignal;
  /** Re-checks the user's approval immediately before the sandbox acknowledges dispatch. */
  assertCurrent(): void;
}

const LEGACY_TARGETS: Partial<Record<OfficeConvertSource, OfficeConvertTarget>> = {
  doc: "docx",
  xls: "xlsx",
  ppt: "pptx",
};

/** A doc/xls/ppt input only converts to its own OOXML family; PDF stays available from all six. */
export function officeConvertTarget(source: OfficeConvertSource, target: OfficeConvertTarget) {
  if (target === "pdf") return true;
  return LEGACY_TARGETS[source] === target;
}

function quote(word: string) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * Runs one fixed LibreOffice conversion: the model never supplies a program, argument list or path.
 * Each run gets its own throwaway profile so concurrent conversions cannot fight over a lock, and the
 * sandbox profile is narrowed to that one directory instead of the ordinary command roots.
 */
export async function convertOfficeDocument(
  options: ExecOptions & { dataDir: string },
  input: OfficeConvertInput,
  cleanup: ReturnType<typeof createOfficeConvertCleanup>,
): Promise<OfficeLibreOfficeResult> {
  if (!officeConvertTarget(input.source, input.target))
    return { status: "unavailable", reason: "libreoffice_unsupported_format" };
  if (!input.bytes.length || input.bytes.length > MAX_INPUT_BYTES)
    throw new ExecError("invalid_input");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  // Windows has no command sandbox, and this recipe never falls back to an unisolated run.
  if (!libreOfficePlatformSupported(options.platform))
    return { status: "unavailable", reason: "libreoffice_platform_unsupported" };
  const engine = await findEngine(engineCandidates(options.platform, options.env), signal);
  if (!engine) return { status: "unavailable", reason: "libreoffice_missing" };
  let owner: string | undefined;
  let retained: ReturnType<typeof cleanupRecord>;
  try {
    owner = await cleanup.create();
    const work = join(owner, "work");
    await mkdir(work, { mode: 0o700 });
    const directory = owner;
    return await convertIn(options, input, work, engine, signal, (tree) =>
      cleanup.arm(directory, tree),
    );
  } catch (error) {
    retained = cleanupRecord(error);
    if (retained) return { status: "unavailable", reason: "libreoffice_cleanup_unconfirmed" };
    if (input.signal.aborted) throw new ExecError("command_failed", "cancelled");
    if (signal.aborted) return { status: "unavailable", reason: "libreoffice_timeout" };
    if (error instanceof ExecError) {
      if (
        error.code === "isolation_unavailable" ||
        ["isolation_unavailable", "sandbox_unavailable"].includes(String(error.reason))
      )
        return { status: "unavailable", reason: "libreoffice_isolation_unavailable" };
      if (error.reason === "cancelled")
        return { status: "unavailable", reason: "libreoffice_timeout" };
    }
    return { status: "unavailable", reason: "libreoffice_failed" };
  } finally {
    if (owner)
      await cleanup.finish(
        owner,
        retained && { group: retained.group, processes: retained.processes },
      );
  }
}

async function convertIn(
  options: ExecOptions & { dataDir: string },
  input: {
    bytes: Uint8Array;
    source: OfficeConvertSource;
    target: OfficeConvertTarget;
    signal: AbortSignal;
    assertCurrent(): void;
  },
  work: string,
  engine: string,
  signal: AbortSignal,
  armCleanup: (tree: ReturnType<ProcessControl["record"]>) => Promise<void>,
): Promise<OfficeLibreOfficeResult> {
  const inbound = join(work, "in");
  const outbound = join(work, "out");
  const profile = join(work, "profile");
  await Promise.all([inbound, outbound, profile].map((path) => mkdir(path, { mode: 0o700 })));
  const source = join(inbound, `input.${input.source}`);
  await writeFile(source, input.bytes, { mode: 0o600, flag: "wx" });
  const sandbox = createSandboxConfig(options);
  // The recipe uses its own temp directory as HOME. Deny the app data tree without granting
  // access to any Bot home, skills or attachments, and require the private temp to stay writable.
  const config = await sandbox.config(
    [],
    { allowAll: false, domains: [] },
    signal,
    { dataDir: options.dataDir },
    [],
    false,
    false,
    undefined,
    false,
    work,
  );
  if (
    config.filesystem.allowWrite.length !== 1 ||
    !config.filesystem.allowWrite.some((root) => typeof root !== "string" && root.path === work)
  )
    throw new ExecError("outside_workplace");
  const env = commandEnvironment(options.platform, options.env, work, work);
  const command = [
    engine,
    "--headless",
    "--norestore",
    "--nodefault",
    "--nolockcheck",
    `-env:UserInstallation=${pathToFileURL(profile).href}`,
    "--convert-to",
    input.target,
    "--outdir",
    outbound,
    source,
  ]
    .map(quote)
    .join(" ");
  // Conversion output may contain document data. Keep it out of persistent command logs.
  const log = new Writable({ write: (_chunk, _encoding, done) => done() });
  try {
    const result = await executeHostedCommand({
      options,
      config,
      allowAll: false,
      command: tempCommand(command, work),
      commandText: "office_convert_libreoffice",
      commandId: randomUUID(),
      cwd: work,
      env,
      signal,
      log,
      dispatch: () => input.assertCurrent(),
      prepared: async (record) => {
        input.assertCurrent();
        if (!record) throw new ExecError("command_failed");
        // The host waits for dispatch, so it cannot start LibreOffice before this record exists.
        await armCleanup(record());
      },
    });
    signal.throwIfAborted();
    if (result.exitCode !== 0 || (await realpath(outbound)) !== outbound)
      return { status: "unavailable", reason: "libreoffice_failed" };
  } finally {
    log.destroy();
  }
  const output = await open(
    join(outbound, `input.${input.target}`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await output.stat();
    if (!info.isFile() || info.nlink !== 1 || !info.size || info.size > MAX_OUTPUT_BYTES)
      return { status: "unavailable", reason: "libreoffice_failed" };
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await output.read({ buffer });
    signal.throwIfAborted();
    if (bytesRead !== info.size) return { status: "unavailable", reason: "libreoffice_failed" };
    return { status: "converted", bytes: buffer };
  } finally {
    await output.close();
  }
}
