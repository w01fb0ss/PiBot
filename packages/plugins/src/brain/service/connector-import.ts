// Import normalization: the JSON source is untrusted; schema validation, secret
// migration and the digest all happen here before anything is persisted. The
// plaintext secrets collected during normalization exist only in memory until
// plugins.import commits them into the SecretStore.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  hardenPluginConfigField,
  hasPluginCommandSubstitution,
  looksLikeCredential,
  looksLikeCredentialName,
  looksLikeCredentialValue,
  missingPluginConfigValue,
  pluginConfigFieldVisible,
  unsupportedClaudePluginComponents,
} from "@pibot/plugins-contract";
import {
  type ClaudePluginBundle,
  ClaudePluginBundleSchema,
  type ConnectorManifest,
  ConnectorManifestSchema,
  ConnectorNetworkSiteSchema,
  type ConnectorServer,
  connectorEndpointSite,
  IdSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { parseJsonc } from "../discovery/formats.ts";
import { importWorkingDirectory } from "../import-working-directory.ts";
import { compatibleSource } from "./connector-import-compat.ts";

export const USER_SECRET_SCOPE = "user-secret";
const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_IMPORT_SECRET_NAMES = 64;
const SECRET_REF_GLOBAL = /\$\{secret:([A-Z][A-Z0-9_]{0,63})\}/g;
const SECRET_MARKER = "${secret:";
const PACKAGE_MANAGER_DOMAINS = {
  npx: ["registry.npmjs.org"],
  uvx: ["pypi.org", "files.pythonhosted.org"],
  uv: ["pypi.org", "files.pythonhosted.org"],
  npm: ["registry.npmjs.org"],
  pnpm: ["registry.npmjs.org"],
  bunx: ["registry.npmjs.org"],
} as const;

type RequiredKey = { name: string; label: string; serverId: string };
type PrivateField = { name: string; label: string; serverId: string };
type FillValue = (read: (name: string) => string) => string;

/** Generated references belong to one installation, never to a global header name. */
class ImportSecretRegistry {
  private readonly byName = new Map<
    string,
    { value: string; label: string; example: boolean; opaque: boolean }
  >();
  readonly fills = new Map<string, FillValue>();
  readonly plainFields: PrivateField[] = [];

  constructor(
    private readonly reserved: Set<string>,
    private readonly prefix: string,
    private readonly serverId: string,
  ) {}

  register(
    base: string,
    value: string,
    example = isExampleCredential(value),
    label = base,
    opaque = false,
  ): string {
    base = secretNameFromHeader(base) ?? fallbackSecretName(base);
    const name = `${this.prefix}${base}`.slice(0, 64);
    for (let n = 1; n <= 99; n += 1) {
      const suffix = n === 1 ? "" : `_${n}`;
      const candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
      if (this.reserved.has(candidate)) continue;
      const existing = this.byName.get(candidate);
      if (existing !== undefined) continue;
      this.byName.set(candidate, { value, label, example, opaque });
      return candidate;
    }
    throw invalid("Too many credential name collisions in one import");
  }

  entries(): ImportedSecret[] {
    return [...this.byName].flatMap(([name, { value, example, opaque }]) =>
      example || this.fills.has(name) ? [] : [{ name, value, ...(opaque ? { opaque } : {}) }],
    );
  }

  requiredKeys() {
    return [...this.byName].flatMap(([name, { label, example }]) =>
      example ? [{ name, label, serverId: this.serverId }] : [],
    );
  }

  protect(label: string, value: string, header: boolean): string {
    const headerScheme = header ? (/^(?:Bearer|Basic|Token|ApiKey) +/i.exec(value)?.[0] ?? "") : "";
    const protectedValue = value.slice(headerScheme.length);
    if (value.includes(SECRET_MARKER)) {
      if (/^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/.test(protectedValue)) return value;
      throw invalid("Literal values beside secret references are unsupported");
    }
    const base = secretNameFromHeader(label) ?? fallbackSecretName(label);
    const shown = label.slice(0, 64);
    const name = this.register(base, protectedValue, false, shown, !headerScheme);
    const slot = (leaf: string) => {
      const scheme = /^(?:Bearer|Basic|Token|ApiKey) +/i.exec(leaf)?.[0] ?? "";
      const candidate = leaf.slice(scheme.length);
      const external = externalValue.exec(candidate)?.[1];
      if (!candidate.trim() || (!external && !isExampleCredential(candidate))) return undefined;
      const field = this.register(base, "", true, external ?? shown);
      return (read: (name: string) => string) => `${scheme}${read(field)}`;
    };
    const fill = slot(protectedValue) ?? (!header ? jsonCredentialFill(value, slot) : undefined);
    if (fill) this.fills.set(name, fill);
    else if (
      !headerScheme &&
      !looksLikeCredential(label, value) &&
      !credentialUrl(value) &&
      importedCredentialParts(value).length === 0 &&
      !/\b(?:Bearer|Basic|Token|ApiKey)\s+\S|["'](?:authorization|cookie|password|(?:api[-_]?key|access[-_]?token))["']\s*:/i.test(
        value,
      )
    )
      this.plainFields.push({ name, label: shown, serverId: this.serverId });
    return `${headerScheme}\${secret:${name}}`;
  }
}

const isExampleCredential = (value: string) =>
  !value.trim() ||
  /^(?:(?:Bearer|Basic|Token|ApiKey) +)?(?:your[-_ ]?[a-z][a-z0-9_ -]*|[<{][a-z][a-z0-9_ -]*[>}]|\$\{[A-Z][A-Z0-9_]{0,63}\}|replace[-_ ]?me|changeme)$/i.test(
    value.trim(),
  );

const externalValue = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;

/** Replace JSON string values at their original offsets, escaping the inserted key for JSON. */
function jsonCredentialFill(value: string, slot: (leaf: string) => FillValue | undefined) {
  if (!/^\s*[{[]/.test(value)) return undefined;
  try {
    JSON.parse(value);
  } catch {
    // An arbitrary env string is still protected as an opaque value.
    return undefined;
  }
  const fills = [...value.matchAll(/"(?:[^"\\]|\\.)*"/g)].flatMap(({ 0: literal, index }) => {
    const end = index + literal.length;
    if (value.slice(end).trimStart().startsWith(":")) return [];
    const fill = slot(JSON.parse(literal) as string);
    return fill ? [{ index, end, fill }] : [];
  });
  if (!fills.length) return undefined;
  return (read: Parameters<FillValue>[0]) => {
    let offset = 0;
    let result = "";
    for (const { index, end, fill } of fills) {
      result += value.slice(offset, index) + JSON.stringify(fill(read));
      offset = end;
    }
    return result + value.slice(offset);
  };
}

const URLsInText = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

function credentialUrl(value: string): boolean {
  for (const [candidate] of value.matchAll(URLsInText)) {
    const url = URL.parse(candidate);
    if (url?.username || url?.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(candidate))
      return true;
    const query = candidate.split(/[?#]/).slice(1);
    if (query.some((part) => [...new URLSearchParams(part).keys()].some(looksLikeCredentialName)))
      return true;
  }
  return false;
}

/** The MCP process may echo a credential from a composite value without its enclosing JSON. */
export function importedCredentialParts(value: string, allJsonValues = false): string[] {
  const parts: string[] = [];
  const authValue = (text: string) => /^(?:Bearer|Basic|Token|ApiKey) +([^\s]+)$/i.exec(text)?.[1];
  const token = authValue(value);
  if (token) parts.push(token);
  if (!/^\s*[{[]/.test(value)) return parts;
  try {
    JSON.parse(value, (key, item: unknown) => {
      if (
        typeof item === "string" &&
        (allJsonValues || looksLikeCredentialName(key) || authValue(item))
      )
        parts.push(authValue(item) ?? item);
      return item;
    });
  } catch {
    // Non-JSON values are already protected in their entirety.
  }
  return parts;
}

export interface ImportedSecret {
  name: string;
  value: string;
  opaque?: true;
}

export interface ConnectorPreview {
  previewId: string;
  /** The installation id the preview commits to; retries return the same receipt. */
  installationId: string;
  digest: string;
  expiresAt: string;
  /** Sanitized manifest: plaintext secrets replaced by ${secret:NAME} refs. */
  manifest: ConnectorManifest;
  declaredVersion?: string;
  ignoredMcpMetadata?: true;
  requiredKeys?: RequiredKey[];
  plainFields?: PrivateField[];
  fills?: ReadonlyMap<string, FillValue>;
  /** Plaintext values backing the references; never serialized to the renderer. */
  secrets: ImportedSecret[];
  plugin?: ClaudePluginBundle;
  /** Brain-derived destination; never accepted from an imported manifest. */
  installationRoot?: string;
  discovery?: { tool: string; key: string; name?: string; path: string };
}

export interface ConnectorImportReceipt {
  previewId: string;
  installationId: string;
  digest: string;
  /** Process-keyed request binding; contains no configuration value or enable flag. */
  intentDigest: string;
  expiresAt: string;
}

export interface ConnectorImportIntent {
  skillTargets?: { bots: string[]; groups: string[] };
  enable: boolean;
  config: Readonly<Record<string, string | number | boolean>>;
  plainFields?: readonly string[];
  useSavedKeys?: true;
  networkDomains?: Readonly<Record<string, readonly string[]>>;
}

const invalid = (reason: string) => new RpcError(RpcErrorCodes.pluginImportInvalid, reason);
const rejectUrlCredential = (): never => {
  throw invalid("connector_url_credential_unsupported");
};
const rejectCommandSubstitution = (): never => {
  throw invalid("connector_command_substitution_unsupported");
};
const rejectPluginSecretReference = (): never => {
  throw invalid("connector_plugin_secret_reference_unsupported");
};
const rejectCredentialMetadata = (values: readonly string[]) => {
  if (values.some(looksLikeCredentialValue))
    throw invalid("Plugin metadata cannot contain credentials");
};
const unsupportedImportPaths = new Set(
  unsupportedClaudePluginComponents.map((item) => item.path.toLowerCase()),
);
const hasSecretPlaceholder = (value: string) => /\$\{\s*secret/i.test(value);

interface FinalImportValidation {
  installationRoot?: string;
  substitutedStrings?: ReadonlySet<string>;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid("HTTP server URL contains invalid encoding");
  }
}

function validateRejectedUrlSegments(segments: readonly string[]) {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] ?? "";
    if (
      hasSecretPlaceholder(segment) ||
      looksLikeCredentialValue(segment) ||
      (index > 0 && looksLikeCredentialName(segments[index - 1] ?? ""))
    )
      rejectUrlCredential();
  }
}

function validateFinalHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("HTTP server URL is invalid");
  }
  if (url.username || url.password) rejectUrlCredential();
  validateRejectedUrlSegments(decodeUrlComponent(url.pathname).split("/"));
  if (!url.hash) return;
  const fragment = decodeUrlComponent(url.hash.slice(1));
  if (!fragment.includes("=")) validateRejectedUrlSegments(fragment.split("/"));
}

function pathCandidate(value: string): string {
  const equals = value.indexOf("=");
  return equals >= 0 ? value.slice(equals + 1) : value;
}

function validateFinalPluginPath(value: string, options: FinalImportValidation) {
  const candidate = pathCandidate(value);
  if (
    !candidate ||
    (!isAbsolute(candidate) && !candidate.startsWith(".") && !/[\\/]/.test(candidate))
  )
    return;
  const root = options.installationRoot;
  if (!root) {
    if (options.substitutedStrings?.has(value))
      throw invalid("Plugin command path requires an installation root");
    return;
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const inRoot = inside(root, absolute);
  const inPluginsDirectory = inside(dirname(root), absolute);
  if (
    (!isAbsolute(candidate) && !inRoot) ||
    (inPluginsDirectory && !inRoot) ||
    (options.substitutedStrings?.has(value) && !inRoot)
  )
    throw invalid("Plugin command path must stay inside its installation root");
  if (
    inRoot &&
    relative(root, absolute)
      .split(/[\\/]/)
      .some((segment) => unsupportedImportPaths.has(segment.toLowerCase()))
  )
    throw invalid("Plugin command path references an unsupported component");
}

function finalManifestStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(finalManifestStrings);
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => [key, ...finalManifestStrings(item)]);
  return [];
}

