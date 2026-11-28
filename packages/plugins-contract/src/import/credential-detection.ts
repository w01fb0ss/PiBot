import type { ClaudePluginConfigField } from "@pibot/protocol-base";

// Shared by MCP env/header migration and userConfig. Keep this conservative:
// an untrusted manifest may make a field stricter, but never downgrade these signals.
const CREDENTIAL_NAME =
  /PASS(?:WORD|WD)|SECRET|TOKEN|CREDENTIAL|AUTH|API[-_]?KEY|(?:^|[_-])(?:KEY|PAT)(?:[_-]|$)|COOKIE|(?:^|[_-])SESSION[-_]?ID(?:[_-]|$)/i;
const CREDENTIAL_VALUE =
  /(?:sk-(?:ant-)?|xai-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|AIza|gsk_|hf_)[A-Za-z0-9_-]{19,}/;
const CLAUDE_PLUGIN_ROOT_REFERENCE = `\${CLAUDE_PLUGIN_ROOT}`;

export function looksLikeCredentialName(name: string): boolean {
  // userConfig commonly uses camelCase while MCP env uses SCREAMING_SNAKE_CASE.
  return CREDENTIAL_NAME.test(name.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

export function looksLikeCredentialValue(value: unknown): boolean {
  return typeof value === "string" && CREDENTIAL_VALUE.test(value);
}

export function looksLikeCredential(name: string, value: unknown): boolean {
  return (
    looksLikeCredentialName(name) ||
    looksLikeCredentialValue(name) ||
    looksLikeCredentialValue(value)
  );
}

/** Host may consume the one trusted root token; no substitution may survive into brain command. */
export function hasPluginCommandSubstitution(value: string, allowPluginRoot = false): boolean {
  const checked = allowPluginRoot ? value.replaceAll(CLAUDE_PLUGIN_ROOT_REFERENCE, "") : value;
  return checked.includes("${");
}

/** Remove untrusted defaults while retaining the picker type for private paths. */
export function hardenPluginConfigField(field: ClaudePluginConfigField): ClaudePluginConfigField {
  if (!field.sensitive && !looksLikeCredential(field.key, field.default)) return field;
  const { default: _untrustedDefault, ...safe } = field;
  if (field.type === "directory" || field.type === "file") {
    const { options: _untrustedOptions, ...pathField } = safe;
    return { ...pathField, sensitive: true, required: true };
  }
  return { ...safe, type: "string", sensitive: true, required: true };
}
