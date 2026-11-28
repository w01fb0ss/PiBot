import { realpath } from "node:fs/promises";
import {
  canonicalPath,
  parsePatch,
  samePathSpelling,
  windowsDisplayPath,
  windowsMappedPath,
  windowsPathName,
} from "@pibot/execution";
import { commandLiteralPaths } from "@pibot/policy";
import type { PreparedTool } from "../../../core/local-types.ts";

/** Recheck display aliases against the exact canonical fact approved by policy. */
export async function approvalPathFacts(prepared: PreparedTool, signal: AbortSignal) {
  const { call, result } = prepared;
  const candidates =
    call.tool === "apply_patch" && typeof call.input.patch === "string"
      ? parsePatch(call.input.patch).map((entry) => entry.path)
      : call.tool === "run_command" && typeof call.input.command === "string"
        ? [call.input.cwd, ...commandLiteralPaths(call.input.command).map((entry) => entry.path)]
        : [call.input.path];
  const facts = result.facts.filter(
    (fact) => fact.kind === "read" || fact.kind === "write" || fact.kind === "cwd",
  );
  const names = new Map<string, string>();
  const aliases = new Set(candidates.slice(0, 50));
  if (prepared.displayFolders?.length) {
    for (const { value } of facts) {
      const display = windowsDisplayPath(value, prepared.displayFolders);
      if (display !== value) aliases.add(display);
    }
  }
  for (const raw of aliases) {
    signal.throwIfAborted();
    if (
      typeof raw !== "string" ||
      !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(raw) ||
      raw.split(/[\\/]/).includes("..")
    )
      continue;
    const name = windowsPathName(raw);
    if (name.kind === "device") continue;
    const mapped = await windowsMappedPath(name.path, realpath).catch(() => undefined);
    if (!mapped) continue;
    const key = windowsPathName(mapped).key;
    const matches = facts.filter(
      (fact) =>
        !names.has(fact.value) && raw !== fact.value && windowsPathName(fact.value).key === key,
    );
    if (!matches.length) continue;
    // An unavailable or changed alias leaves the canonical fact on the card.
    const actual = await canonicalPath(raw, prepared.cwd).catch(() => undefined);
    if (!actual) continue;
    for (const fact of matches) {
      if (samePathSpelling(windowsPathName(actual).path, windowsPathName(fact.value).path))
        names.set(fact.value, raw);
    }
  }
  signal.throwIfAborted();
  return names.size
    ? result.facts.map((fact) =>
        fact.kind === "read" || fact.kind === "write" || fact.kind === "cwd"
          ? { ...fact, value: names.get(fact.value) ?? fact.value }
          : fact,
      )
    : undefined;
}