function rejectCopiedSecrets(manifest: ConnectorManifest, secrets: readonly ImportedSecret[]) {
  if (!secrets.length) return;
  const regionArguments = new Map<string, ReadonlySet<string>>();
  for (const server of manifest.servers) {
    if (server.transport !== "stdio") continue;
    const regions = new Set(
      server.args.flatMap((arg, index) => {
        const value =
          arg === "--region" ? server.args[index + 1] : /^--region=(.+)$/u.exec(arg)?.[1];
        return value && /^[a-z]{2,4}(?:-[a-z]+){1,3}-[0-9]+$/u.test(value) ? [value] : [];
      }),
    );
    if (regions.size === 0) continue;
    for (const [key, reference] of Object.entries(server.env)) {
      const name = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/u.exec(reference)?.[1];
      if (name && /(?:^|_)REGION$/iu.test(key) && !looksLikeCredentialName(key))
        regionArguments.set(name, regions);
    }
  }
  const exact = new Set<string>();
  for (const { name, value, opaque } of secrets) {
    if (!value) continue;
    // A provider region explicitly supplied in both places is ordinary command configuration.
    if (opaque && regionArguments.get(name)?.has(value)) continue;
    if (!opaque || value.length >= 8) exact.add(value);
    for (const part of importedCredentialParts(value)) if (part) exact.add(part);
    for (const [candidate] of value.matchAll(URLsInText)) {
      const password = URL.parse(candidate)?.password;
      if (password) exact.add(password);
    }
  }
  const embedded = [...exact].filter((value) => value.length >= 8);
  for (const field of finalManifestStrings(manifest)) {
    const visible = field.replaceAll(SECRET_REF_GLOBAL, "");
    if (exact.has(visible) || embedded.some((value) => visible.includes(value)))
      throw invalid("connector_paste_commandCredential");
  }
}

function serverSecretReferences(server: ConnectorManifest["servers"][number]): string[] {
  const names = new Set<string>();
  const values =
    server.transport === "stdio"
      ? Object.values(server.env)
      : server.transport === "http"
        ? [...Object.values(server.headers), server.url]
        : [];
  for (const value of values)
    for (const match of value.matchAll(SECRET_REF_GLOBAL)) if (match[1]) names.add(match[1]);
  return [...names].sort();
}

