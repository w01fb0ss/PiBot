import { runSystemInstaller, systemPackageInstallPlan } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";

const missingPackages = {
  linux_bubblewrap_missing: "bubblewrap",
  linux_socat_missing: "socat",
} as const;

function packageFor(reason: string | undefined) {
  if (reason === "linux_bubblewrap_missing" || reason === "linux_socat_missing")
    return missingPackages[reason];
}

export function registerCommandProtectionRpc(handle: KernelRegisterRpc, local: LocalService) {
  let installing = false;
  handle("permissions.commandProtection", async (params, { signal, phone, source }) => {
    const { platform, env, db } = local.deps;
    if (platform !== "linux" || phone || source === "acp" || local.deps.executionLocation)
      throw new RpcError(RpcErrorCodes.invalidParams, "command_protection_unavailable");
    const lifetime = AbortSignal.any([signal, local.shutdown.signal]);
    const { available, reason } = await local.target.isolationStatus(lifetime);
    const status = { available, reason };
    const dependency = packageFor(reason);
    if (!dependency || available) return status;
    const plan = await systemPackageInstallPlan(dependency);
    const setup = {
      ...status,
      dependency,
      canInstall: plan.kind === "package" && !!plan.elevate,
      ...(plan.kind === "package" ? { manualCommand: plan.manualCommand } : {}),
    };
    if (params.action === "check" || params.dependency !== dependency) return setup;
    if (plan.kind !== "package" || !plan.elevate) return { ...setup, outcome: "failed" };
    if (installing) return { ...setup, outcome: "busy" };
    lifetime.throwIfAborted();
    const main = new BotsRepo(db).getMain();
    if (!main) throw new RpcError(RpcErrorCodes.internal, "command_protection_unavailable");
    const audit = (phase: "started" | "finished", exitCode?: number | null) =>
      local.approvals.audit.append({
        botId: main.id,
        kind: phase === "started" ? "exec.started" : "exec.finished",
        summary: plan.command,
        detail: {
          actor: "user",
          outsideSandbox: true,
          command: plan.command,
          ...(exitCode !== undefined ? { exitCode } : {}),
        },
      });
    audit("started");
    installing = true;
    let exitCode: number | null = null;
    try {
      // Once accepted, closing the card only stops waiting. Keep auditing to actual completion.
      const result = await runSystemInstaller(plan, {
        platform,
        env,
        signal: local.shutdown.signal,
      });
      exitCode = result.exitCode;
      return {
        ...setup,
        outcome:
          result.outcome === "installed" || result.outcome === "denied" ? result.outcome : "failed",
      };
    } finally {
      installing = false;
      audit("finished", exitCode);
    }
  });
}
