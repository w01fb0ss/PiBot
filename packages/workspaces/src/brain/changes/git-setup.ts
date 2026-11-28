import type { WorkspaceLocal as LocalService } from "@pibot/brain/kit";
import {
  findGit,
  type GitInstallPlan,
  gitInstallPlan,
  gitVersion,
  runGitInstaller,
  waitForGit,
} from "@pibot/execution";
import { BotsRepo } from "@pibot/storage";
import type { GitSetupStatus } from "@pibot/workspaces-contract/full";

/** Apple's installer downloads and installs for several minutes; past this the card says so. */
const XCODE_WAIT_MS = 20 * 60_000;
const LINUX_SETTLE_MS = 10_000;

type Failure = NonNullable<GitSetupStatus["reason"]>;

/**
 * Installs Git system-wide when the user clicks 「安装」 on a Git card (maintainers 2026-11-21):
 * macOS and Linux only; Windows ships Git with Pi Bot. One install at a time per brain; every
 * start and end is audited with the command, never the installer's output.
 */
export class GitSetup {
  private running?: Promise<void>;
  private failure?: Failure;
  private readonly lifetime = new AbortController();

  constructor(private readonly local: LocalService) {}

  private get options() {
    const deps = this.local.deps;
    return {
      platform: deps.platform,
      env: deps.env,
      userHome: deps.userHome,
      resourcesDir: deps.resourcesDir,
    };
  }

  async status(signal: AbortSignal): Promise<GitSetupStatus> {
    const program = await findGit(this.options);
    if (program) {
      const version = await gitVersion(this.options, program, signal);
      signal.throwIfAborted();
      // A file can exist while Apple's developer tools or Windows application controls block it.
      if (version) {
        this.failure = undefined;
        return { state: "available", version };
      }
    }
    const plan = await gitInstallPlan(this.local.deps.platform);
    if (plan.kind === "unsupported") return { state: "unsupported" };
    if (plan.kind === "manual" || (plan.kind === "package" && !plan.elevate))
      return {
        state: "missing",
        installer: "manual",
        ...(plan.kind === "package"
          ? { manualCommand: plan.manualCommand, reason: "no_elevation" }
          : {}),
      };
    return {
      state: this.running ? "installing" : this.failure ? "failed" : "missing",
      installer: plan.kind,
      command: plan.command,
      manualCommand: plan.manualCommand,
      ...(!this.running && this.failure ? { reason: this.failure } : {}),
    };
  }

  /** Starts the installer and answers at once; a click while one runs joins it. */
  async install(signal: AbortSignal): Promise<GitSetupStatus> {
    if (this.running || this.lifetime.signal.aborted) return this.status(signal);
    const current = await this.status(signal);
    if (
      current.installer === "manual" ||
      (current.state !== "missing" && current.state !== "failed")
    )
      return current;
    const plan = await gitInstallPlan(this.local.deps.platform);
    if (plan.kind !== "xcode" && (plan.kind !== "package" || !plan.elevate))
      return this.status(signal);
    // Re-checked after the awaits above: two clicks in the same tick start one installer.
    if (this.running) return this.status(signal);
    this.failure = undefined;
    const job = this.run(plan).finally(() => {
      if (this.running === job) this.running = undefined;
    });
    this.running = job;
    return this.status(signal);
  }

  private async run(plan: GitInstallPlan) {
    const deps = this.local.deps;
    const signal = this.lifetime.signal;
    const command =
      plan.kind === "package"
        ? plan.elevate
          ? `pkexec ${plan.command}`
          : plan.command
        : plan.kind === "xcode"
          ? plan.command
          : "";
    const started = Date.now();
    this.audit("started", command);
    let reason: Failure | "installed";
    let exitCode: number | null = null;
    try {
      const outcome = await runGitInstaller(plan, {
        platform: deps.platform,
        env: deps.env,
        signal,
      });
      exitCode = outcome.exitCode;
      if (outcome.outcome === "started" || outcome.outcome === "installed") {
        const found = await waitForGit(this.options, {
          signal,
          timeoutMs: plan.kind === "xcode" ? XCODE_WAIT_MS : LINUX_SETTLE_MS,
          intervalMs: plan.kind === "xcode" ? 3000 : 1000,
        });
        reason = found ? "installed" : signal.aborted ? "cancelled" : "timeout";
      } else reason = signal.aborted ? "cancelled" : outcome.outcome;
    } catch (error) {
      // Spawn failures resolve inside runGitInstaller; anything here is a bug worth a warning.
      deps.logger.warn(
        JSON.stringify({
          module: "workspaces",
          event: "git_install_error",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      reason = signal.aborted ? "cancelled" : "failed";
    }
    if (reason !== "installed") this.failure = reason;
    this.audit(reason, command, { exitCode, durationMs: Date.now() - started });
    deps.logger.info(
      JSON.stringify({
        module: "workspaces",
        event: "git_install_finished",
        platform: deps.platform,
        outcome: reason,
        exitCode,
      }),
    );
  }

  private audit(
    reasonCode: Failure | "installed" | "started",
    command: string,
    extra: { exitCode?: number | null; durationMs?: number } = {},
  ) {
    const main = new BotsRepo(this.local.deps.db).getMain();
    if (!main) return;
    const platform = this.local.deps.platform;
    const shown = command || "-";
    this.local.approvals.audit.append({
      botId: main.id,
      kind: "git.install",
      summary:
        reasonCode === "started"
          ? `Git install started on ${platform}: ${shown} / 开始安装 Git（${platform}）：${shown}`
          : reasonCode === "installed"
            ? `Git installed on ${platform} / Git 已安装（${platform}）`
            : `Git install did not finish on ${platform} (${reasonCode}) / Git 没装上（${platform}，${reasonCode}）`,
      detail: {
        actor: "user",
        toolName: "git_install",
        reasonCode,
        outsideSandbox: true,
        ...(command ? { command } : {}),
        ...(extra.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      },
    });
  }

  /** Stops waiting (an elevated package manager may keep running; it is the system's now). */
  async dispose() {
    this.lifetime.abort();
    await this.running?.catch(() => {
      // run() never rejects; nothing is left to report once the brain stops.
    });
  }
}