function recordFinalSecretReferences(manifest: ConnectorManifest): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    ...manifest,
    servers: manifest.servers.map((server) => {
      const secretNames = serverSecretReferences(server);
      if (secretNames.length > MAX_IMPORT_SECRET_NAMES)
        throw invalid("connector_import_secret_limit");
      return { ...server, auth: { ...server.auth, secretNames } };
    }),
  });
}

function validateImportSecretLimit(
  manifest: ConnectorManifest,
  secrets: readonly ImportedSecret[],
  additionalNames: ReadonlySet<string> = new Set(),
) {
  const names = new Set(additionalNames);
  for (const server of manifest.servers)
    for (const name of server.auth.secretNames) names.add(name);
  for (const secret of secrets) names.add(secret.name);
  if (names.size > MAX_IMPORT_SECRET_NAMES) throw invalid("connector_import_secret_limit");
}

function validatePluginSecretNamespace(manifest: ConnectorManifest, installationId: string) {
  const prefix = importSecretPrefix(installationId);
  for (const server of manifest.servers)
    if (server.auth.secretNames.some((name) => !name.startsWith(prefix)))
      rejectPluginSecretReference();
}

/**
 * The sole post-substitution safety gate. Every import path reaches this after
 * schema normalization and secret migration, immediately before persistence.
 */
function validateFinalImportManifest(
  manifest: ConnectorManifest,
  options: FinalImportValidation = {},
): void {
  for (const server of manifest.servers) {
    if (server.transport === "http") validateFinalHttpUrl(server.url);
    if (server.transport !== "stdio") continue;
    if (hasPluginCommandSubstitution(server.command)) rejectCommandSubstitution();
    if (hasSecretPlaceholder(server.command))
      throw invalid("Command cannot carry credentials; use env secret references");
    validateFinalPluginPath(server.command, options);
    for (const arg of server.args) {
      const optionName = /^--?([^=]+)/.exec(arg)?.[1];
      if (
        credentialUrl(arg) ||
        hasSecretPlaceholder(arg) ||
        (optionName && looksLikeCredentialName(optionName))
      )
        throw invalid("connector_paste_commandCredential");
      validateFinalPluginPath(arg, options);
    }
  }
  if (finalManifestStrings(manifest).some(looksLikeCredentialValue))
    throw invalid("Final connector manifest cannot contain plaintext credentials");
}

/** A header name cannot always become a secret name; derive and verify. */
function secretNameFromHeader(header: string): string | undefined {
  const derived = header
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .slice(0, 64);
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(derived) ? derived : undefined;
}

/**
 * A sensitive header whose name cannot become a legal secret name still must
 * never reach the manifest as plaintext; a digest-derived name is stable
 * across re-imports, so receipts stay idempotent.
 */
function fallbackSecretName(header: string): string {
  return `SECRET_${createHash("sha256").update(header).digest("hex").slice(0, 8).toUpperCase()}`;
}

const encodedSecretRef = /(?:%24|\$)%7Bsecret(?::|%3A)([A-Z][A-Z0-9_]{0,63})%7D/gi;
const restoreSecretRefs = (value: string) =>
  value.replace(encodedSecretRef, (_match, name: string) => `\${secret:${name}}`);

function sanitizeUrlValue(
  name: string,
  value: string,
  fallback: string,
  registry: ImportSecretRegistry,
): string {
  if (!value || hasSafeReferences(name, value, false)) return value;
  if (!looksLikeCredential(name, value)) return value;
  const derived = secretNameFromHeader(name) ?? fallback;
  return `\${secret:${registry.register(derived, value)}}`;
}

function sanitizeHttpUrl(value: string, registry: ImportSecretRegistry): string {
  const url = new URL(value);
  if (url.username || url.password) rejectUrlCredential();
  if (looksLikeCredentialValue(url.hostname))
    throw invalid("HTTP server host cannot contain credentials");

  validateRejectedUrlSegments(decodeUrlComponent(url.pathname).split("/"));

  const query = [...url.searchParams.entries()];
  url.search = "";
  for (let index = 0; index < query.length; index++) {
    const [rawName, rawValue] = query[index] as [string, string];
    const name = sanitizeUrlValue("", rawName, `URL_QUERY_NAME_${index}`, registry);
    const item = sanitizeUrlValue(rawName, rawValue, `URL_QUERY_${index}`, registry);
    url.searchParams.append(name, item);
  }

  if (url.hash) {
    const fragment = decodeUrlComponent(url.hash.slice(1));
    if (fragment.includes("=")) {
      const items = [...new URLSearchParams(fragment).entries()];
      const sanitized = new URLSearchParams();
      for (let index = 0; index < items.length; index++) {
        const [rawName, rawValue] = items[index] as [string, string];
        const name = sanitizeUrlValue("", rawName, `URL_FRAGMENT_NAME_${index}`, registry);
        const item = sanitizeUrlValue(rawName, rawValue, `URL_FRAGMENT_${index}`, registry);
        sanitized.append(name, item);
      }
      url.hash = sanitized.toString();
    } else {
      validateRejectedUrlSegments(fragment.split("/"));
    }
  }
  // URL setters encode placeholders. The persisted format keeps explicit references so every
  // credential dependency is discoverable without decoding arbitrary URL text.
  return restoreSecretRefs(url.toString());
}

/** References protect only their own contents, not adjacent literal credentials. */
function hasSafeReferences(name: string, value: string, header: boolean): boolean {
  if (!value.includes(SECRET_MARKER)) return false;
  const remainder = value.replaceAll(SECRET_REF_GLOBAL, "");
  if (remainder.includes(SECRET_MARKER))
    throw invalid("Secret references must use a complete named placeholder");
  const sensitive = looksLikeCredentialName(name) || /^(?:Bearer|Basic)\s/i.test(value);
  // Keep fixed auth schemes, but reject ambiguous sensitive templates instead
  // of silently returning the literal password beside a legitimate reference.
  if (
    looksLikeCredentialValue(remainder) ||
    (sensitive &&
      !(header ? /^(?:(?:Bearer|Basic|Token|ApiKey)\s+)?\s*$/i : /^\s*$/).test(remainder))
  )
    throw invalid("Literal credentials beside references must use separate secret references");
  return true;
}

/** Mutable only within one normalization; a repair must match exactly one command key. */
type CommandKeyMigration = { name: string; applied: boolean };
const commandKeyOption = /^--(?:api[-_]?key|token)(?:=(.*))?$/i;

