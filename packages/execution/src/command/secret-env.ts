// Keep the final guard in exec/secret-env.ts in sync; exec has no workspace dependencies.
const protectedNames = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "BUN_OPTIONS",
  "CURL_CA_BUNDLE",
  "DENO_FLAGS",
  "CDPATH",
  "COMSPEC",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "PIP_CONFIG_FILE",
  "PIBOT_SKILL_DIR",
  "PIBOT_SKILL_NODE",
  "PIBOT_SKILL_PYTHON",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PERL5OPT",
  "PS4",
  "PWD",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "ZDOTDIR",
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
export function isSafeSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    /^[A-Z][A-Z0-9_]{0,63}$/.test(name) &&
    !protectedNames.has(upper) &&
    !upper.startsWith("GIT_") &&
    !upper.startsWith("NPM_CONFIG_") &&
    !upper.startsWith("ELECTRON_") &&
    !upper.startsWith("LD_") &&
    !upper.startsWith("DYLD_") &&
    !upper.endsWith("_PROXY")
  );
}

/** Final dispatch guard; values come only from brain, never from tool args. */
export function mergeSecretEnv(
  base: NodeJS.ProcessEnv,
  secrets: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  if (!secrets || !Object.keys(secrets).length) return base;
  const merged = { ...base };
  for (const [name, value] of Object.entries(secrets)) {
    if (!isSafeSecretEnvName(name) || !value || value.includes("\0"))
      throw new TypeError("Unsafe secret environment");
    merged[name] = value;
  }
  return merged;
}

/** Process monitors are sibling utilities, not destinations the person approved for a secret. */
export function commandMonitorEnvironment(
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string> | undefined,
) {
  const monitor = { ...env };
  for (const name of Object.keys(secrets ?? {})) delete monitor[name];
  return monitor;
}
