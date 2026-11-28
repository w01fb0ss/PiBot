// Retain Windows danger hints and verify known targets before the stored Windows consent can release the call.

import { win32 } from "node:path";
import type { ApprovalFact } from "@pibot/protocol-base";
import { powershellDirectoryWrites } from "../commands/powershell-directories.ts";
import { windowsReadShape } from "../commands/windows-approval-shape.ts";
import { canonicalPath, expandHome } from "../paths/paths.ts";
import { windowsProtectedPathNames } from "../paths/protected-paths.ts";
import {
  type CommandPathScope,
  commandLiteralPaths,
  isWritableCommandPath,
  verifiedCommandPaths,
  windowsProtectedCommandPath,
} from "./command-path-risk.ts";

import type { PathContext } from "./types.ts";
import {
  safeWindowsDeletePath,
  windowsDeleteTarget,
  windowsNetworkOrDevicePath,
  windowsObfuscatedCommand,
} from "./windows-command-exceptions.ts";

const MAX_FRAGMENTS = 16;
const MAX_FRAGMENT_LENGTH = 160;
const boundary = /[\\\s"'`;&|(){}=:%]/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Conservative text hints only: no shell interpretation, readonly proof or permission grant. */
export function scanWindowsCommand(
  command: string,
  protectedRoots: readonly string[] = [],
  scope: CommandPathScope = { writeRoots: [], denyWriteRoots: [] },
  verifiedPaths: ReadonlySet<string> = new Set(),
  directoryWrites?: Awaited<ReturnType<typeof powershellDirectoryWrites>>,
  verifiedDelete = false,
  ownRoots: readonly string[] = [],
) {
  const fragments = new Set<string>();
  let privilegeEscalation = false;
  const add = (value: string) => {
    if (fragments.size < MAX_FRAGMENTS) fragments.add(value.slice(0, MAX_FRAGMENT_LENGTH));
  };
  for (const match of command.matchAll(
    /\b(?:sudo|runas)(?:\.exe)?\b|[-\u2013-\u2015]verb\s*(?:[:=]\s*)?["']?runas\b/gi,
  )) {
    privilegeEscalation = true;
    add(match[0]);
  }
  if (!verifiedDelete) {
    for (const match of command.matchAll(
      /\b(?:remove-item|ri|rm|rmdir|rd|del|erase)\b(?:[ \t]+(?:-recurse\b|-force\b|-[rf]+\b|\/[sq]\b))*/gi,
    ))
      add(match[0]);
  }
  // Slash folding preserves offsets so fragments remain the exact text shown by the caller.
  const folded = command.replaceAll("/", "\\");
  const paths = commandLiteralPaths(command);
  const systemNames = windowsProtectedPathNames();
  for (const name of [...systemNames, ".git", ...protectedRoots]) {
    const needle = name.replaceAll("/", "\\").replace(/\\+$/, "");
    if (!needle) continue;
    let pathIndex = 0;
    for (const match of folded.matchAll(new RegExp(escapePattern(needle), "gi"))) {
      const start = match.index;
      const end = start + needle.length;
      if (
        (start === 0 || boundary.test(folded[start - 1] ?? "")) &&
        (end === folded.length || boundary.test(folded[end] ?? ""))
      ) {
        while (paths[pathIndex] && (paths[pathIndex]?.end ?? 0) <= start) pathIndex++;
        const literal = paths[pathIndex];
        if (
          (systemNames.includes(name) ||
            (protectedRoots.includes(name) &&
              !!literal &&
              !windowsProtectedCommandPath(literal.path, protectedRoots, ownRoots))) &&
          literal &&
          literal.start <= start &&
          literal.end >= end &&
          verifiedPaths.has(literal.path) &&
          isWritableCommandPath(literal.path, "win32", scope)
        )
          continue;
        add(command.slice(start, end));
      }
    }
  }
  for (const match of command.matchAll(
    /%(?:systemroot|windir|programfiles(?:\(x86\))?|programdata)%|\$env:(?:systemroot|windir|programfiles|programdata)\b/gi,
  ))
    add(match[0]);
  if (directoryWrites) {
    for (const path of directoryWrites.writes)
      if (
        !isWritableCommandPath(path, "win32", scope) ||
        windowsProtectedCommandPath(path, protectedRoots, ownRoots)
      )
        add(path);
    if (directoryWrites.unknownWrite) add("unknown_command_directory");
  }
  return { privilegeEscalation, fragments: [...fragments] };
}

export async function prepareWindowsCommandScan(
  command: string,
  options: {
    protectedRoots: readonly string[];
    /** The Bot's own work folder, exempt from the data-directory root (see the predicate). */
    ownRoots?: readonly string[];
    scope: CommandPathScope;
    writePaths?: readonly string[];
    cwd: string | undefined;
    context: PathContext | undefined;
  },
) {
  const { protectedRoots, scope, cwd, context } = options;
  const ownRoots = options.ownRoots ?? [];
  const needsConfirmation =
    windowsNetworkOrDevicePath(command) ||
    (cwd !== undefined && windowsNetworkOrDevicePath(cwd)) ||
    options.writePaths?.some(windowsNetworkOrDevicePath) === true ||
    windowsObfuscatedCommand(command);
  const pathContext = context && !needsConfirmation && cwd ? { ...context, cwd } : undefined;
  const readShape = !needsConfirmation ? windowsReadShape(command) : undefined;
  const directoryChecks = new Map<string, Promise<boolean>>();
  const directoryWrites =
    cwd && !readShape
      ? await powershellDirectoryWrites(command, cwd, (path) => {
          const pending = directoryChecks.get(path);
          if (pending) return pending;
          const checked = verifyWindowsDirectory(
            path,
            scope,
            protectedRoots,
            ownRoots,
            pathContext,
          );
          directoryChecks.set(path, checked);
          return checked;
        })
      : undefined;
  const declaredWrites = options.writePaths?.map((path) =>
    expandHome(path, context?.home ?? cwd ?? ""),
  );
  const writes = new Set([...(directoryWrites?.writes ?? []), ...(declaredWrites ?? [])]);
  const deleteTarget = cwd ? windowsDeleteTarget(command, cwd) : undefined;
  const verifiedPaths =
    context && !needsConfirmation
      ? await verifiedCommandPaths(command, scope, context)
      : new Set<string>();
  const confirmed = await checkWindowsWrites(writes, deleteTarget, {
    protectedRoots,
    ownRoots,
    scope,
    context: pathContext,
  });
  const mappedDrive =
    context && !context.fs.canonicalize && !needsConfirmation
      ? await usesMappedDrive(command, cwd, declaredWrites, context)
      : false;
  const scan = scanWindowsCommand(
    command,
    protectedRoots,
    scope,
    verifiedPaths,
    directoryWrites,
    confirmed.verifiedDelete,
    ownRoots,
  );
  return {
    privilegeEscalation: scan.privilegeEscalation,
    fragments: [...new Set([...scan.fragments, ...confirmed.fragments])].slice(0, MAX_FRAGMENTS),
    needsConfirmation,
    mappedDrive,
    facts: confirmed.facts,
    readShape,
  };
}

async function verifyWindowsDirectory(
  path: string,
  scope: CommandPathScope,
  protectedRoots: readonly string[],
  ownRoots: readonly string[],
  context: PathContext | undefined,
) {
  if (!context || !/^[a-z]:[\\/]/i.test(path)) return false;
  const normalized = win32.normalize(path);
  const writable = (value: string) =>
    isWritableCommandPath(value, "win32", scope) &&
    !windowsProtectedCommandPath(value, protectedRoots, ownRoots);
  if (!writable(normalized)) return false;
  try {
    const resolved = await canonicalPath(path, context);
    // Check the raw spelling before using the normalized path for later relative operands.
    // A parent traversal through a junction can land somewhere other than its lexical target.
    return (
      resolved.exists &&
      /^[a-z]:[\\/]/i.test(resolved.path) &&
      writable(resolved.path) &&
      (!path.split(/[\\/]/).includes("..") || win32.relative(normalized, resolved.path) === "")
    );
  } catch {
    context.signal.throwIfAborted();
    // A directory whose identity could not be checked still needs per-call confirmation.
    return false;
  }
}

/** A command runs the drive spelling it was given, so a mapped drive needs the network-drive gate. */
async function usesMappedDrive(
  command: string,
  cwd: string | undefined,
  writes: readonly string[] | undefined,
  context: PathContext,
) {
  const drives = new Set(
    [...commandLiteralPaths(command).map((entry) => entry.path), cwd, ...(writes ?? [])]
      .filter((path): path is string => typeof path === "string" && /^[a-z]:[\\/]/i.test(path))
      .map((path) => win32.parse(win32.normalize(path)).root.toUpperCase()),
  );
  const mapped = await Promise.all(
    [...drives].map(async (drive) => {
      try {
        const target = await canonicalPath(drive, context);
        return !target.exists || win32.normalize(target.path).toUpperCase() !== drive;
      } catch {
        // Without a real drive identity the command keeps its per-call confirmation.
        context.signal.throwIfAborted();
        return true;
      }
    }),
  );
  return mapped.some(Boolean);
}

async function checkWindowsWrites(
  paths: ReadonlySet<string>,
  deleteTarget: string | undefined,
  options: {
    protectedRoots: readonly string[];
    ownRoots: readonly string[];
    scope: CommandPathScope;
    context?: PathContext;
  },
) {
  const { protectedRoots, ownRoots, scope, context } = options;
  const facts: ApprovalFact[] = [];
  const fragments: string[] = [];
  let verifiedDelete = false;
  if (!context) return { facts, fragments, verifiedDelete };
  for (const path of paths) {
    context.signal.throwIfAborted();
    if (facts.length + fragments.length >= 32) {
      fragments.push("unknown_command_directory");
      break;
    }
    if (windowsProtectedCommandPath(path, protectedRoots, ownRoots)) {
      fragments.push(path.slice(0, MAX_FRAGMENT_LENGTH));
      continue;
    }
    try {
      const resolved = await canonicalPath(path, context);
      if (
        windowsNetworkOrDevicePath(resolved.path) ||
        windowsProtectedCommandPath(resolved.path, protectedRoots, ownRoots)
      ) {
        fragments.push(path.slice(0, MAX_FRAGMENT_LENGTH));
        continue;
      }
      facts.push({ kind: "write", value: resolved.path });
      if (path === deleteTarget)
        verifiedDelete =
          // The Bot's workspace exception covers ordinary writes. Deletion in Pi Bot
          // data still requires confirmation, including through a canonical alias.
          safeWindowsDeletePath(path, protectedRoots, scope) &&
          safeWindowsDeletePath(resolved.path, protectedRoots, scope);
    } catch {
      // An unreadable target cannot rule out a junction into a protected directory.
      context.signal.throwIfAborted();
      fragments.push("unknown_command_directory");
    }
  }
  return { facts, fragments, verifiedDelete };
}
