import type { DatabaseSync } from "node:sqlite";
import type { MemoryDraftRequest } from "@pibot/agent";
import { isChatGPTPlanProvider, type MemoryModelFallback } from "@pibot/protocol-base";
import { SettingsRepo } from "@pibot/storage";

type Model = MemoryDraftRequest["model"];

function ref(model: Model | null | undefined): Model | undefined {
  return model ? { provider: model.provider, id: model.id } : undefined;
}

function sameProvider(a: string, b: string) {
  return a === b || (isChatGPTPlanProvider(a) && isChatGPTPlanProvider(b));
}

export function memoryModelRoute(db: DatabaseSync, _botId: string, previous?: MemoryModelFallback) {
  const { defaultModel, auxiliaryModel } = new SettingsRepo(db).get();
  // Owner 2026-11-26: memory upkeep uses the auxiliary model, else the default model; never the
  // acting Bot's or Pi's own model, so one setting decides where memory text goes.
  const auxiliary = ref(auxiliaryModel);
  const defaults = ref(defaultModel);
  const primary = auxiliary ?? defaults;
  if (!primary) return undefined;
  const effective = (model: Model) =>
    previous && sameProvider(model.provider, previous.from.provider) ? previous.to : model;
  // Keep later batches off the overloaded provider once this operation has switched.
  return {
    model: effective(primary),
    modelChoices: [auxiliary, defaults].filter((model) => !!model).map(effective),
    ...(!previous && {
      fallbackModels: [defaults].filter((model) => !!model),
    }),
    localModelChoices: [auxiliary, defaults].filter((model) => !!model).map(effective),
  };
}
