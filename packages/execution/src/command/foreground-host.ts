import type { Writable } from "node:stream";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { ExecError, type ExecOptions } from "../core/types.ts";
import type { IsolationProbeStage } from "../sandbox/isolation-probe.ts";
import { prepareSandboxHost } from "../sandbox/sandbox-host-launch.ts";
import { executeProcess, type ProcessControl } from "./process.ts";

/** The same output/tree owner as ordinary commands; SRT state lives only in this child host. */
export async function executeHostedCommand(input: {
  hostSsh?: import("../ssh/ssh-command.ts").HostSshCommand;
  options: ExecOptions;
  config: SandboxRuntimeConfig;
  allowAll: boolean;
  privateNetworkHosts?: string[];
  command: string;
  commandId: string;
  commandText?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  log: Writable;
  onOutput?: (text: string) => void;
  onStderr?: (text: string) => void;
  onProcess?: (control: ProcessControl) => void;
  onExit?: (code: number | null) => void;
  onProbeStage?: (stage: IsolationProbeStage) => void;
  prepared(record: ProcessControl["record"] | undefined): Promise<void>;
  dispatch?(): void;
}) {
  const host = await prepareSandboxHost({
    tempDir: input.options.tempDir,
    systemHome: input.options.systemHome,
    args: input.options.helperArgs?.sandbox,
  });
  let drained = true;
  try {
    input.signal.throwIfAborted();
    return await executeProcess({
      shell: host.executable,
      args: host.args,
      cwd: input.cwd,
      env: host.env,
      platform: input.options.platform,
      signal: input.signal,
      log: input.log,
      redactor: input.options.redactor,
      onOutput: input.onOutput,
      onStderr: input.onStderr,
      onProcess: input.onProcess,
      onExit: input.onExit,
      host: {
        payload: host.payload({
          ...(input.hostSsh ? { hostSsh: input.hostSsh } : {}),
          config: input.config,
          allowAll: input.allowAll,
          ...(input.privateNetworkHosts !== undefined
            ? { privateNetworkHosts: input.privateNetworkHosts }
            : {}),
          command: input.command,
          commandId: input.commandId,
          ...(input.commandText ? { commandText: input.commandText } : {}),
          cwd: input.cwd,
          env: input.env,
          foreground: true,
          ...(input.onProbeStage ? { isolationProbe: true as const } : {}),
        }),
        prepared: input.prepared,
        dispatch: input.dispatch,
        onProbeStage: input.onProbeStage,
      },
    });
  } catch (error) {
    drained = !(error instanceof ExecError && error.reason === "cleanup_failed");
    throw error;
  } finally {
    if (drained) await host.cleanup();
  }
}
