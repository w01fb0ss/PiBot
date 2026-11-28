import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { isSafeSecretEnvName } from "@pibot/execution";
import { scriptLanguage } from "@pibot/policy";
import { envExampleFilter, SKILL_BODY_MAX_BYTES } from "@pibot/protocol-base";
import { PackageError, scriptLike, textOf } from "./skill-package.ts";
import { detectRuntimeRequirements, RUNTIME_MANIFEST_MAX_BYTES } from "./skill-runtime.ts";
import {
  contained,
  folderEntries,
  type SkillSourceFile,
  sourceFile,
  zipEntries,
} from "./skill-source.ts";

export interface SkillPackageSummary {
  fileCount: number;
  totalBytes: number;
  largestFolders: { name: string; bytes: number; fileCount: number }[];
  scriptCount: number;
  licenses: { path: string; agpl: boolean; gpl: boolean }[];
  /** `optional` marks names the example only declares commented out (`# NAME=`). */
  environmentVariables: { name: string; optional: boolean }[];
  bindableEnvironmentVariables?: string[];
  /** Absent when the package was never analyzed; the contract treats the same field as optional. */
  runtimeRequirements?: {
    runtime: "python" | "node";
    version?: string;
    packages?: string[];
  }[];
  /** Compiled-extension hints; advisory only, never part of a permission decision. */
  nativeModules?: string[];
}
export interface ScannedSkillFile extends SkillSourceFile {
  script: boolean;
  text: boolean;
}
export interface ScannedSkillPackage {
  skillText: string;
  folder: string;
  files: ScannedSkillFile[];
  skillFile: SkillSourceFile;
  totalBytes: number;
  skipped: number;
  summary: SkillPackageSummary;
}
export interface SkillCopyProgress {
  files: number;
  bytes: number;
  totalFiles: number;
  totalBytes: number;
}

/** Only the requested file is buffered; body and display reads have separate explicit bounds. */
export async function readScannedFile(
  file: SkillSourceFile,
  signal: AbortSignal,
  max: number,
  activity?: () => void,
): Promise<Buffer> {
  if (file.bytes > max) throw new PackageError("too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of file.chunks(signal, 0, file.bytes, activity)) {
    size += chunk.length;
    if (size > max) throw new PackageError("too_large");
    chunks.push(chunk);
  }
  if (size !== file.bytes) throw new PackageError("unsafe");
  return Buffer.concat(chunks, size);
}