function sanitizeServer(
  server: ConnectorManifest["servers"][number],
  registry: ImportSecretRegistry,
  keyMigration?: CommandKeyMigration,
  protectValues = false,
): ConnectorManifest["servers"][number] {
  if (server.transport === "stdio") {
    if (
      server.cwd &&
      (hasPluginCommandSubstitution(server.cwd) ||
        server.cwd.includes("${") ||
        looksLikeCredentialValue(server.cwd))
    )
      throw invalid("Working directory cannot contain substitutions or credentials");
    if (hasPluginCommandSubstitution(server.command)) rejectCommandSubstitution();
    if (
      credentialUrl(server.command) ||
      looksLikeCredentialValue(server.command) ||
      server.command.includes(SECRET_MARKER)
    )
      throw invalid("Command cannot carry credentials; use env secret references");
    const env: Record<string, string> = { ...server.env };
    const args: string[] = [];
    const program = server.command
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:exe|cmd|bat)$/i, "");
    const firstPackageArg = server.args[0] === "-y" || server.args[0] === "--yes" ? 1 : 0;
    const packageRunner = /^(?:npx|bunx)$/i.test(program ?? "");
    // Context7's documented stdio API-key flag and env variable are interchangeable.
    const context7 =
      program === "context7-mcp" ||
      (packageRunner &&
        /^@upstash\/context7-mcp(?:@[a-zA-Z0-9.-]+)?$/.test(server.args[firstPackageArg] ?? ""));
    const mcpRemote =
      program === "mcp-remote" ||
      (packageRunner &&
        /^mcp-remote(?:@[a-zA-Z0-9.-]+)?$/.test(server.args[firstPackageArg] ?? ""));
    for (let index = 0; index < server.args.length; index++) {
      const arg = server.args[index] as string;
      const headerFlag = /^(?:--header|-H)(?:=(.*))?$/.exec(arg);
      const attachedHeader = arg.startsWith("-H") && !headerFlag ? arg.slice(2) : undefined;
      if (headerFlag || attachedHeader) {
        if (!mcpRemote) throw invalid("connector_paste_commandCredential");
        const inlineHeader = headerFlag?.[1] ?? attachedHeader;
        const header = inlineHeader ?? server.args[index + 1];
        const fields = header && /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.+)$/.exec(header);
        const headerName = fields ? fields[1] : undefined;
        const headerValue = fields ? fields[2] : undefined;
        if (headerName && headerValue) {
          if (/[\0\r\n]/.test(headerValue)) throw invalid("connector_paste_commandCredential");
          // mcp-remote expands this in-process. The sandbox and confirmation only see the reference.
          const scheme = /^(Bearer|Basic|Token|ApiKey) +/i.exec(headerValue);
          const value = headerValue.slice(scheme?.[0].length ?? 0);
          const variable = /^\$\{(?:env:)?([A-Z][A-Z0-9_]{0,63})\}$/.exec(value)?.[1];
          const name = variable ?? `PIBOT_MCP_AUTH_HEADER_${index}`;
          if (!variable) {
            if (value.includes("${") || Object.hasOwn(env, name))
              throw invalid("connector_paste_commandCredential");
            env[name] = value;
          } else if (!Object.hasOwn(env, name)) {
            env[name] = `\${env:${name}}`;
          }
          if (!hasSafeReferences(name, env[name] ?? "", false)) {
            const current = env[name] ?? "";
            const external = externalValue.exec(current)?.[1];
            const label =
              external ?? secretNameFromHeader(headerName) ?? fallbackSecretName(headerName);
            const secret = registry.register(label, external ? "" : current);
            env[name] = `\${secret:${secret}}`;
          }
          args.push("--header", `${headerName}:${scheme?.[0] ?? ""}\${${name}}`);
          if (inlineHeader === undefined) index++;
          continue;
        }
        throw invalid("connector_paste_commandCredential");
      }
      // Standalone auth headers can occur in positional arguments as well.
      const header = /^([a-zA-Z0-9_-]+):\s*(\S.*)$/.exec(arg);
      if (header?.[1] && header[2] && looksLikeCredential(header[1], header[2]))
        throw invalid("connector_paste_commandCredential");
      const keyOption = commandKeyOption.exec(arg);
      if (keyOption) {
        const value = keyOption[1] ?? server.args[index + 1];
        if (
          !value ||
          value.startsWith("--") ||
          /[\0\r\n]/.test(value) ||
          hasSecretPlaceholder(value)
        )
          throw invalid("connector_paste_commandCredential");
        // Some READMEs show the alternative environment setting alongside the CLI option.
        // Only infer the destination from one matching example explicitly present in this entry.
        const expectedSuffix = /api[-_]?key/i.test(arg.split("=")[0] ?? "")
          ? /API_?KEY$/i
          : /TOKEN$/i;
        const examples = Object.keys(env).filter(
          (name) => expectedSuffix.test(name) && isExampleCredential(env[name] ?? ""),
        );
        const documentedName =
          context7 && expectedSuffix.test("CONTEXT7_API_KEY") ? "CONTEXT7_API_KEY" : undefined;
        const name =
          keyMigration?.name ?? documentedName ?? (examples.length === 1 ? examples[0] : undefined);
        if (!name) throw invalid("connector_paste_moveCommandKey");
        if (
          keyMigration?.applied ||
          (Object.hasOwn(env, name) && !isExampleCredential(env[name] ?? ""))
        )
          throw invalid("connector_paste_keyConflict");
        if (keyMigration) keyMigration.applied = true;
        env[name] = `\${secret:${registry.register(name, value)}}`;
        if (keyOption[1] === undefined) index++;
        continue;
      }
      const optionName = /^--?([^=]+)/.exec(arg)?.[1];
      if (
        credentialUrl(arg) ||
        looksLikeCredentialValue(arg) ||
        (optionName !== undefined && looksLikeCredentialName(optionName)) ||
        arg.includes(SECRET_MARKER)
      )
        throw invalid("connector_paste_commandCredential");
      args.push(arg);
    }
    for (const [name, value] of Object.entries(env)) {
      if (protectValues) {
        env[name] = registry.protect(name, value, false);
        continue;
      }
      if (hasSafeReferences(name, value, false)) continue;
      const external = externalValue.exec(value)?.[1];
      if (
        external ||
        looksLikeCredentialName(name) ||
        looksLikeCredentialValue(value) ||
        (value.trim() && isExampleCredential(value)) ||
        credentialUrl(value)
      )
        env[name] = `\${secret:${registry.register(external ?? name, external ? "" : value)}}`;
    }
    return { ...server, args, env };
  }
  if (server.transport !== "http") return server;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(server.headers)) {
    if (looksLikeCredentialValue(name))
      throw invalid("HTTP header names cannot contain credentials");
    if (protectValues) {
      headers[name] = registry.protect(name, value, true);
      continue;
    }
    if (hasSafeReferences(name, value, true)) {
      headers[name] = value;
      continue;
    }
    const scheme = /^(Bearer|Basic|Token|ApiKey) +(.*)$/i.exec(value);
    const candidate = scheme?.[2] ?? value;
    const external = externalValue.exec(candidate)?.[1];
    if (
      !external &&
      !looksLikeCredentialName(name) &&
      !scheme &&
      !looksLikeCredentialValue(candidate) &&
      !(candidate.trim() && isExampleCredential(candidate))
    ) {
      headers[name] = value;
      continue;
    }
    const derived = secretNameFromHeader(name) ?? fallbackSecretName(name);
    // The token is migrated, the literal scheme stays in the manifest.
    const secretName = registry.register(external ?? derived, external ? "" : candidate);
    headers[name] = `${scheme ? `${scheme[1]} ` : ""}\${secret:${secretName}}`;
  }
  const url = sanitizeHttpUrl(server.url, registry);
  const endpoint = ConnectorNetworkSiteSchema.safeParse(connectorEndpointSite(new URL(url))).data;
  return {
    ...server,
    url,
    headers,
    networkDomains: endpoint && !server.networkDomains.length ? [endpoint] : server.networkDomains,
  };
}

