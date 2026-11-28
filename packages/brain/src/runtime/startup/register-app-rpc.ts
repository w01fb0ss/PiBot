// Register application settings and other shared brain RPCs at startup.
import { readFile as readDependencyManifest } from "node:fs/promises";
import { PI_VERSION } from "@pibot/agent";
import {
  AppDependenciesSchema,
  type createPeer,
  type KernelEvents,
  type KernelMethods,
  PHONE_COMPAT_LEVEL,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import {
  type AuditRepo,
  type BotsRepo,
  RunEventsRepo,
  RunsRepo,
  type SettingsRepo,
} from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { startBrain } from "../../index.ts";
import type { SearchService } from "../../integrations/search/search-service.ts";
import { AppUpdates } from "../../integrations/system/app-updates.ts";
import { feedbackIssueUrl } from "../../integrations/system/feedback.ts";
import type { NetworkProxyService } from "../../integrations/system/network-proxy.ts";
import type { LocalService } from "../../local-service.ts";
import type { RunRetention } from "../history/run-retention.ts";
import { measureStorageInfo } from "../history/storage-info.ts";
import type { ModelProvidersPort } from "../models/port.ts";

interface StartupContext {
  db: import("node:sqlite").DatabaseSync;
  network: NetworkProxyService;
  opts: Parameters<typeof startBrain>[0];
  capabilities: LocalService;
  handle: KernelRegisterRpc;
  dataDir: string;
  networkChanged: (_value: {
    enabled: boolean;
    address: string | null;
    hasCredentials: boolean;
  }) => void;
  search: SearchService;
  peer: ReturnType<typeof createPeer<typeof KernelMethods, typeof KernelEvents>>;
  providerTests: AbortController;
  settings: SettingsRepo;
  models: () => ModelProvidersPort;
  audit: AuditRepo;
  bots: BotsRepo;
  dependencyManifest: URL;
  runRetention: RunRetention;
  waitForSessionRecovery(signal: AbortSignal): Promise<void>;
}

function outcomeText(value: string | null): string | null {
  return value ? value.slice(0, 200) : null;
}

export function registerAppRpc(ctx: StartupContext) {
  const updates = new AppUpdates({
    fetch: ctx.network.transport.fetch,
    version: ctx.opts.version,
    platform: ctx.opts.platform,
    arch: process.arch,
    signal: ctx.capabilities.shutdown.signal,
  });
  ctx.handle("app.openFeedback", async (input) => {
    if (!ctx.opts.host.openExternal)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    const botId = ctx.bots.getMain()?.id;
    if (!botId) throw new RpcError(RpcErrorCodes.internal, "main_bot_unavailable");
    const redactor = ctx.capabilities.deps.redactor;
    if (redactor.redact(input.repository) !== input.repository)
      throw new RpcError(RpcErrorCodes.invalidParams, "feedback_repository_invalid");
    await ctx.opts.host.openExternal(
      feedbackIssueUrl({
        repository: input.repository,
        title: redactor.redact(input.title),
        description: redactor.redact(input.description),
        version: ctx.opts.version,
        platform: ctx.opts.platform,
      }),
      ctx.capabilities.shutdown.signal,
    );
    ctx.audit.append({
      botId,
      kind: "feedback.opened",
      summary: "Feedback draft opened / 已打开反馈草稿",
      detail: { actor: "user" },
    });
    return null;
  });
  ctx.handle("app.openLink", async ({ url }) => {
    if (!ctx.opts.host.openExternal)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    await ctx.opts.host.openExternal(url, ctx.capabilities.shutdown.signal);
    return null;
  });
  ctx.handle("app.checkUpdates", async () => updates.check());
  ctx.handle("app.about", async () => ({
    version: ctx.opts.version,
    phoneCompat: PHONE_COMPAT_LEVEL,
    ...(ctx.opts.platform === "darwin" ||
    ctx.opts.platform === "win32" ||
    ctx.opts.platform === "linux"
      ? { platform: ctx.opts.platform }
      : {}),
  }));
  ctx.handle("app.dependencies", async () => {
    try {
      const bytes = await readDependencyManifest(ctx.dependencyManifest, {
        signal: AbortSignal.any([ctx.capabilities.shutdown.signal, AbortSignal.timeout(20_000)]),
      });
      if (bytes.length > 1024 * 1024) throw new Error("dependency_manifest_limit");
      return AppDependenciesSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
  ctx.handle("app.getInfo", async () => ({
    version: ctx.opts.version,
    platform: ctx.opts.platform as "darwin" | "win32" | "linux",
    dataDir: ctx.opts.dataDirDisplayPath ?? ctx.dataDir,
    piVersion: PI_VERSION,
  }));
  ctx.handle("app.openDataDir", async (_params, context) => {
    if (context.phone || context.source === "acp")
      throw new RpcError(RpcErrorCodes.unsupported, "desktop_only");
    if (!ctx.opts.host.revealPath)
      throw new RpcError(RpcErrorCodes.unsupported, "path_reveal_unavailable");
    await ctx.opts.host.revealPath(
      { path: ctx.dataDir, allowedRoots: [ctx.dataDir] },
      AbortSignal.any([
        context.signal,
        ctx.capabilities.shutdown.signal,
        AbortSignal.timeout(15_000),
      ]),
    );
    return null;
  });
  ctx.handle("app.storageInfo", async (_params, context) => {
    if (context.phone || context.source === "acp")
      throw new RpcError(RpcErrorCodes.unsupported, "desktop_only");
    return measureStorageInfo(
      ctx.dataDir,
      AbortSignal.any([
        context.signal,
        ctx.capabilities.shutdown.signal,
        AbortSignal.timeout(15_000),
      ]),
    );
  });
  ctx.networkChanged = (value) => {
    ctx.search.resetCooldown();
    ctx.peer.emit("network.changed", value);
  };
  ctx.handle("network.getConfig", async () => ctx.network.get());
  ctx.handle("network.setConfig", async (input) =>
    ctx.network.set(
      input,
      AbortSignal.any([ctx.providerTests.signal, AbortSignal.timeout(25_000)]),
    ),
  );
  ctx.handle("network.test", async () => ctx.network.test(ctx.providerTests.signal));
  ctx.handle("settings.get", async () => ctx.settings.get());
  ctx.handle("settings.set", async (patch, { signal }) => {
    if (patch.yoloUnisolatedCommandsAt !== undefined || patch.yoloUnisolatedCommands === true)
      throw new RpcError(RpcErrorCodes.invalidParams, "windows_yolo_consent_required");
    if (patch.yoloUnisolatedCommands === false) {
      // Keep the original withdrawal request. Its settings write and audit must commit together.
      if (Object.keys(patch).length !== 1)
        throw new RpcError(RpcErrorCodes.invalidParams, "windows_yolo_withdrawal_is_separate");
      signal.throwIfAborted();
      return ctx.capabilities.yolo.revokeWindowsConsent();
    }
    const value = await ctx
      .models()
      .settings.setSettings(
        patch,
        AbortSignal.any([ctx.providerTests.signal, AbortSignal.timeout(25_000)]),
      );
    ctx.peer.emit("settings.changed", value.settings);
    if (patch.backgroundCommandLimitMinutes !== undefined)
      ctx.capabilities.background.refreshLimits();
    // Whether and which commands may leave the sandbox is a security decision too.
    if (patch.strictSandbox !== undefined)
      ctx.audit.append({
        botId: ctx.bots.getMain()?.id ?? "",
        kind: "permissions.changed",
        summary: `Strict sandbox ${patch.strictSandbox ? "on" : "off"}`,
        detail: {
          actor: "user",
          reasonCode: patch.strictSandbox ? "strict_sandbox_on" : "strict_sandbox_off",
        },
      });
    if (patch.sandboxAutoOutsideCommands !== undefined)
      ctx.audit.append({
        botId: ctx.bots.getMain()?.id ?? "",
        kind: "permissions.changed",
        summary: "Remembered direct-run permissions changed",
        detail: {
          actor: "user",
          reasonCode: "sandbox_outside_auto_changed",
          entryCount: patch.sandboxAutoOutsideCommands.length,
        },
      });
    if (patch.sandboxOutsideCommands !== undefined)
      ctx.audit.append({
        botId: ctx.bots.getMain()?.id ?? "",
        kind: "permissions.changed",
        summary: `Commands outside the sandbox: ${patch.sandboxOutsideCommands.join(", ") || "none"}`,
        detail: {
          actor: "user",
          reasonCode: "sandbox_outside_commands_changed",
          entryCount: patch.sandboxOutsideCommands.length,
        },
      });
    // The computer indicator is app chrome in the interface language; redraw it on a switch.
    ctx.capabilities.computerGrants.runs.guard.changed();
    if (value.main) ctx.peer.emit("bots.changed", { botId: value.main.id, reason: "updated" });
    return value.settings;
  });
  ctx.handle("runs.cleanupEstimate", async ({ olderThanDays }, { signal }) => {
    await ctx.waitForSessionRecovery(signal);
    return ctx.runRetention.estimate(olderThanDays, signal);
  });
  ctx.handle("runs.cleanup", async ({ olderThanDays }, { signal }) => {
    await ctx.waitForSessionRecovery(signal);
    ctx.audit.append({
      botId: ctx.bots.getMain()?.id ?? "",
      kind: "run.retention.requested",
      summary: "Old run record cleanup requested",
      detail: { actor: "user", reasonCode: "run_retention_requested", olderThanDays },
    });
    const result = await ctx.runRetention.cleanup(olderThanDays);
    ctx.audit.append({
      botId: ctx.bots.getMain()?.id ?? "",
      kind: "run.retention.cleaned",
      summary: "Old run records cleaned",
      detail: {
        actor: "user",
        reasonCode: "run_retention_cleanup",
        olderThanDays,
        runCount: result.runs,
        eventCount: result.events,
        executionCount: result.executions,
        fileCount: result.sessionFiles + result.resultFiles,
      },
    });
    return result;
  });
  ctx.handle("runs.events", async ({ runId, afterSeq, limit }) => {
    const run = new RunsRepo(ctx.db).get(runId);
    if (!run) throw new RpcError(RpcErrorCodes.invalidParams, "run_not_found");
    const page = new RunEventsRepo(ctx.db).publicPage(runId, afterSeq, limit);
    if (page.events.some((event) => event.conversationId !== run.conversationId))
      throw new Error("run_event_identity_mismatch");
    return {
      events: page.events.map((event) => ({
        seq: event.seq,
        runId,
        conversationId: run.conversationId,
        kind: event.kind,
        at: event.at,
        ...(event.kind === "run.finished" ||
        event.kind === "run.interrupted" ||
        event.kind === "run.sealed"
          ? {
              outcome: {
                status: run.status,
                stopReason: outcomeText(run.stopReason),
                errorCode: outcomeText(run.errorCode),
              },
            }
          : {}),
      })),
      nextSeq: page.events.at(-1)?.seq ?? afterSeq,
      settled: page.settled,
    };
  });
}
