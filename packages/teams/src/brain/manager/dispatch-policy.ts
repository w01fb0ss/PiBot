import { createHash } from "node:crypto";
import {
  type CapabilityContext,
  DISPATCH_FOLDER_CONFIRM,
  DISPATCH_MODEL_CONFIRM,
  type DispatchFolder,
  resolveDispatchFolder,
  type ToolRunContext,
} from "@pibot/brain/kit";
import { piManagerTools } from "@pibot/teams-contract";
import { personSuppliedFolder } from "./dispatch-folder.ts";
import {
  dispatchModelChoices,
  type PreparedDispatchModels,
  prepareDispatchModels,
} from "./dispatch-models.ts";
import { managerFailure } from "./errors.ts";
import { findBot, findGroup } from "./lookup.ts";

export interface DispatchApproval {
  kind: "bot" | "group";
  targetId: string;
  botId: string;
  folder?: DispatchFolder;
  models: PreparedDispatchModels;
}

export function dispatchPolicy(
  ctx: CapabilityContext,
  kind: "bot" | "group",
  context: ToolRunContext,
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  const args = (
    kind === "bot" ? piManagerTools.send_to_bot : piManagerTools.send_to_group
  ).schema.safeParse(input);
  if (!args.success) return { requests: [] };
  const folderInput =
    args.data.folder === undefined
      ? undefined
      : personSuppliedFolder(ctx, context, args.data.folder);
  const choices = dispatchModelChoices(ctx, args.data);
  if (!folderInput && !choices.choices.length && !choices.error) return { requests: [] };
  return {
    requests: [],
    confirmation: folderInput
      ? DISPATCH_FOLDER_CONFIRM
      : choices.needsConfirmation
        ? DISPATCH_MODEL_CONFIRM
        : undefined,
    async inspect() {
      const bot = "bot" in args.data ? findBot(ctx.db, args.data.bot) : undefined;
      const group = "group" in args.data ? findGroup(ctx.db, args.data.group) : undefined;
      const target = bot ?? group;
      const botId = bot?.id ?? group?.coordinatorBotId;
      // The approval-card validator reports unavailable recipients without inspecting their folders.
      if (!target || target.archivedAt || !botId || bot?.isMain || group?.paused) return {};
      let action = "dispatch_models";
      try {
        let folder: DispatchFolder | undefined;
        if (folderInput !== undefined) {
          action = "dispatch_folder";
          const remotePaths = bot
            ? ctx.local.workplaces.repo.remoteFolders(bot.id).map(({ path }) => path)
            : (group?.folders ?? []).filter(({ location }) => !!location).map(({ path }) => path);
          folder = await resolveDispatchFolder(ctx.local, folderInput, botId, remotePaths, signal);
          action = "dispatch_models";
        }
        const models = await prepareDispatchModels(ctx, choices, signal);
        const prepared: DispatchApproval = {
          kind,
          targetId: target.id,
          botId,
          folder,
          models,
        };
        // Health can change after approval. Bind the recipient and endpoint, not transient health.
        const binding = {
          kind,
          targetId: target.id,
          botId,
          folder,
          crossProvider: models.needsConfirmation,
          choices: models.choices.map(({ bot, model, needs, stepId, destination }) => ({
            botId: bot.id,
            category: bot.category,
            kind: bot.kind,
            model,
            needs,
            stepId,
            destination,
          })),
        };
        return {
          prepared,
          binding: createHash("sha256").update(JSON.stringify(binding)).digest("hex"),
        };
      } catch (error) {
        signal.throwIfAborted();
        const failure = managerFailure(ctx, context.language, error, action);
        return {
          refusal: failure.details?.errorCode ?? "pi_internal",
          refusalText: failure.text,
        };
      }
    },
  };
}