export function packageManagerDomains(command: string): readonly string[] {
  const executable = command
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.(?:cmd|exe|bat)$/, "");
  return executable && Object.hasOwn(PACKAGE_MANAGER_DOMAINS, executable)
    ? PACKAGE_MANAGER_DOMAINS[executable as keyof typeof PACKAGE_MANAGER_DOMAINS]
    : [];
}

function addPackageManagerDomains(manifest: ConnectorManifest): ConnectorManifest {
  return ConnectorManifestSchema.parse({
    ...manifest,
    servers: manifest.servers.map((server) =>
      server.transport === "stdio"
        ? {
            ...server,
            networkDomains: [
              ...new Set([...server.networkDomains, ...packageManagerDomains(server.command)]),
            ],
          }
        : server,
    ),
  });
}

export function normalizeConnectorSource(
  text: string,
  installationId?: string,
  finalValidation: FinalImportValidation = {},
  userHome?: string,
  moveCommandKeyTo?: string,
  protectValues = true,
): {
  manifest: ConnectorManifest;
  secrets: ImportedSecret[];
  digest: string;
  ignoredMcpMetadata?: true;
  requiredKeys?: RequiredKey[];
  plainFields?: PrivateField[];
  fills?: ReadonlyMap<string, FillValue>;
} {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    throw invalid("connector_paste_json");
  }
  const compatible = compatibleSource(parsed);
  const candidate = compatible.manifest;
  // Only expand a leading home marker. Relative paths have no stable base in copied settings.
  if (
    userHome &&
    candidate &&
    typeof candidate === "object" &&
    "servers" in candidate &&
    Array.isArray(candidate.servers)
  ) {
    candidate.servers = candidate.servers.map((server: unknown) => {
      if (!server || typeof server !== "object") return server;
      const cwd =
        "cwd" in server && typeof server.cwd === "string"
          ? importWorkingDirectory(server.cwd, userHome)
          : undefined;
      if ("cwd" in server && typeof server.cwd === "string" && !cwd)
        throw invalid("connector_paste_workingDirectory");
      const args =
        "args" in server && Array.isArray(server.args)
          ? server.args.map((arg: unknown) => {
              if (typeof arg !== "string" || !/^~[\\/]/.test(arg)) return arg;
              const path = importWorkingDirectory(arg, userHome);
              if (!path) throw invalid("connector_paste_arguments");
              return path;
            })
          : undefined;
      return { ...server, ...(cwd ? { cwd } : {}), ...(args ? { args } : {}) };
    });
  }
  const parsedManifest = ConnectorManifestSchema.safeParse(candidate);
  if (!parsedManifest.success) {
    const issue = parsedManifest.error.issues[0];
    const field = issue?.path[2];
    if (field === "cwd") throw invalid("connector_paste_workingDirectory");
    if (field === "args") throw invalid("connector_paste_arguments");
    if (field === "env") throw invalid("connector_paste_variables");
    if (field === "headers") throw invalid("connector_paste_headers");
    if (field === "url") throw invalid("connector_paste_url");
    if (field === "networkDomains") throw invalid("connector_paste_sites");
    if (field === "startupTimeoutSec") throw invalid("connector_paste_timeout");
    if (field === "command") throw invalid("connector_paste_command");
    throw invalid("connector_paste_shape");
  }
  const manifest = addPackageManagerDomains(parsedManifest.data);
  rejectCredentialMetadata([
    manifest.id,
    manifest.version,
    manifest.name.zh,
    manifest.name.en,
    manifest.description.zh,
    manifest.description.en,
    ...manifest.servers.flatMap((server) => [server.id, ...server.networkDomains]),
  ]);
  if (
    manifest.id.startsWith("pibot.") ||
    manifest.servers.some((server) => server.transport === "builtin")
  )
    throw invalid("Builtin drivers are available only from the trusted application catalog");
  const reserved = new Set<string>();
  for (const server of manifest.servers) {
    const values =
      server.transport === "stdio" ? server.env : server.transport === "http" ? server.headers : {};
    for (const value of Object.values(values))
      for (const match of value.matchAll(SECRET_REF_GLOBAL)) if (match[1]) reserved.add(match[1]);
    if (server.transport === "http")
      for (const match of server.url.matchAll(SECRET_REF_GLOBAL))
        if (match[1]) reserved.add(match[1]);
  }
  const prefix = installationId
    ? `IMPORT_${IdSchema.parse(installationId).replaceAll("-", "").toUpperCase()}_`
    : "";
  const keyMigration = moveCommandKeyTo ? { name: moveCommandKeyTo, applied: false } : undefined;
  const registries: ImportSecretRegistry[] = [];
  const servers = manifest.servers.map((server, index) => {
    const registry = new ImportSecretRegistry(
      reserved,
      manifest.servers.length > 1 ? `${prefix}S${index + 1}_` : prefix,
      server.id,
    );
    registries.push(registry);
    return sanitizeServer(server, registry, keyMigration, protectValues);
  });
  if (keyMigration && !keyMigration.applied) throw invalid("connector_paste_commandCredential");
  const sanitized = recordFinalSecretReferences({ ...manifest, servers });
  validateFinalImportManifest(sanitized, finalValidation);
  const secrets = registries.flatMap((registry) => registry.entries());
  const requiredKeys = registries.flatMap((registry) => registry.requiredKeys());
  const plainFields = registries.flatMap((registry) => registry.plainFields);
  const fills = new Map(registries.flatMap((registry) => [...registry.fills]));
  rejectCopiedSecrets(sanitized, secrets);
  validateImportSecretLimit(sanitized, secrets);
  if (requiredKeys.length > MAX_IMPORT_SECRET_NAMES) throw invalid("connector_import_secret_limit");
  return {
    manifest: sanitized,
    secrets,
    digest: createHash("sha256").update(JSON.stringify(sanitized)).digest("hex"),
    ...(compatible.ignoredMcpMetadata ? { ignoredMcpMetadata: true as const } : {}),
    ...(requiredKeys.length ? { requiredKeys } : {}),
    ...(plainFields.length ? { plainFields } : {}),
    ...(fills.size ? { fills } : {}),
  };
}

export function importSecretPrefix(installationId: string) {
  return `IMPORT_${IdSchema.parse(installationId).replaceAll("-", "").toUpperCase()}_`;
}

export function importSavedKeys(manifest: ConnectorManifest, installationId: string) {
  const prefix = importSecretPrefix(installationId);
  return manifest.servers.flatMap((server) => {
    const names = server.auth.secretNames.filter((name) => !name.startsWith(prefix));
    return names.length ? [{ serverId: server.id, names }] : [];
  });
}

function configSecretName(installationId: string, key: string) {
  return `${importSecretPrefix(installationId)}${key.toUpperCase()}`.slice(0, 64);
}

