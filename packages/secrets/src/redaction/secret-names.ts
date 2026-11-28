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
export function isUserSecretName(name: string): boolean {
  return isSafeSecretEnvName(name) && !name.startsWith("IMPORT_");
}

/** Conservative lexical detection: no shell evaluation and no interpolation of values. */
export function referencedSecretNames(command: string): string[] {
  const names = new Set<string>();
  const pattern =
    /\$env:([A-Z][A-Z0-9_]{0,63})\b|\$\{([A-Z][A-Z0-9_]{0,63})\}|\$([A-Z][A-Z0-9_]{0,63})\b|%([A-Z][A-Z0-9_]{0,63})%/g;
  for (const match of command.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (name) names.add(name);
  }
  return [...names].sort();
}
