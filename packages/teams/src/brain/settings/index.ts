import { createHash } from "node:crypto";
import type { CapabilityContext, ToolExecutor, ToolRunContext } from "@pibot/brain/kit";
import { mainDirectRun } from "@pibot/brain/kit";
import { createTranslator, policyReasonKey } from "@pibot/i18n";
import { piSettingsTools } from "@pibot/teams-contract";
import { settingsCard } from "./cards.ts";
import { readMediaModels } from "./media-models.ts";
import {
  prepareSettings,
  readSettings,
  type SettingsPlan,
  SettingsRefusal,
  settingsRequests,
} from "./plan.ts";

function interactive(ctx: CapabilityContext, context: ToolRunContext) {
  return (
    mainDirectRun(ctx.local, context) && !context.executionDevice?.target?.startsWith("runner:")
  );
}

function refusal(code: string, context: ToolRunContext) {
  const t = createTranslator(context.language);
  return { text: t(policyReasonKey(code) ?? "policy.reason.settings_unavailable"), isError: true };
}

function reason(error: unknown) {
  if (error instanceof SettingsRefusal) return error.code;
  return error instanceof Error && error.message === "settings_unavailable"
    ? error.message
    : "settings_invalid_value";
}

function binding(plan: SettingsPlan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function registerPiSettings(ctx: CapabilityContext) {
  const rpc = ctx.rpc.settings;
  if (!rpc) return { async stop() {} };
  let writing = Promise.resolve();
  const onlyPi =
    (run: ToolExecutor): ToolExecutor =>
    (context, call, signal, authorization) =>
      interactive(ctx, context)
        ? run(context, call, signal, authorization)
        : Promise.resolve(refusal("pi_manager_main_only", context));

  const releases = [
    ctx.tools.executor(
      "settings_read",
      onlyPi(async (context, call, signal) => {
        const {
          scope = "app",
          mediaModels,
          videoModel,
          offset = 0,
        } = piSettingsTools.settings_read.schema.parse(call.input);
        try {
          if (mediaModels)
            return await readMediaModels(ctx, context, mediaModels, videoModel, offset, signal);
          return { text: JSON.stringify(await readSettings(ctx, rpc, context, scope, signal)) };
        } catch (error) {
          signal.throwIfAborted();
          return refusal(reason(error), context);
        }
      }),
    ),
    ctx.local.provideToolPolicyFor(
      "settings_change",
      async (context, _call, _tool, input, signal) => {
        if (!interactive(ctx, context)) return { requests: [] };
        try {
          const requested = settingsRequests(ctx, input);
          const plan = await prepareSettings(ctx, rpc, context, requested, signal);
          return {
            primary: true,
            requests: [
              { category: "settings_change", operation: plan.security ? "security" : "ordinary" },
            ],
            prepared: plan,
            binding: binding(plan),
          };
        } catch (error) {
          signal.throwIfAborted();
          const code = reason(error);
          return {
            primary: true,
            requests: [],
            refusal: code,
            refusalText: refusal(code, context).text,
            ...(error instanceof SettingsRefusal && error.action
              ? { settingsAction: error.action }
              : {}),
          };
        }
      },
    ),
    ctx.tools.executor(
      "settings_change",
      onlyPi(async (context, call, signal, authorization) => {
        const plan = authorization?.data as SettingsPlan | undefined;
        if (!plan || (plan.security && (!authorization?.confirmedNow || !authorization.approvalId)))
          return refusal("settings_security_confirm", context);
        const authorizationReceipt = authorization;
        if (!authorizationReceipt) return refusal("settings_unavailable", context);
        const t = createTranslator(context.language);
        const apply = writing.then(async () => {
          signal.throwIfAborted();
          let applied = 0;
          try {
            // A waiting chat card and a queued write both bind the displayed state to its execution.
            const requests = settingsRequests(ctx, call.input);
            const current = await prepareSettings(ctx, rpc, context, requests, signal);
            if (binding(current) !== binding(plan)) return refusal("changed", context);
            authorizationReceipt.assertCurrent();
            for (const { write, rows } of current.operations) {
              await rpc(write.method, write.params, signal);
              for (const row of rows) {
                ctx.local.approvals.audit.append({
                  botId: context.botId,
                  runId: context.runId,
                  kind: "pi.settings_changed",
                  summary: "Pi changed a setting / Pi 修改了设置",
                  detail: {
                    actor: "user",
                    reasonCode: "settings_change_applied",
                    ...(authorizationReceipt.approvalId && {
                      approvalId: authorizationReceipt.approvalId,
                    }),
                    toolCallId: call.id,
                    piSetting: {
                      scope: row.scope,
                      key: row.key,
                      before: row.before,
                      after: row.after,
                    },
                  },
                });
                applied++;
              }
            }
          } catch {
            signal.throwIfAborted();
            ctx.logger.warn(
              JSON.stringify({ module: "pi-settings", event: "save_failed", applied }),
            );
            return { text: t("piSettings.applyFailed", { count: applied }), isError: true };
          }
          return { text: t("piSettings.applied", { count: applied }) };
        });
        writing = apply.then(
          () => undefined,
          () => undefined,
        );
        return apply;
      }),
    ),
    ctx.tools.card("settings_change", settingsCard),
  ];
  return {
    async stop() {
      for (const release of releases) release();
      await writing;
    },
  };
}