function configuredValue(
  field: ClaudePluginBundle["config"][number],
  values: Record<string, string | number | boolean>,
  preview: boolean,
) {
  const value = values[field.key] ?? field.default;
  if (value === undefined || (field.required && missingPluginConfigValue(value))) {
    if (!preview && field.required) throw invalid(`Missing required plugin setting: ${field.key}`);
    if (!preview) return undefined;
    if (field.type === "number") return 0;
    if (field.type === "boolean") return false;
    return field.type === "string" ? "https://configured.invalid" : "configured-path";
  }
  if (field.type === "number" && typeof value !== "number")
    throw invalid(`Plugin setting ${field.key} must be a number`);
  if (field.type === "boolean" && typeof value !== "boolean")
    throw invalid(`Plugin setting ${field.key} must be a boolean`);
  if (!["number", "boolean"].includes(field.type) && typeof value !== "string")
    throw invalid(`Plugin setting ${field.key} must be text`);
  if (field.sensitive && typeof value !== "string")
    throw invalid(`Sensitive plugin setting ${field.key} must be text`);
  if (field.options && !field.options.some((option) => option.value === value))
    throw invalid(`Plugin setting ${field.key} has an unsupported option`);
  return value;
}

function configureBundle(
  bundle: ClaudePluginBundle,
  installationId: string,
  values: Record<string, string | number | boolean>,
  preview: boolean,
  deferSensitive = false,
  storedSecrets?: ReadonlySet<string>,
) {
  for (const source of Object.values(bundle.mcpServers)) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const command = (source as Record<string, unknown>).command;
    if (typeof command === "string" && hasPluginCommandSubstitution(command))
      rejectCommandSubstitution();
  }
  const fields = new Map(bundle.config.map((field) => [field.key, field] as const));
  for (const key of Object.keys(values))
    if (!fields.has(key)) throw invalid(`Unknown plugin setting: ${key}`);
  const resolved = new Map<string, string>();
  const secrets: ImportedSecret[] = [];
  const secretNames = new Set<string>();
  const settings: Record<string, string | number | boolean> = {};
  const validateConfigured = new Set<string>();
  for (const field of bundle.config) {
    if (!pluginConfigFieldVisible(field, values, fields)) {
      // Keep inactive placeholders empty so a manifest may declare both branches in one MCP env.
      resolved.set(field.key, "");
      continue;
    }
    // Re-evaluating an installed package: its secrets stay the values already stored for it,
    // referenced by name; a value for one never arrives here.
    if (
      storedSecrets &&
      (storedSecrets.has(field.key) || field.sensitive || looksLikeCredentialName(field.key))
    ) {
      if (Object.hasOwn(values, field.key))
        throw invalid("Sensitive plugin configuration must be replaced as a key");
      resolved.set(
        field.key,
        storedSecrets.has(field.key)
          ? `\${secret:${configSecretName(installationId, field.key)}}`
          : "",
      );
      continue;
    }
    if (deferSensitive && (field.sensitive || looksLikeCredentialName(field.key))) {
      if (Object.hasOwn(values, field.key) || field.default !== undefined)
        throw invalid("Sensitive plugin configuration must be filled in Connections");
      resolved.set(field.key, `\${secret:${configSecretName(installationId, field.key)}}`);
      continue;
    }
    const value = configuredValue(field, values, preview);
    if (value === undefined) {
      resolved.set(field.key, "");
      continue;
    }
    const sensitive = field.sensitive || looksLikeCredential(field.key, value);
    if (sensitive) {
      if (typeof value !== "string")
        throw invalid(`Sensitive plugin setting ${field.key} must be text`);
      const name = configSecretName(installationId, field.key);
      if (secretNames.has(name)) throw invalid("Plugin setting names collide after normalization");
      secretNames.add(name);
      resolved.set(field.key, `\${secret:${name}}`);
      if (!preview) secrets.push({ name, value });
    } else {
      resolved.set(field.key, String(value));
      if (!preview || field.default !== undefined) settings[field.key] = value;
    }
    if (Object.hasOwn(values, field.key) || field.default !== undefined)
      validateConfigured.add(field.key);
  }
  const substitutedStrings = new Set<string>();
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      let validateResult = false;
      const replaced = value.replace(
        /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Z][A-Z0-9_]*)\}/g,
        (match, userKey: string | undefined, envKey: string | undefined) => {
          const key = userKey ?? envKey;
          if (key && validateConfigured.has(key)) validateResult = true;
          return (key && resolved.get(key)) ?? match;
        },
      );
      if (validateResult && replaced !== value) substitutedStrings.add(replaced);
      return replaced;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const mcpServers = replace(bundle.mcpServers) as Record<string, unknown>;
  if (/\$\{user_config\.|\$\{[A-Z][A-Z0-9_]*\}/.test(JSON.stringify(mcpServers)))
    throw invalid("Plugin MCP references an undeclared setting");
  return { mcpServers, secrets, secretNames, settings, substitutedStrings };
}

