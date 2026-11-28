import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBrain } from "@pibot/brain-app";
import type { Port } from "@pibot/protocol";
import type { BrainHost } from "./brain-host.ts";

export interface BrainOptions {
  port: Port;
  requestSource?: Parameters<typeof startBrain>[0]["requestSource"];
  acp?: Parameters<typeof startBrain>[0]["acp"];
  host: BrainHost;
  dataDir: string;
  dataDirDisplayPath?: string;
  resourcesDir: string;
  version: string;
  platform: NodeJS.Platform;
  terminalPath?: readonly string[];
  dev?: boolean;
  interactiveAttached?: boolean;
  backgroundControlIdle?: () => boolean;
  /** Startup liveness the owner's watchdog and waiters extend on. */
  startupProgress?: (phase: string) => void;
  routineHost?: Parameters<typeof startBrain>[0]["routineHost"];
  routineDev?: Parameters<typeof startBrain>[0]["routineDev"];
  remote?: Parameters<typeof startBrain>[0]["remote"];
  aliasFileSystem?: Parameters<typeof startBrain>[0]["aliasFileSystem"];
  /** Private local builds may opt into source-only built-ins excluded from the public package. */
  includeLocalGmail?: boolean;
}

export function startDesktopBrain(options: BrainOptions): ReturnType<typeof startBrain> {
  return startBrain({
    ...options,
    pluginDir: options.dev
      ? fileURLToPath(new URL("../plugins/", import.meta.url))
      : join(options.resourcesDir, "plugins"),
    ...(options.includeLocalGmail ? { includeLocalGmail: true } : {}),
  });
}
