import type { CommandResult, RunCommandOptions } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import type { prepareGitInitialization } from "./git-init.ts";

export async function runGitInitialization(
  plan: NonNullable<Awaited<ReturnType<typeof prepareGitInitialization>>>,
  input: RunCommandOptions,
  signal: AbortSignal,
  ports: {
    execute(
      command: string,
      phase: "directories" | "initialize" | "reinitialize",
      roots: string[],
    ): Promise<
      Pick<CommandResult, "exitCode" | "truncatedOutput" | "sandboxBlock" | "pinnedFilters">
    >;
  },
) {
  async function phase(
    command: string,
    roots: string[],
    kind: "directories" | "initialize" | "reinitialize",
  ) {
    await plan.check();
    await verifyWorkspace(input.rootIdentities, signal);
    return ports.execute(command, kind, roots);
  }
  if (plan.setupCommand) {
    const created = await phase(plan.setupCommand, [plan.setupWriteRoot], "directories");
    if (created.exitCode !== 0 || signal.aborted)
      return {
        ...created,
        exitCode: created.exitCode === 0 ? null : created.exitCode,
        truncatedOutput: `Git目录准备失败，Git未运行 / Git directory preparation failed; Git was not run.\n${created.truncatedOutput}`,
      };
    await plan.complete();
  }
  return phase(plan.command, [plan.gitDir], plan.existingConfig ? "reinitialize" : "initialize");
}