function normalizeClaudePlugin(
  bundle: ClaudePluginBundle,
  installationId: string,
  values: Record<string, string | number | boolean>,
  preview: boolean,
  installationRoot?: string,
  deferSensitive = false,
  storedSecrets?: ReadonlySet<string>,
) {
  const configured = configureBundle(
    bundle,
    installationId,
    values,
    preview,
    deferSensitive,
    storedSecrets,
  );
  const identity = createHash("sha256").update(JSON.stringify(bundle)).digest("hex").slice(0, 16);
  const normalized = Object.keys(configured.mcpServers).length
    ? normalizeConnectorSource(
        JSON.stringify({ mcpServers: configured.mcpServers }),
        installationId,
        {
          ...(installationRoot ? { installationRoot } : {}),
          substitutedStrings: configured.substitutedStrings,
        },
        undefined,
        undefined,
        false,
      )
    : {
        manifest: ConnectorManifestSchema.parse({
          schemaVersion: 1,
          id: `custom.${identity}`,
          version: bundle.version,
          name: { zh: bundle.name, en: bundle.name },
          description: { zh: bundle.description, en: bundle.description },
          servers: [],
        }),
        secrets: [],
        requiredKeys: undefined,
        digest: "",
      };
  const manifest = ConnectorManifestSchema.parse({
    ...normalized.manifest,
    id: `custom.${identity}`,
    version: bundle.version,
    name: bundle.applicationCard?.name ?? { zh: bundle.name, en: bundle.name },
    description: bundle.applicationCard?.description ?? {
      zh: bundle.description,
      en: bundle.description,
    },
  });
  validateFinalImportManifest(manifest, {
    ...(installationRoot ? { installationRoot } : {}),
    substitutedStrings: configured.substitutedStrings,
  });
  validatePluginSecretNamespace(manifest, installationId);
  const secrets = [...normalized.secrets, ...configured.secrets];
  validateImportSecretLimit(manifest, secrets, configured.secretNames);
  return {
    manifest,
    secrets,
    settings: configured.settings,
    requiredKeys: normalized.requiredKeys,
    digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}

/** The name an imported plugin setting's value is stored under when it is a secret. */
export const pluginSettingSecretName = configSecretName;

/**
 * What an installed package keeps so its plain settings can be changed later: the evaluated bundle
 * without skills or components. Kept only when the package's own MCP text carries no credential
 * (those would be plaintext here); otherwise settings change only by updating from the source.
 */
export function pluginSettingsTemplate(
  bundle: ClaudePluginBundle,
  installationId: string,
  installationRoot?: string,
): ClaudePluginBundle | undefined {
  if (
    !editablePluginSettings(bundle.config, new Set()).length ||
    !Object.keys(bundle.mcpServers).length
  )
    return undefined;
  const literal = normalizeClaudePlugin(bundle, installationId, {}, true, installationRoot);
  if (literal.secrets.length) return undefined;
  return { ...bundle, skills: [], components: [] };
}

/** Settings a person may edit after install: never a secret, by declaration, name or storage. */
export function editablePluginSettings(
  fields: ClaudePluginBundle["config"],
  storedSecrets: ReadonlySet<string>,
) {
  return fields.filter(
    (field) =>
      !field.sensitive && !looksLikeCredentialName(field.key) && !storedSecrets.has(field.key),
  );
}

/** Re-evaluates an installed package with changed plain settings; secrets stay references. */
export function reconfigureInstalledPlugin(
  template: ClaudePluginBundle,
  installationId: string,
  installationRoot: string | undefined,
  config: Record<string, string | number | boolean>,
  storedSecrets: ReadonlySet<string>,
) {
  return normalizeClaudePlugin(
    template,
    installationId,
    config,
    false,
    installationRoot,
    false,
    storedSecrets,
  );
}

function separateRequiredKeys(
  preview: ConnectorPreview,
  config: Record<string, string | number | boolean>,
) {
  const keys = new Set(preview.requiredKeys?.map(({ name }) => name));
  return Object.fromEntries(Object.entries(config).filter(([name]) => !keys.has(name)));
}

export function finalizeConnectorPreview(
  preview: ConnectorPreview,
  config: Record<string, string | number | boolean>,
  networkDomains: Readonly<Record<string, readonly string[]>> = {},
  deferSensitive = false,
  plainFields: readonly string[] = [],
) {
  const finalized = !preview.plugin
    ? {
        manifest: preview.manifest,
        secrets: preview.secrets,
        requiredKeys: preview.requiredKeys,
        settings: {},
        digest: preview.digest,
      }
    : normalizeClaudePlugin(
        preview.plugin,
        preview.installationId,
        separateRequiredKeys(preview, config),
        false,
        preview.installationRoot,
        deferSensitive,
      );
  const filledKeys = (finalized.requiredKeys ?? []).map(({ name }) => {
    const value = config[name];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      /[\0\r\n]/.test(value) ||
      isExampleCredential(value)
    )
      throw invalid("connector_paste_keyRequired");
    return { name, value };
  });
  if (filledKeys.some(({ name }) => !preview.requiredKeys?.some((key) => key.name === name)))
    throw invalid("connector_paste_keyRequired");
  const pending = new Map(filledKeys.map(({ name, value }) => [name, value]));
  const resolvedValues = [...(preview.fills ?? [])].map(([name, fill]): ImportedSecret => {
    const value = fill((slot) => {
      const key = pending.get(slot);
      if (key === undefined) throw invalid("connector_paste_keyRequired");
      pending.delete(slot);
      return key;
    });
    if (value.length > 4096) throw invalid("connector_paste_keyRequired");
    return { name, value, opaque: true };
  });
  const requestedPlain = new Set(plainFields);
  if (
    (deferSensitive && plainFields.length > 0) ||
    requestedPlain.size !== plainFields.length ||
    plainFields.some((name) => !preview.plainFields?.some((field) => field.name === name))
  )
    throw invalid("connector_paste_variables");
  if (requestedPlain.size) {
    const plain = new Map(
      finalized.secrets
        .filter(({ name }) => requestedPlain.has(name))
        .map(({ name, value }) => [name, value]),
    );
    const replace = (fields: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(fields).map(([key, value]) => {
          const name = /^\$\{secret:([A-Z][A-Z0-9_]{0,63})\}$/.exec(value)?.[1];
          return [key, (name && plain.get(name)) ?? value];
        }),
      );
    finalized.manifest = recordFinalSecretReferences({
      ...finalized.manifest,
      servers: finalized.manifest.servers.map((server) =>
        server.transport === "stdio"
          ? { ...server, env: replace(server.env) }
          : server.transport === "http"
            ? { ...server, headers: replace(server.headers) }
            : server,
      ),
    });
    finalized.digest = createHash("sha256")
      .update(JSON.stringify(finalized.manifest))
      .digest("hex");
  }
  finalized.secrets = [
    ...finalized.secrets.filter(({ name }) => !requestedPlain.has(name)),
    ...resolvedValues,
    ...[...pending].map(([name, value]) => ({ name, value })),
  ];
  rejectCopiedSecrets(finalized.manifest, finalized.secrets);
  assertConfirmedConnectionTargets(preview.manifest, finalized.manifest);
  const previewServers = new Map(preview.manifest.servers.map((server) => [server.id, server]));
  for (const [serverId, requested] of Object.entries(networkDomains)) {
    const server = previewServers.get(serverId);
    if (!server) throw invalid("Unknown server network selection");
    if (server.transport !== "stdio")
      throw invalid("Only sandboxed local server domains may be changed");
    const selected = new Set(requested);
    if (selected.size !== requested.length) throw invalid("Duplicate server network selection");
    if ([...selected].some((domain) => !server.networkDomains.includes(domain)))
      throw invalid("Network selection may only remove previewed domains");
  }
  if (Object.keys(networkDomains).length === 0) return finalized;
  const manifest = ConnectorManifestSchema.parse({
    ...finalized.manifest,
    servers: finalized.manifest.servers.map((server) => {
      const requested = networkDomains[server.id];
      if (!requested) return server;
      const selected = new Set(requested);
      return {
        ...server,
        networkDomains: server.networkDomains.filter((domain) => selected.has(domain)),
      };
    }),
  });
  return {
    ...finalized,
    manifest,
    digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  };
}

function confirmedConnectionTarget(server: ConnectorServer): unknown {
  if (server.transport === "http")
    return {
      id: server.id,
      transport: server.transport,
      url: server.url,
      sseFallback: server.sseFallback === true,
      ...(server.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: server.startupTimeoutSec }
        : {}),
      networkDomains: server.networkDomains,
    };
  if (server.transport === "stdio")
    return {
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: server.args,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      ...(server.startupTimeoutSec !== undefined
        ? { startupTimeoutSec: server.startupTimeoutSec }
        : {}),
      networkDomains: server.networkDomains,
    };
  return {
    id: server.id,
    transport: server.transport,
    builtinId: server.builtinId,
    networkDomains: server.networkDomains,
  };
}

function assertConfirmedConnectionTargets(
  preview: ConnectorManifest,
  finalized: ConnectorManifest,
): void {
  const confirmed = preview.servers.map(confirmedConnectionTarget);
  const target = finalized.servers.map(confirmedConnectionTarget);
  if (JSON.stringify(confirmed) !== JSON.stringify(target))
    throw invalid("Plugin settings changed connection targets; refresh the preview");
}

/** Preview is short-lived and single-use: import must consume the same snapshot. */
export class ConnectorPreviewStore {
  private readonly entries = new Map<string, ConnectorPreview & { expires: number }>();
  private readonly receipts = new Map<string, ConnectorImportReceipt & { expires: number }>();
  private readonly receiptKey = randomBytes(32);

