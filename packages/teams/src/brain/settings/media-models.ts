import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import { createTranslator } from "@pibot/i18n";
import type { ModelPreference } from "@pibot/protocol";

export async function readMediaModels(
  ctx: CapabilityContext,
  context: ToolRunContext,
  kind: "video" | "image",
  selected: ModelPreference | undefined,
  offset: number,
  signal: AbortSignal,
) {
  const t = createTranslator(context.language);
  const text = (value: unknown) => ctx.redactor.redact(JSON.stringify(value));
  const disabled = kind === "video" ? (ctx.local.models?.videoModelsToEnable?.() ?? []) : [];
  const available =
    kind === "video"
      ? (ctx.local.models?.videoProviders() ?? []).flatMap(({ id, name, videoModels }) =>
          videoModels.map(({ id: model, timeoutMinutes: _timeout, ...prices }) => ({
            provider: id,
            providerName: name,
            id: model,
            enabled: true,
            ...prices,
          })),
        )
      : (
          (await ctx.agent.listImageModels?.({
            availableOnly: true,
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          })) ?? []
        )
          .filter(({ configured }) => configured)
          .map(({ provider, id, name, modes, generationPrice, editPrice }) => ({
            provider,
            id,
            name,
            modes,
            generationPrice,
            editPrice,
          }));
  signal.throwIfAborted();
  if (kind === "video" && selected && (available.length || disabled.length)) {
    const matches = (model: ModelPreference) =>
      model.provider === selected.provider && model.id === selected.id;
    const enabled = available.find(matches);
    if (enabled) return { text: text({ models: [enabled] }) };
    const action = disabled.find(({ providerId, model }) =>
      matches({ provider: providerId, id: model.id }),
    );
    if (action)
      return {
        text: text({
          models: [{ provider: action.providerId, ...action.model, enabled: false }],
          message: t("policy.reason.video_enable_needed"),
        }),
        details: { settingsAction: action },
      };
    return { text: t("policy.reason.video_model_unavailable"), isError: true };
  }
  const models = [
    ...available,
    ...disabled.map(({ providerId, model }) => ({
      provider: providerId,
      ...model,
      enabled: false,
    })),
  ];
  if (models.length) {
    const limit = 100;
    return {
      text: text({
        models: models.slice(offset, offset + limit),
        ...(offset + limit < models.length ? { nextOffset: offset + limit } : {}),
      }),
    };
  }
  return {
    text: t(kind === "video" ? "video.catalogSetup" : "piSettings.imageCatalogSetup"),
    details: { settingsAction: { kind: "open_settings" as const, page: "models" as const } },
  };
}
