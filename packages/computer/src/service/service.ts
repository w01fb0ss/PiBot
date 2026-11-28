import type {
  ComputerFailure,
  HostComputerParams,
  HostComputerResults,
} from "@pibot/protocol-base";
import { screenshot } from "../actions/capture.ts";
import { createFrameRegistry } from "../actions/frames.ts";
import type { ImageCodec } from "../actions/image.ts";
import { keys, pointer, uiAction } from "../actions/input.ts";
import { launchCommand, runLaunch } from "../actions/launch.ts";
import { checkedOpenTarget } from "../actions/open-target.ts";
import { uiTree } from "../actions/tree-read.ts";
import { uiBatch } from "../actions/ui-batch.ts";
import { resolveAppName } from "../core/app-names.ts";
import { categoryHint } from "../core/categories.ts";
import {
  type Call,
  createAppQueue,
  type DisplayCapture,
  describeApp,
  forgetRunningApps,
  forgetWindows,
  grantKeyOf,
  resolveApp,
  type ScreenAccess,
  type ServiceContext,
  waitUntilVisible,
} from "../core/context.ts";
import { ComputerError, defaultDisposition, failure } from "../core/errors.ts";
import type { ComputerDriver } from "../core/types.ts";
import { createActivityTracker } from "../guard/activity.ts";
import { createGrantRegistry, type RevokeBy } from "../guard/grants.ts";

// Most apps show a window within 1–2 s of `open`; past this the model gets control back anyway.
const OPEN_WAIT_MS = 3000;

/** Methods that act under a grant token (everything except status / settings / grants). */
export type GrantedMethod = Exclude<
  keyof HostComputerParams,
  | "host.computer.status"
  | "host.computer.installedApps"
  | "host.computer.resolveAppName"
  | "host.computer.openSystemSettings"
  | "host.computer.grants.set"
  | "host.computer.grants.revoke"
>;

export interface AuditEntry {
  method: GrantedMethod;
  botId: string;
  runId: string;
  app?: string;
  ok: boolean;
  code?: string;
  /** The machine hint the model also sees (e.g. which window state blocked a screenshot). */
  detail?: string;
  /** What the driver said, scrubbed (ComputerError.diagnostic); log only, never to the model. */
  diagnostic?: string;
  /**
   * What was acted on, for ui actions: the element action name, or the menu path. Menu
   * titles are the app's UI labels, not user content; capped like the app name.
   */
  target?: string;
  ms: number;
  treeTiming?: Call["treeTiming"];
  displayRead?: Call["displayRead"];
  completed?: number;
}

export interface ComputerServiceOptions {
  driver: ComputerDriver;
  codec: ImageCodec;
  displays?: DisplayCapture;
  /** macOS Screen Recording preflight (the same check as Settings · Computer). */
  screenAccess?(): ScreenAccess;
  blocked?(app: { id: string; name: string }): boolean;
  /** One line per call (who, which app, outcome); never screen text, values or images. */
  audit?(entry: AuditEntry): void;
  /** Called for unexpected driver failures (bugs), with a fixed message and no payload. */
  onInternalError?(method: GrantedMethod, error: unknown): void;
  onCleanupError?(): void;
  now?(): number;
}

/**
 * The host-side computer service: verifies the grant token on every call, resolves and checks
 * the app (blocklist first, then the grant), serialises per app, runs the platform driver and
 * maps expected refusals to `{ ok: false, code }`. Resident helpers are released as soon as the
 * last grant goes away (run ended, stopped, or brain exited).
 */
