import { Socket } from "node:net";
import type { Writable } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

// SRT resolves env on macOS and bwrap and socat on Linux before isolation is active.
export function sandboxLauncherPath(platform: NodeJS.Platform) {
  return platform === "darwin" ? "/usr/bin:/bin:/usr/sbin:/sbin" : "/usr/sbin:/usr/bin:/sbin:/bin";
}

// SRT places this prelude in the workload shell after Seatbelt or Linux isolation is active.
// Read only the NUL-delimited environment; subsequent bytes belong to the workload's stdin.
// Keep the proxy, trust store and other variables already installed by SRT. PATH is the
// exception because the wrapper needed a system-only path to start the sandbox.
export const sandboxEnvironmentSetup = `
while :; do
  IFS= read -r -d '' __pibot_env_entry || exit 125
  [[ -n "$__pibot_env_entry" ]] || break
  __pibot_env_name=\${__pibot_env_entry%%=*}
  case "$__pibot_env_name" in
    PATH) ;;
    *) if declare -p "$__pibot_env_name" >/dev/null 2>&1; then continue; fi ;;
  esac
  export -- "$__pibot_env_entry" || exit 125
done
unset __pibot_env_entry __pibot_env_name
`;

/** Send the guest environment without publishing it in process arguments or on disk. */
export function sandboxInput(
  env: Record<string, string>,
  credentials: SandboxRuntimeConfig["credentials"],
) {
  // Reintroducing a denied or masked value here would bypass SRT's credential rules.
  const restricted = new Set(credentials?.envVars?.map(({ name }) => name));
  const entries = Object.entries(env).filter(([name]) => !restricted.has(name));
  if (entries.some(([, value]) => value.includes("\0"))) throw new Error("invalid_environment");
  return `${entries.map(([name, value]) => `${name}=${value}\0`).join("")}\0`;
}

export function writeSandboxInput(stdin: Writable, preamble: string, forwardStdin: boolean) {
  const source = forwardStdin ? new Socket({ fd: 4, readable: true, writable: false }) : undefined;
  // If the command exits or closes stdin, stop forwarding the original pipe.
  stdin.once("error", () => source?.destroy());
  stdin.once("close", () => source?.destroy());
  if (!source) {
    stdin.end(preamble);
    return;
  }
  source.once("error", () => stdin.end());
  stdin.write(preamble);
  source.pipe(stdin);
}