async function analyze(file: SkillSourceFile, signal: AbortSignal, activity?: () => void) {
  // Magic/shebang detection needs four bytes even for extensionless executables. No resource
  // body is retained; licenses/env examples are inspected as streams and never returned raw.
  let head: Buffer = Buffer.alloc(0);
  const name = basename(file.path);
  // A license is a text document: `license.svg` is a badge, and reading it as a license both
  // listed an image and risked matching stray letters (F8). Other names stay package files.
  const license =
    /^(?:LICENSE|COPYING)(?:[._-].*)?$/i.test(name) &&
    ["", ".txt", ".md", ".markdown", ".rst", ".html", ".htm"].includes(extname(name).toLowerCase());
  const environment = name.toLowerCase() === ".env.example";
  /** Name to `optional`: a name stays optional only while every declaration is commented out. */
  const names = new Map<string, boolean>();
  let agpl = false,
    gpl = false,
    carry = "",
    variable = "",
    ignoreLine = false;
  const decoder = new TextDecoder();
  for await (const chunk of file.chunks(
    signal,
    0,
    license || environment ? file.bytes : Math.min(file.bytes, 8192),
    activity,
  )) {
    if (!head.length) head = chunk.subarray(0, 8192);
    if (license) {
      const text = carry + decoder.decode(chunk, { stream: true });
      agpl ||= /AGPL/i.test(text);
      // "LGPL" contains "GPL": a weaker copyleft must not raise the GPL warning (F8).
      gpl ||= /(?<![AL])GPL/i.test(text);
      carry = text.slice(-4);
    }
    if (environment) {
      // Stop collecting at '=': values never enter the analysis result or a line buffer. Names
      // declared only as a comment are kept, marked optional, because templates often ship them
      // that way and the user still needs to know which keys the skill reads.
      for (const byte of chunk) {
        if (byte === 10) {
          variable = "";
          ignoreLine = false;
          continue;
        }
        if (ignoreLine) continue;
        if (byte === 61) {
          const match = /^(\s*#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\s*$/.exec(
            variable,
          );
          if (match?.[2])
            names.set(match[2], (names.get(match[2]) ?? true) && match[1] !== undefined);
          if (names.size > 20_000) throw new PackageError("too_large");
          variable = "";
          ignoreLine = true;
        } else if (variable.length < 256 && byte < 128) variable += String.fromCharCode(byte);
        else {
          variable = "";
          ignoreLine = true;
        }
      }
    }
  }
  let text = !head.includes(0);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: head.length < file.bytes });
  } catch {
    text = false;
  }
  const script = scriptLike(file.path, head);
  if (script && text) {
    const source = head.toString("utf8");
    const references =
      scriptLanguage(file.path, source) === "shell"
        ? /(?<!\\)\$\{?([A-Z][A-Z0-9_]{0,63})\b/g
        : /(?:process\.env\.|\$env:)([A-Z][A-Z0-9_]{0,63})\b|(?:process\.env\[|(?:os\.)?environ(?:\.get)?[[(]|(?:os\.)?getenv\()['"]([A-Z][A-Z0-9_]{0,63})['"]/gi;
    for (const match of source.matchAll(references)) {
      const name = match[1] ?? match[2];
      if (name && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && !names.has(name)) names.set(name, false);
    }
  }
  return {
    script,
    text,
    license: license ? { path: file.path, agpl, gpl } : undefined,
    names,
  };
}

/** Metadata first, then bounded SKILL.md and streaming security/preview probes. */
export async function scanSkillPackage(
  path: string,
  from: "folder" | "zip" | "file",
  signal: AbortSignal,
  activity?: () => void,
): Promise<ScannedSkillPackage> {
  const entries =
    from === "folder"
      ? await folderEntries(path, signal, activity)
      : from === "zip"
        ? await zipEntries(path, signal, activity)
        : { files: [await sourceFile(path, "SKILL.md")], skipped: 0 };
  const depth = (file: SkillSourceFile) => file.path.split("/").length;
  const candidates = entries.files
    .filter((file) => basename(file.path).toLowerCase() === "skill.md")
    .sort((a, b) => depth(a) - depth(b));
  const skill = candidates[0];
  if (!skill || (candidates[1] && depth(candidates[1]) === depth(skill)))
    throw new PackageError("no_skill");
  const skillText = textOf(
    await readScannedFile(skill, signal, SKILL_BODY_MAX_BYTES + 64 * 1024, activity),
  );
  if (skillText === undefined) throw new PackageError("no_skill");
  const prefix = skill.path.slice(0, -8);
  const files: ScannedSkillFile[] = [];
  const folders = new Map<string, { name: string; bytes: number; fileCount: number }>();
  const summary: SkillPackageSummary = {
    fileCount: 1,
    totalBytes: skill.bytes,
    largestFolders: [],
    scriptCount: 0,
    licenses: [],
    environmentVariables: [],
    runtimeRequirements: [],
  };
  const variables = new Map<string, boolean>();
  let skipped = entries.skipped;
  for (const entry of entries.files) {
    signal.throwIfAborted();
    if (entry === skill) continue;
    if (!entry.path.startsWith(prefix)) {
      skipped++;
      continue;
    }
    const file = { ...entry, path: entry.path.slice(prefix.length) };
    const analysis = await analyze(file, signal, activity);
    files.push({ ...file, script: analysis.script, text: analysis.text });
    summary.fileCount++;
    summary.totalBytes += file.bytes;
    if (analysis.script) summary.scriptCount++;
    if (analysis.license) summary.licenses.push(analysis.license);
    for (const [name, optional] of analysis.names)
      variables.set(name, (variables.get(name) ?? true) && optional);
    if (variables.size > 20_000) throw new PackageError("too_large");
    if (file.path.includes("/")) {
      const name = file.path.split("/")[0] ?? file.path;
      const folder = folders.get(name) ?? { name, bytes: 0, fileCount: 0 };
      folder.bytes += file.bytes;
      folder.fileCount++;
      folders.set(name, folder);
    }
  }
  summary.largestFolders = [...folders.values()]
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .slice(0, 5);
  summary.environmentVariables = [...variables]
    .map(([name, optional]) => ({ name, optional }))
    .sort((a, b) => a.name.localeCompare(b.name));
  summary.bindableEnvironmentVariables = summary.environmentVariables
    .map(({ name }) => name)
    .filter(isSafeSecretEnvName)
    .slice(0, 64);
  // Manifests are read from the listing the scan already paid for, each under an explicit
  // bound, so detection cannot turn a preview into an arbitrary file read.
  const byPath = new Map(files.map((file) => [file.path, file]));
  const detection = await detectRuntimeRequirements(
    files.map((file) => file.path),
    async (candidate) => {
      const file = byPath.get(candidate);
      if (!file || file.bytes > RUNTIME_MANIFEST_MAX_BYTES) return undefined;
      return textOf(await readScannedFile(file, signal, RUNTIME_MANIFEST_MAX_BYTES, activity));
    },
    signal,
  );
  summary.runtimeRequirements = detection.requirements;
  if (detection.native.length) summary.nativeModules = detection.native;
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    skillText,
    folder: prefix
      ? basename(dirname(skill.path))
      : from === "folder"
        ? basename(path)
        : from === "file"
          ? basename(dirname(path))
          : basename(path, extname(path)),
    files,
    skillFile: skill,
    totalBytes: summary.totalBytes,
    skipped,
    summary,
  };
}

/** Staging is owned/removed by the caller; scripts always remain inert 0600 files. */
export async function copyScannedSkillPackage(
  pack: ScannedSkillPackage,
  staging: string,
  signal: AbortSignal,
  progress?: (value: SkillCopyProgress) => void,
) {
  const value: SkillCopyProgress = {
    files: 0,
    bytes: 0,
    totalFiles: pack.files.length + 1,
    totalBytes: pack.totalBytes,
  };
  progress?.({ ...value });
  // Recheck the original document too, even though the saved front matter is rendered by skills.
  await readScannedFile(pack.skillFile, signal, SKILL_BODY_MAX_BYTES + 64 * 1024);
  value.files++;
  value.bytes += pack.skillFile.bytes;
  for (const entry of pack.files) {
    signal.throwIfAborted();
    const path = contained(staging, entry.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const sanitize =
      basename(entry.path).toLowerCase() === ".env.example" ? envExampleFilter() : undefined;
    try {
      for await (const chunk of entry.chunks(signal)) {
        signal.throwIfAborted();
        await file.writeFile(sanitize ? sanitize(chunk) : chunk);
        value.bytes += chunk.length;
        progress?.({ ...value });
      }
      // No per-file fsync here. The staging folder is renamed into place only
      // after writeSkillPackage syncs it once, so a crash before that leaves a staging folder
      // that recovery deletes; per-file fsync cost ~1 s each on overlayfs (1031 s for one import).
    } finally {
      await file.close();
    }
    value.files++;
    progress?.({ ...value });
  }
  signal.throwIfAborted();
  progress?.({ ...value });
}
