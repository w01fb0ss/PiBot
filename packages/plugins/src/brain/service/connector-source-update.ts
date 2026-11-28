import {
  type ConnectorImportFileChanges,
  type ConnectorManifest,
  type ConnectorSourceDetails,
  looksLikeCredentialName,
  looksLikeCredentialValue,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";

type Server = ConnectorManifest["servers"][number];
const same = (before: unknown, after: unknown) => JSON.stringify(before) === JSON.stringify(after);
const names = (server: Server) =>
  server.transport === "stdio" ? Object.keys(server.env).sort() : [];
const websites = (server: Server) => {
  const values = [...server.networkDomains];
  if (server.transport === "http") {
    const url = new URL(server.url);
    // Query values may authenticate the remote MCP. Show its address without those values.
    values.push(`${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`);
  }
  return [...new Set(values)].sort();
};

/** The audit retains counts only; display metadata never includes env or header values. */
export function sourceUpdate(
  previous: ConnectorManifest,
  next: ConnectorManifest,
  files: number,
  redact: (value: string) => string = (value) => value,
  fileChanges?: ConnectorImportFileChanges,
  previewSecrets: readonly string[] = [],
  allowedSites?: ReadonlyMap<string, readonly string[]>,
) {
  const before = new Map(previous.servers.map((server) => [server.id, server]));
  if (before.size !== next.servers.length || next.servers.some((server) => !before.has(server.id)))
    throw new RpcError(RpcErrorCodes.invalidParams, "source_update_server_set_changed");
  const pairs = next.servers.map((server) => [before.get(server.id) as Server, server] as const);
  // Values can also be embedded in argv. Remove both versions before returning display data.
  const manifestValues = [...previous.servers, ...next.servers].flatMap((server) =>
    server.transport === "stdio"
      ? Object.values(server.env)
      : server.transport === "http"
        ? Object.values(server.headers)
        : [],
  );
  const privateValues = [...manifestValues, ...previewSecrets]
    .flatMap((value) => [value, ...(value.startsWith("Bearer ") ? [value.slice(7)] : [])])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const safe = (value: string) => {
    for (const secret of privateValues) value = value.replaceAll(secret, "[redacted]");
    return looksLikeCredentialValue(value) ? "[redacted]" : redact(value).slice(0, 4096);
  };
  const args = (values: string[]) =>
    values.map((value, index) => {
      // Named credentials and header payloads are private even when not yet in the secret store.
      const key = value.split(/[=:]/u, 1)[0] ?? "";
      if (
        (index > 0 &&
          (looksLikeCredentialName(values[index - 1] ?? "") ||
            ["-H", "--header"].includes(values[index - 1] ?? ""))) ||
        looksLikeCredentialName(key)
      )
        return value.startsWith("-") && !/[=:]/u.test(value) ? value : "[redacted]";
      return safe(value);
    });
  const details: ConnectorSourceDetails = {
    servers: pairs.map(([old, now]) => {
      const oldNames = names(old),
        newNames = names(now);
      const saved = allowedSites?.get(now.id);
      const priorDomains = old.transport === "stdio" && saved ? [...saved].sort() : websites(old);
      const finalDomains =
        now.transport === "stdio" && allowedSites ? [...(saved ?? [])].sort() : websites(now);
      return {
        id: safe(now.id),
        ...(old.transport === "stdio" && now.transport === "stdio"
          ? {
              ...(old.command !== now.command
                ? { command: { before: safe(old.command), after: safe(now.command) } }
                : {}),
              ...(!same(old.args, now.args)
                ? { arguments: { before: args(old.args), after: args(now.args) } }
                : {}),
            }
          : {}),
        envNames: {
          added: newNames.filter((name) => !oldNames.includes(name)),
          removed: oldNames.filter((name) => !newNames.includes(name)),
        },
        websites: { before: priorDomains.map(safe), after: finalDomains.map(safe) },
      };
    }),
    ...(fileChanges
      ? {
          files: {
            added: fileChanges.added.map(safe),
            removed: fileChanges.removed.map(safe),
            truncated: fileChanges.truncated,
          },
        }
      : {}),
  };
  const count = (changed: (old: Server, now: Server) => boolean) =>
    pairs.filter(([old, now]) => changed(old, now)).length;
  return {
    manifest: next,
    details,
    changes: {
      commands: count(
        (old, now) =>
          old.transport === "stdio" && now.transport === "stdio" && old.command !== now.command,
      ),
      arguments: count(
        (old, now) =>
          old.transport === "stdio" && now.transport === "stdio" && !same(old.args, now.args),
      ),
      envNames: count((old, now) => !same(names(old), names(now))),
      websites: count(
        (old, now) =>
          (old.transport === "http" ? old.url : undefined) !==
          (now.transport === "http" ? now.url : undefined),
      ),
      files,
    },
  };
}