export function createComputerService(options: ComputerServiceOptions) {
  const now = options.now ?? Date.now;
  let releasing: Promise<void> | undefined;
  const release = () => {
    releasing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...[...inFlight].map((call) => call.operation), ...nameLookups]);
      try {
        ctx.secureScans?.clear();
        ctx.secureKnown?.clear();
        ctx.elements.clear();
        forgetWindows(ctx);
        forgetRunningApps(ctx);
        await options.driver.release();
      } catch {
        options.onCleanupError?.();
        throw new ComputerError("driver_error", "computer_drain_unconfirmed");
      }
      releasing = undefined;
    });
    return releasing;
  };
  const grants = createGrantRegistry({
    now,
    onEmpty: () => {
      void release().catch(() => {
        // release logged the failure; drain/dispose still observe its rejected cleanup barrier.
      });
    },
  });
  const ctx: ServiceContext = {
    driver: options.driver,
    grants,
    codec: options.codec,
    displays: options.displays,
    screenAccess: options.screenAccess,
    blocked: options.blocked ?? (() => false),
    frames: createFrameRegistry({ now }),
    activity: createActivityTracker({ now }),
    elements: new Map(),
    now,
  };
  const lifetime = new AbortController();
  const nameLookups = new Set<Promise<unknown>>();
  const serial = createAppQueue();
  const inFlight = new Set<{
    scope: Call["scope"];
    key: string;
    operation: Promise<unknown>;
  }>();

  async function run<K extends GrantedMethod>(
    method: K,
    params: HostComputerParams[K],
    action: (call: Call) => Promise<HostComputerResults[K]>,
    target?: string,
  ): Promise<HostComputerResults[K]> {
    const started = now();
    let scope: Call["scope"] | undefined;
    let result: HostComputerResults[K] | ComputerFailure;
    let diagnostic: string | undefined;
    const treeTiming: NonNullable<Call["treeTiming"]> = {};
    let activeCall: Call | undefined;
    try {
      await releasing;
      scope = grants.verify(params.token);
      const current = scope;
      const key = grantKeyOf(params.token);
      const operation = Promise.resolve().then(() => {
        current.signal.throwIfAborted();
        activeCall = { scope: current, grantKey: key, signal: current.signal, treeTiming };
        return action(activeCall);
      });
      const pending = { scope, key, operation };
      inFlight.add(pending);
      try {
        result = await operation;
      } finally {
        inFlight.delete(pending);
      }
    } catch (error) {
      const expected = failure(error);
      if (!expected) options.onInternalError?.(method, error);
      if (error instanceof ComputerError) diagnostic = error.diagnostic;
      result = expected ?? {
        ok: false,
        code: "driver_error",
        // The call may have stopped anywhere, including after the driver was handed input.
        disposition: defaultDisposition("driver_error"),
      };
    }
    if (scope)
      options.audit?.({
        method,
        botId: scope.botId,
        runId: scope.runId,
        app:
          "app" in params && typeof params.app === "string" ? params.app.slice(0, 200) : undefined,
        ok: result.ok,
        code: result.ok ? undefined : result.code,
        detail: result.ok ? undefined : result.detail,
        diagnostic,
        ...(target ? { target: target.slice(0, 200) } : {}),
        ms: now() - started,
        ...(method === "host.computer.uiTree"
          ? { treeTiming, displayRead: activeCall?.displayRead }
          : {}),
        ...("completed" in result ? { completed: result.completed } : {}),
      });
    return result as HostComputerResults[K];
  }
  /** Per-app ordering for tree reads and actions; pid resolved first so the lock is precise. */
  async function onApp<T>(call: Call, app: string, action: () => Promise<T>): Promise<T> {
    const resolved = await resolveApp(ctx, call, app);
    return serial(resolved.pid, action);
  }

  return {
    features: options.driver.features,
    /** Loads the driver if needed; undefined when it can run here. */
    driverUnavailable: () => options.driver.unavailableReason(),
    grants: {
      set: (grant: HostComputerParams["host.computer.grants.set"]) => grants.set(grant),
      revokeAll: () => {
        ctx.secureScans?.clear();
        ctx.secureKnown?.clear();
        return grants.revokeAll();
      },
      revoke(by: RevokeBy) {
        ctx.secureScans?.clear();
        ctx.secureKnown?.clear();
        const count = grants.revoke(by);
        if ("token" in by) ctx.frames.dropGrant(grantKeyOf(by.token));
        return count;
      },
      /** Called after revoke: new calls cannot enter, and cancellation alone does not prove idle. */
      async drain(by: RevokeBy) {
        const calls = [...inFlight].filter((call) =>
          "token" in by
            ? call.key === grantKeyOf(by.token)
            : "runId" in by
              ? call.scope.runId === by.runId
              : call.scope.botId === by.botId,
        );
        await Promise.allSettled(calls.map((call) => call.operation));
        await options.driver.drain?.();
        await releasing;
        if ("runId" in by) ctx.activity.release(by.runId);
        if (!grants.size()) ctx.activity.clear();
      },
    },
    /**
     * Installed apps for the blocklist editor: not grant-scoped, read-only, bounded by
     * `limit` and the driver's per-call timeout; never asks for any permission.
     */
    async installedApps(
      p: HostComputerParams["host.computer.installedApps"],
      signal?: AbortSignal,
    ): Promise<HostComputerResults["host.computer.installedApps"]> {
      const limit = p.limit ?? 2000;
      try {
        const found = await options.driver.installedApps(limit, signal);
        const apps = found.apps.slice(0, limit).map((a) => {
          const category = categoryHint(a);
          return {
            id: a.id.slice(0, 512),
            name: (a.name || a.id).slice(0, 200),
            ...(a.iconPath?.startsWith("/") ? { iconPath: a.iconPath } : {}),
            ...(category ? { category } : {}),
          };
        });
        return { supported: true, apps, truncated: found.truncated || found.apps.length > limit };
      } catch (error) {
        const expected = failure(error);
        if (!expected) throw error;
        return {
          supported: false,
          reason:
            expected.code === "unsupported" && expected.detail === "osascript_unavailable"
              ? "helper_unavailable"
              : expected.code,
        };
      }
    },
    async resolveAppName(
      p: HostComputerParams["host.computer.resolveAppName"],
      signal?: AbortSignal,
    ): Promise<HostComputerResults["host.computer.resolveAppName"]> {
      const active = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(15_000),
        ...(signal ? [signal] : []),
      ]);
      await releasing;
      const job = resolveAppName(ctx, p.name, active);
      nameLookups.add(job);
      try {
        return { id: (await job) ?? null };
      } finally {
        nameLookups.delete(job);
      }
    },
    listApps: (p: HostComputerParams["host.computer.listApps"]) =>
      run("host.computer.listApps", p, async (call) => ({
        ok: true,
        apps: (await ctx.driver.listApps(call.signal))
          .slice(0, 500)
          .map((a) => describeApp(ctx, a)),
      })),
    frontmostApp: (p: HostComputerParams["host.computer.frontmostApp"]) =>
      run("host.computer.frontmostApp", p, async (call) => {
        const app = await ctx.driver.frontmostApp(call.signal);
        return { ok: true, app: app && describeApp(ctx, app) };
      }),
    screenshot: (p: HostComputerParams["host.computer.screenshot"]) =>
      run("host.computer.screenshot", p, (call) => screenshot(ctx, call, p)),
    uiTree: (p: HostComputerParams["host.computer.uiTree"]) =>
      run("host.computer.uiTree", p, (call) => onApp(call, p.app, () => uiTree(ctx, call, p))),
    uiAction: (p: HostComputerParams["host.computer.uiAction"]) =>
      run(
        "host.computer.uiAction",
        p,
        (call) =>
          onApp(call, p.app, () =>
            p.action === "batch"
              ? uiBatch(ctx, call, p, (error) =>
                  options.onInternalError?.("host.computer.uiAction", error),
                )
              : uiAction(ctx, call, p),
          ),
        p.action === "menu" ? `menu ${p.path.join(" › ")}` : p.action,
      ),
    pointer: (p: HostComputerParams["host.computer.pointer"]) =>
      run("host.computer.pointer", p, (call) => pointer(ctx, call, p)),
    keys: (p: HostComputerParams["host.computer.keys"]) =>
      run("host.computer.keys", p, (call) => onApp(call, p.app, () => keys(ctx, call, p))),
    open: (p: HostComputerParams["host.computer.open"]) =>
      run("host.computer.open", p, async (call) => {
        ctx.secureScans?.clear();
        ctx.secureKnown?.clear();
        const target = await checkedOpenTarget(ctx, call, p.target);
        const app = target.kind === "app" ? target.name : target.app;
        const exe =
          ctx.driver.platform === "win32" && app !== undefined
            ? await ctx.driver.launchPath?.(app, call.signal)
            : undefined;
        await runLaunch(launchCommand(ctx.driver.platform, target, exe), call.signal);
        // The lists read before the launch cannot show the app or the windows it just created.
        forgetRunningApps(ctx);
        forgetWindows(ctx);
        // `open` returns once LaunchServices has the request; the model's next call is usually
        // ui_tree on that app, which needs it running with a window (otherwise app_not_running).
        if (app !== undefined)
          await waitUntilVisible(ctx, call, app, OPEN_WAIT_MS, (found, window, signal) =>
            // In the app's queue: a read replaces element ids another run may be holding.
            serial(found.pid, () =>
              ctx.driver.readTree(window, { maxNodes: 1, maxDepth: 1 }, signal),
            ),
          );
        let opened: Awaited<ReturnType<typeof resolveApp>> | undefined;
        if (app !== undefined) {
          try {
            opened = await resolveApp(ctx, call, app);
          } catch (error) {
            // LaunchServices accepting a launch does not guarantee a running app or window.
            if (!(error instanceof ComputerError) || error.code !== "app_not_running") throw error;
          }
        }
        return {
          ok: true,
          ...(opened
            ? { app: { id: opened.id, name: (opened.name || opened.id).slice(0, 200) } }
            : {}),
        };
      }),
    userActivity: (p: HostComputerParams["host.computer.userActivity"]) =>
      run("host.computer.userActivity", p, async (call) => {
        const state = await ctx.driver.session(call.signal);
        return {
          ok: true,
          idleSeconds: ctx.activity.observe(call.scope.runId, state.hidIdleSeconds),
          locked: state.locked,
        };
      }),
    /** Drops every grant (brain exited / host stopping) and releases helpers. */
    async dispose() {
      lifetime.abort();
      grants.revokeAll();
      ctx.frames.clear();
      ctx.elements.clear();
      forgetWindows(ctx);
      forgetRunningApps(ctx);
      await release();
      ctx.appNames?.clear();
      ctx.activity.clear();
    },
  };
}

export type ComputerService = ReturnType<typeof createComputerService>;
