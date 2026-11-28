import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { RunnerRedactor } from "./redactor.ts";

export type RunnerLogLevel = "info" | "warn" | "error";
export interface RunnerLogger {
  write(
    level: RunnerLogLevel,
    event: string,
    fields?: Record<string, string | number | boolean>,
  ): void;
}

const DAY = 24 * 60 * 60 * 1000;

function prepareLogDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runner_log_dir_insecure");
    return;
  }
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isDirectory() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new Error("runner_log_dir_insecure");
    if ((info.mode & 0o077) !== 0) fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
}

function appendPrivate(path: string, value: string) {
  const descriptor = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))
    )
      throw new Error("runner_log_file_insecure");
    writeSync(descriptor, value, null, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function prune(directory: string, date: string) {
  const oldest = new Date(Date.parse(date) - 13 * DAY).toISOString().slice(0, 10);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
    if (!entry.isFile() || !match?.[1] || match[1] >= oldest) continue;
    try {
      unlinkSync(join(directory, entry.name));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

export function createRunnerLogger(
  directory: string,
  redactor: RunnerRedactor,
  consoleTarget: "stdout" | "stderr" = "stdout",
  consoleMinimum: RunnerLogLevel = "info",
): RunnerLogger {
  prepareLogDirectory(directory);
  let retained = new Date().toISOString().slice(0, 10);
  prune(directory, retained);
  let reported = false;
  return {
    write(level, event, fields = {}) {
      const timestamp = new Date().toISOString();
      const date = timestamp.slice(0, 10);
      const line = redactor.redact(JSON.stringify({ timestamp, level, event, ...fields }));
      try {
        if (date !== retained) {
          retained = date;
          prune(directory, date);
        }
        appendPrivate(join(directory, `${date}.log`), `${line}\n`);
      } catch (error) {
        if (!reported) {
          reported = true;
          const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
          process.stderr.write(`pibot runner log write failed (${code})\n`);
        }
      }
      // User verbosity changes the terminal only; persistent audit/diagnostic evidence remains.
      const priority = { info: 0, warn: 1, error: 2 };
      if (priority[level] < priority[consoleMinimum]) return;
      // The CLI presents the final error in the user's language. Keep its duplicate
      // structured diagnostic in the log file and in machine-readable output.
      if (event === "runner.failed" && process.stderr.isTTY) return;
      const output =
        level === "error" || consoleTarget === "stderr" ? process.stderr : process.stdout;
      output.write(`${line}\n`);
    },
  };
}
