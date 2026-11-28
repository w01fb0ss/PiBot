import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { childNodeRuntime, unpackedPath } from "../runtime/child-node.ts";
import { SANDBOX_HOST_DIR } from "./sandbox-config.ts";
import { sandboxLauncherPath } from "./sandbox-environment.ts";
import { SANDBOX_PAYLOAD_BYTES } from "./sandbox-host-payload.ts";

/** Longest socket name SRT puts in the host's TMPDIR: `/claude-socks-<16 hex>.sock` (Linux). */
const SOCKET_NAME_ROOM = 36;
/** macOS sun_path is 104 bytes including the terminator (Linux allows 108). */
const SOCKET_PATH_LIMIT = 103;

export interface SandboxHostPayload {
  hostSsh?: import("../ssh/ssh-command.ts").HostSshCommand;
  config: SandboxRuntimeConfig;
  allowAll: boolean;
  privateNetworkHosts?: string[];
  command: string;
  commandId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  foreground?: boolean;
  isolationProbe?: true;
  waitForDispatch?: boolean;
  /** MCP stdio server: the command's stdin/stdout are pipe fds 4/5, not the job log. */
  stdioServer?: boolean;
  stdinPipe?: boolean;
  commandText?: string;
}

/**
 * Where the sandbox host script is: next to the bundle in the desktop build (electron-vite entry
 * `sandbox-host`, inside app.asar when packaged; Electron's Node mode reads it from there), or
 * the TypeScript source when exec runs from the workspace under Node.
 */
function hostScript() {
  const bundled = new URL("./sandbox-host.js", import.meta.url);
  return existsSync(bundled)
    ? unpackedPath(fileURLToPath(bundled))
    : fileURLToPath(new URL("./sandbox-host.ts", import.meta.url));
}

/**
 * Prepares one sandbox host process: its private TMPDIR (SRT's proxy sockets) and its
 * environment. The returned cleanup removes the directory once the job has ended.
 */
export async function prepareSandboxHost(options: {
  tempDir: string;
  systemHome: string;
  /** Dev-probe seam: run this host script instead of the built-in sandbox host. */
  scriptPath?: string;
  args?: string[];
}) {
  const temp = await realpath(options.tempDir);
  const parent = join(temp, SANDBOX_HOST_DIR);
  // sandbox-config.ts created `parent` (0700) and denies writes inside every sandbox.
  // A temp dir too long for socket paths falls back to the POSIX /tmp (sandboxes only write
  // there when a Bot's folder includes it); mkdtemp's random 0700 directory is safe there.
  const dir =
    parent.length + 8 + SOCKET_NAME_ROOM <= SOCKET_PATH_LIMIT
      ? await mkdtemp(join(parent, "h"))
      : await mkdtemp(join(await realpath("/tmp"), "pibot-srt-"));
  const env: NodeJS.ProcessEnv = {
    PATH: sandboxLauncherPath(process.platform),
    HOME: options.systemHome,
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: dir,
  };
  return {
    // The separately signed helper Node, never Pi Bot's own executable.
    executable: childNodeRuntime().executable,
    args: options.args ?? [options.scriptPath ?? hostScript()],
    env,
    payload: (value: SandboxHostPayload) => {
      // Only this host's SRT sockets may cross the hidden shared temporary namespace.
      const config = {
        ...value.config,
        filesystem: {
          ...value.config.filesystem,
          allowRead: [...(value.config.filesystem.allowRead ?? []), { path: dir, literal: true }],
          denyWrite: [...value.config.filesystem.denyWrite, { path: dir, literal: true }],
        },
      };
      const line = `${JSON.stringify({ ...value, config })}\n`;
      if (Buffer.byteLength(line) > SANDBOX_PAYLOAD_BYTES) throw new Error("invalid_payload");
      return line;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
