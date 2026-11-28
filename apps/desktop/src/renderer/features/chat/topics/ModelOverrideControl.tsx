import { type ChatPeer, chatReadCache } from "@pibot/client-core";
import {
  canonicalImageModelId,
  type ImageModelInfo,
  type ModelInfo,
  type ModelOverride,
  RpcError,
} from "@pibot/protocol";
import { modelDisplayName, useComboboxText, useT } from "@pibot/renderer-kit";
import { Combobox } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../chat.module.css";

type CatalogModel = ModelInfo | ImageModelInfo;
const EMPTY_MODELS: CatalogModel[] = [];
const key = ({ provider, id }: ModelOverride) => JSON.stringify([provider, id]);
const DEFAULT = "default";

export function useOverrideModels(peer: ChatPeer, category: "chat" | "image" | undefined) {
  const [models, setModels] = useState<CatalogModel[]>(EMPTY_MODELS);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!category) return;
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const cache = chatReadCache(peer);
      const result =
        category === "image"
          ? cache.read(
              "images:available",
              (read) =>
                peer.call("models.images", { availableOnly: true, limit: 200 }, { signal: read }),
              signal,
            )
          : cache.read(
              "models:available",
              (read) => peer.call("models.list", { availableOnly: true }, { signal: read }),
              signal,
            );
      void result.then(
        (rows) => {
          if (signal.aborted) return;
          setFailed(false);
          setModels(rows);
        },
        () => {
          if (!signal.aborted) setFailed(true);
        },
      );
    };
    refresh();
    const off = peer.on("providers.changed", refresh);
    return () => {
      controller?.abort();
      off();
    };
  }, [peer, category]);
  return { models, failed };
}

export function findOverrideModel<T extends CatalogModel>(
  models: readonly T[],
  override: ModelOverride | undefined,
) {
  if (!override) return undefined;
  return models.find(
    (model) =>
      model.provider === override.provider &&
      model.id ===
        ("modes" in model ? canonicalImageModelId(model.provider, override.id) : override.id),
  );
}

export function ModelOverrideControl({
  peer,
  kind,
  category,
  override,
  catalog,
  disabled,
  save,
}: {
  peer: ChatPeer;
  kind: "topic" | "task";
  category: "chat" | "image";
  override?: ModelOverride;
  catalog?: readonly CatalogModel[];
  disabled?: boolean;
  save(override: ModelOverride | null): Promise<unknown>;
}) {
  const t = useT();
  const text = useComboboxText();
  const remote = useOverrideModels(peer, catalog ? undefined : category);
  const models = catalog ?? remote.models;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"failed" | "vision" | "external" | "unavailable">();
  const selected = findOverrideModel(models, override);
  const value = selected ? key(selected) : override ? key(override) : "";
  const title = t(kind === "topic" ? "chat.topicModel.select" : "chat.taskModel.select");
  const modelLabel = (name: string) =>
    t(kind === "topic" ? "chat.topicModel.current" : "chat.taskModel.current", {
      model: modelDisplayName(name),
    });
  const options = [
    ...(override
      ? [
          {
            value: DEFAULT,
            label: t(kind === "topic" ? "chat.topicModel.restore" : "chat.taskModel.clear"),
          },
        ]
      : []),
    ...(override && !selected ? [{ value, label: modelLabel(override.id) }] : []),
    ...models.map((model) => ({
      value: key(model),
      label: model === selected ? modelLabel(model.name) : modelDisplayName(model.name),
      secondary: model.provider,
      keywords: [model.id, model.provider],
    })),
  ];
  const change = async (next: string) => {
    if (next === value || pending) return;
    const model = models.find((item) => key(item) === next);
    if (!model && next !== DEFAULT) return;
    setPending(true);
    setError(undefined);
    try {
      await save(model ? { provider: model.provider, id: model.id } : null);
    } catch (failure) {
      const reason = failure instanceof RpcError ? failure.message : "";
      setError(
        reason === "model_override_image_input_required"
          ? "vision"
          : reason === "model_override_external_agent"
            ? "external"
            : reason === "model_override_unavailable"
              ? "unavailable"
              : "failed",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className={styles.modelOverride}>
      <Combobox
        {...text}
        variant={kind === "topic" ? "subtitle" : "badge"}
        hideLabel
        label={title}
        placeholder={kind === "topic" ? t("chat.topicModel.default") : title}
        triggerLabel={
          kind === "topic" && override ? modelDisplayName(selected?.name ?? override.id) : undefined
        }
        options={options}
        value={value}
        disabled={disabled || pending}
        onValueChange={(next) => void change(next)}
      />
      {(error || remote.failed) && (
        <span className={styles.modelOverrideError} role="alert">
          {t(`chat.topicModel.${error ?? "unavailable"}`)}
        </span>
      )}
    </div>
  );
}
