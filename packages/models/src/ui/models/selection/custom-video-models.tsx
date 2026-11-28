import type { CustomVideoModel } from "@pibot/models-contract/full";
import { AppSelect, setupStyles as styles, useT } from "@pibot/renderer-kit";
import { Button, IconTile, TextField } from "@pibot/ui";
import type { ReactNode } from "react";
import detailStyles from "../providers/provider-detail.module.css";

export type VideoModelRow = CustomVideoModel & { rowId: string };

export function VideoModelsSection({
  children,
  fetchCatalog,
}: {
  children: ReactNode;
  fetchCatalog?: () => void;
}) {
  const t = useT();
  return (
    <section className={styles.stack} aria-label={t("video.models")}>
      <div className={detailStyles.formPair}>
        <strong className={detailStyles.groupHead}>
          <IconTile icon="play" tone="pink" size="sm" />
          {t("video.models")}
        </strong>
        {fetchCatalog && (
          <Button variant="secondary" onClick={fetchCatalog}>
            {t("models.custom.fetchModels")}
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

export function CustomVideoModels({
  models,
  catalog,
  fetchCatalog,
  change,
}: {
  models: VideoModelRow[];
  catalog: string[];
  fetchCatalog?: () => void;
  change(models: VideoModelRow[]): void;
}) {
  const t = useT();
  const patch = (id: string, update: Partial<CustomVideoModel>) =>
    change(models.map((model) => (model.rowId === id ? { ...model, ...update } : model)));
  const add = (id: string) => change([...models, { id, rowId: crypto.randomUUID() }]);
  return (
    <VideoModelsSection fetchCatalog={fetchCatalog}>
      <p className={styles.note}>{t("video.modelsHint")}</p>
      {!!catalog.length && (
        <AppSelect
          label={t("video.markModel")}
          value=""
          change={(value) => {
            if (value) add(value);
          }}
          options={[
            { value: "", label: t("video.selectCatalogModel") },
            ...catalog.map((id) => ({ value: id, label: id })),
          ]}
        />
      )}
      {models.map((model) => (
        <div className={detailStyles.imageModel} key={model.rowId}>
          <TextField
            required
            label={t("video.modelId")}
            value={model.id}
            maxLength={200}
            onChange={(event) => patch(model.rowId, { id: event.currentTarget.value })}
          />
          {(
            [
              ["priceUsdPerSecond", "video.pricePerSecond", 100, "any", 0],
              ["priceUsdPerClip", "video.pricePerClip", 3000, "any", 0],
              ["timeoutMinutes", "video.timeout", 120, 1, 15],
            ] as const
          ).map(([field, label, maximum, step, minimum]) => (
            <TextField
              key={field}
              label={t(label)}
              type="number"
              min={minimum}
              max={maximum}
              step={step}
              value={model[field] ?? ""}
              onChange={(event) =>
                patch(model.rowId, {
                  [field]:
                    event.currentTarget.value === ""
                      ? undefined
                      : event.currentTarget.valueAsNumber,
                  ...(field === "priceUsdPerClip"
                    ? { priceUsdPerSecond: undefined }
                    : field === "priceUsdPerSecond"
                      ? { priceUsdPerClip: undefined }
                      : {}),
                })
              }
            />
          ))}
          <Button
            variant="ghost"
            onClick={() => change(models.filter((row) => row.rowId !== model.rowId))}
          >
            {t("common.delete")}
          </Button>
        </div>
      ))}
      <Button variant="secondary" disabled={models.length >= 200} onClick={() => add("")}>
        {t("video.addModel")}
      </Button>
    </VideoModelsSection>
  );
}
