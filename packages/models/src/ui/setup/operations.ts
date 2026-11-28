import {
  type CustomProvider,
  CustomProviderSchema,
  type Provider,
  providerPlan,
  RpcErrorCodes,
  SafeSecretSchema,
  validImageModelOptions,
} from "@pibot/models-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { normalizedThinking, SetupError } from "@pibot/renderer-kit";

export const providerIdentity = (provider: Pick<Provider, "id" | "auth">) =>
  JSON.stringify([provider.id, provider.auth]);

export async function writeCredential<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Error && error.message === "claude_subscription_unsupported")
      throw new SetupError("errors.claude_subscription_unsupported");
    if (
      error instanceof Error &&
      (error.message === "subscription_unsupported" ||
        error.message === "openai_approval_required" ||
        error.message === "chatgpt_reconnect_required")
    )
      throw new SetupError(`errors.${error.message}`);
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === RpcErrorCodes.secretsUnavailable
    ) {
      const temporary = [
        "secure_storage_session_pending",
        "secure_storage_timeout",
        "secure_storage_busy",
        "secure_storage_closed",
      ].includes(error.message);
      throw new SetupError(temporary ? "models.secretStoreTemporary" : "models.noSecretStore");
    }
    throw error;
  }
}

export async function saveKey(peer: Peer, providerId: string, apiKey: string) {
  if (!SafeSecretSchema.safeParse(apiKey).success) throw new SetupError("models.keyInvalid");
  await writeCredential(() => peer.call("providers.setApiKey", { providerId, apiKey }));
}

export async function testProvider(peer: Peer, providerId: string, modelId?: string) {
  const result = await peer.call("providers.test", { providerId, modelId });
  if (!result.ok && result.keyPlanMismatch) {
    const plan = providerPlan(providerId);
    if (plan)
      throw new SetupError(
        providerId.startsWith("qwen-")
          ? "models.planMismatch.qwen"
          : providerId.startsWith("xiaomi-")
            ? "models.planMismatch.xiaomi"
            : providerId === "kimi-coding"
              ? "models.planMismatch.kimi"
              : "models.planMismatch.zai",
      );
  }
  if (!result.ok) throw new SetupError(`errors.${result.error ?? "internal"}`);
  return result;
}

export async function choosePiModel(
  peer: Peer,
  provider: string,
  modelId?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const [bots, models] = await Promise.all([
    peer.call("bots.list", undefined, { signal }),
    peer.call("models.list", { availableOnly: true }, { signal }),
  ]);
  const pi = bots.find((bot) => bot.isMain);
  const model = models.find(
    (item) => item.provider === provider && (!modelId || item.id === modelId),
  );
  if (!pi || !model?.input.includes("text")) throw new SetupError("setup.noModels");
  signal?.throwIfAborted();
  await peer.call(
    "settings.set",
    {
      defaultModel: {
        provider: model.provider,
        id: model.id,
        thinkingPreference:
          pi.thinkingPreference === undefined ? pi.thinkingLevel : pi.thinkingPreference,
        thinkingLevel: normalizedThinking(
          model,
          pi.thinkingPreference === undefined ? pi.thinkingLevel : pi.thinkingPreference,
        ),
      },
      initializeMainBot: true,
    },
    { signal },
  );
}

export async function configureOllama(
  peer: Peer,
  baseUrl: string,
  modelId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  await peer.call(
    "customProviders.upsert",
    {
      id: "ollama",
      name: "Ollama",
      baseUrl,
      api: "openai-completions",
      compat: { supportsDeveloperRole: false },
      models: [{ id: modelId }],
    },
    { signal },
  );
}

export async function registerOllama(peer: Peer, baseUrl: string, modelId: string) {
  await configureOllama(peer, baseUrl, modelId);
  await choosePiModel(peer, "ollama", modelId);
}

export function validateCustom(input: unknown): CustomProvider {
  const parsed = CustomProviderSchema.safeParse(input);
  if (!parsed.success) throw new SetupError("models.custom.invalid");
  const config = parsed.data;
  if (
    (!config.models.length &&
      (!config.imageApi || !config.imageModels?.length) &&
      (!config.videoApi || !config.videoModels?.length)) ||
    (config.videoModels?.length && !config.videoApi) ||
    (config.imageModels?.length && !config.imageApi)
  )
    throw new SetupError("models.custom.invalid");
  const imageIds = (config.imageModels ?? []).map((model) => model.id);
  if (config.imageModels?.some((model) => !validImageModelOptions(config.imageApi, model)))
    throw new SetupError(
      config.imageApi === "comfyui-images" ? "media.invalidWorkflow" : "models.custom.invalid",
    );
  const textIds = new Set(config.models.map((model) => model.id));
  if (imageIds.some((id) => textIds.has(id))) throw new SetupError("media.duplicateModelId");
  if (new Set(imageIds).size !== imageIds.length) throw new SetupError("models.custom.invalid");
  const videoIds = (config.videoModels ?? []).map((model) => model.id);
  if (
    new Set(videoIds).size !== videoIds.length ||
    videoIds.some((id) => textIds.has(id) || imageIds.includes(id))
  )
    throw new SetupError("media.duplicateModelId");
  const url = new URL(config.baseUrl);
  if (
    url.username ||
    url.password ||
    ((config.videoApi || config.imageApi) && (url.search || url.hash)) ||
    [...url.searchParams.keys()].some((name) => /key|token|secret|password|auth/i.test(name))
  )
    throw new SetupError("models.custom.invalid");
  const names = Object.keys(config.headers ?? {});
  if (
    names.some((name) => !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name)) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    throw new SetupError("models.custom.invalid");
  if (new Set(config.models.map((model) => model.id)).size !== config.models.length)
    throw new SetupError("models.custom.invalid");
  return parsed.data;
}

export { requirePeer, SetupError } from "@pibot/renderer-kit";
