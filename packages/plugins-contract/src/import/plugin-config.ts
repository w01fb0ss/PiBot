import {
  type ClaudePluginConfigField,
  ClaudePluginConfigFieldSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { hardenPluginConfigField } from "./credential-detection.ts";
import { unsupportedClaudePluginComponents } from "./unsupported-components.ts";

export const PLUGIN_CONFIG_MAX_BYTES = 1024 * 1024;

// Claude Code reads these names at the plugin root only. Excluding them at every depth silently
// dropped a skill's own `workflows/`, `bin/` or `agents/` folder, which is ordinary package
// content (ppt-master lost 23 files that way).
const excludedAtRoot = new Set([
  ...unsupportedClaudePluginComponents.map((item) => item.path.toLowerCase()),
  "extensions",
]);
const neverCopied = new Set([".git", ".env", ".ds_store"]);
const isEnvFile = (name: string) =>
  name.toLowerCase() !== ".env.example" && /^\.env(?:\.|$)/i.test(name);
/** Version-control data and real environment files never leave the source, at any depth. */
export const isNeverCopiedPluginEntry = (name: string) =>
  neverCopied.has(name.toLowerCase()) || isEnvFile(name);
export const isExcludedPluginEntry = (name: string, rootLevel: boolean) =>
  isNeverCopiedPluginEntry(name) || (rootLevel && excludedAtRoot.has(name.toLowerCase()));

function invalidConfig(): never {
  throw new RpcError(RpcErrorCodes.pluginImportInvalid, "connector_import_layout_unsupported");
}

export function normalizePluginConfigField(
  key: string,
  field: Record<string, unknown>,
): ClaudePluginConfigField {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) invalidConfig();
  const type = field.type === undefined ? "string" : String(field.type);
  if (!["string", "number", "boolean", "directory", "file"].includes(type)) invalidConfig();
  const visibleWhen = ClaudePluginConfigFieldSchema.shape.visibleWhen.safeParse(field.visibleWhen);
  return hardenPluginConfigField({
    key,
    type: type as ClaudePluginConfigField["type"],
    title: key,
    description: key,
    sensitive: field.sensitive === true,
    required: field.required === true,
    ...(field.default !== undefined ? { default: field.default as string | number | boolean } : {}),
    ...(visibleWhen.success && visibleWhen.data ? { visibleWhen: visibleWhen.data } : {}),
  });
}

export function implicitPluginConfigKeys(
  mcpServers: Record<string, unknown>,
  declared: ReadonlySet<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const match of JSON.stringify(mcpServers).matchAll(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g)) {
    const key = match[1];
    if (key && key !== "CLAUDE_PLUGIN_ROOT" && key !== "CLAUDE_PLUGIN_DATA" && !declared.has(key))
      keys.add(key);
  }
  return keys;
}

export function missingPluginConfigValue(value: ClaudePluginConfigField["default"]): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value === "number" && !Number.isFinite(value))
  );
}

export function requiresPluginSetup(fields: readonly ClaudePluginConfigField[]): boolean {
  const byKey = new Map(fields.map((field) => [field.key, field] as const));
  return fields.some(
    (field) =>
      field.required &&
      missingPluginConfigValue(field.default) &&
      pluginConfigFieldVisible(field, {}, byKey),
  );
}

export function pluginConfigFieldVisible(
  field: ClaudePluginConfigField,
  values: Readonly<Record<string, string | number | boolean>>,
  fields: ReadonlyMap<string, ClaudePluginConfigField>,
): boolean {
  if (!field.visibleWhen) return true;
  const { key, equals } = field.visibleWhen;
  return (values[key] ?? fields.get(key)?.default) === equals;
}