  private intentDigest(intent: ConnectorImportIntent): string {
    const config = Object.fromEntries(
      Object.entries(intent.config).sort(([left], [right]) => left.localeCompare(right)),
    );
    return createHmac("sha256", this.receiptKey)
      .update(
        JSON.stringify({
          enable: intent.enable,
          config,
          plainFields: [...(intent.plainFields ?? [])].sort(),
          useSavedKeys: intent.useSavedKeys === true,
          networkDomains: Object.entries(intent.networkDomains ?? {}).sort(),
          skillTargets: {
            bots: [...new Set(intent.skillTargets?.bots ?? [])].sort(),
            groups: [...new Set(intent.skillTargets?.groups ?? [])].sort(),
          },
        }),
      )
      .digest("hex");
  }

  private prune(now: number): void {
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.entries.delete(id);
    for (const [id, receipt] of this.receipts) if (receipt.expires <= now) this.receipts.delete(id);
  }

  create(
    text: string,
    sourceKind: "json" | "plugin",
    now = Date.now(),
    installationId: string = randomUUID(),
    installationRoot?: string,
    userHome?: string,
    moveCommandKeyTo?: string,
  ): ConnectorPreview {
    this.prune(now);
    if (this.entries.size >= 64) throw invalid("Too many pending previews");
    let parsed: unknown;
    try {
      parsed = sourceKind === "json" ? parseJsonc(text) : JSON.parse(text);
    } catch {
      throw invalid("connector_paste_json");
    }
    let plugin: ClaudePluginBundle | undefined;
    if (sourceKind === "plugin") {
      const bundle = ClaudePluginBundleSchema.safeParse(parsed);
      if (!bundle.success) throw invalid("Invalid Claude Code plugin bundle");
      rejectCredentialMetadata([
        bundle.data.name,
        bundle.data.version,
        bundle.data.description,
        ...bundle.data.skills.flatMap((skill) => [skill.id, skill.name, skill.description]),
        ...bundle.data.config.flatMap((field) => [field.key, field.title, field.description]),
        ...bundle.data.components.flatMap((component) => [component.name, component.path ?? ""]),
      ]);
      plugin = {
        ...bundle.data,
        config: bundle.data.config.map(hardenPluginConfigField),
      };
    }
    const normalized = plugin
      ? normalizeClaudePlugin(plugin, installationId, {}, true, installationRoot)
      : normalizeConnectorSource(text, installationId, {}, userHome, moveCommandKeyTo);
    const preview = {
      previewId: randomUUID(),
      installationId,
      digest: plugin ? createHash("sha256").update(text).digest("hex") : normalized.digest,
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      manifest: normalized.manifest,
      ...("ignoredMcpMetadata" in normalized && normalized.ignoredMcpMetadata
        ? { ignoredMcpMetadata: true as const }
        : {}),
      ...(plugin
        ? plugin.versionDeclared
          ? { declaredVersion: normalized.manifest.version }
          : {}
        : parsed !== null &&
            typeof parsed === "object" &&
            "schemaVersion" in parsed &&
            parsed.schemaVersion === 1 &&
            "version" in parsed
          ? { declaredVersion: normalized.manifest.version }
          : {}),
      secrets: normalized.secrets,
      ...("requiredKeys" in normalized && normalized.requiredKeys
        ? { requiredKeys: normalized.requiredKeys }
        : {}),
      ...("plainFields" in normalized && normalized.plainFields
        ? { plainFields: normalized.plainFields }
        : {}),
      ...("fills" in normalized && normalized.fills ? { fills: normalized.fills } : {}),
      ...(plugin ? { plugin } : {}),
      ...(installationRoot ? { installationRoot } : {}),
    };
    this.entries.set(preview.previewId, { ...preview, expires: now + PREVIEW_TTL_MS });
    return preview;
  }

  /** Replaces a plugin preview with one evaluated from current settings, without retaining them. */
  configure(
    previewId: string,
    config: Record<string, string | number | boolean>,
    now = Date.now(),
  ): ConnectorPreview {
    const current = this.take(previewId, now);
    if (!current.plugin) throw invalid("Only plugin previews have configurable settings");
    const normalized = normalizeClaudePlugin(
      current.plugin,
      current.installationId,
      separateRequiredKeys(current, config),
      false,
      current.installationRoot,
    );
    const configured: ConnectorPreview = {
      previewId: randomUUID(),
      installationId: current.installationId,
      digest: normalized.digest,
      // Refreshing settings must not extend the source selection capability lifetime.
      expiresAt: current.expiresAt,
      manifest: normalized.manifest,
      ...(current.declaredVersion ? { declaredVersion: current.declaredVersion } : {}),
      // Final import re-evaluates the same settings; never retain submitted secret values here.
      secrets: [],
      ...(normalized.requiredKeys ? { requiredKeys: normalized.requiredKeys } : {}),
      plugin: current.plugin,
      ...(current.discovery ? { discovery: current.discovery } : {}),
      ...(current.installationRoot ? { installationRoot: current.installationRoot } : {}),
    };
    this.entries.delete(current.previewId);
    this.entries.set(configured.previewId, {
      ...configured,
      expires: Date.parse(configured.expiresAt),
    });
    return configured;
  }

  /** Read-only until commit replaces this entry with a plaintext-free retry receipt. */
  take(previewId: string, now = Date.now()): ConnectorPreview {
    const id = IdSchema.parse(previewId);
    const entry = this.entries.get(id);
    if (!entry) throw invalid("Preview not found");
    if (entry.expires <= now) {
      this.entries.delete(id);
      throw invalid("Preview expired");
    }
    return entry;
  }

  markDiscovered(previewId: string, discovery: NonNullable<ConnectorPreview["discovery"]>) {
    this.take(previewId);
    const entry = this.entries.get(previewId);
    if (entry) entry.discovery = discovery;
  }

  /** Read the normalized preview while keeping the single-use entry available for commit. */
  peek(previewId: string, now = Date.now()): ConnectorPreview {
    return this.take(previewId, now);
  }

  committed(
    previewId: string,
    intent: ConnectorImportIntent,
    now = Date.now(),
  ): ConnectorImportReceipt | undefined {
    this.prune(now);
    const receipt = this.receipts.get(IdSchema.parse(previewId));
    if (!receipt) return undefined;
    const expected = Buffer.from(this.intentDigest(intent), "hex");
    const actual = Buffer.from(receipt.intentDigest, "hex");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected))
      throw invalid("Import request changed; re-run the import");
    return receipt;
  }

  commit(
    preview: Pick<ConnectorPreview, "previewId" | "installationId" | "digest">,
    intent: ConnectorImportIntent,
    now = Date.now(),
  ): ConnectorImportReceipt {
    const id = IdSchema.parse(preview.previewId);
    const receipt = {
      previewId: id,
      installationId: IdSchema.parse(preview.installationId),
      digest: preview.digest,
      intentDigest: this.intentDigest(intent),
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
    this.entries.delete(id);
    this.receipts.set(id, { ...receipt, expires: now + PREVIEW_TTL_MS });
    return receipt;
  }

  cancel(previewId: string): void {
    const id = IdSchema.parse(previewId);
    this.entries.delete(id);
    this.receipts.delete(id);
  }
}
