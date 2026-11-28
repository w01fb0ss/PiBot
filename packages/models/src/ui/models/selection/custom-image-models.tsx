import {
  COMFY_WORKFLOW_LIMIT,
  type CustomImageModel,
  comfyUsesImage,
  type ImageApi,
  ImageAspectRatioSchema,
  parseComfyWorkflow,
} from "@pibot/models-contract/full";
import { AppSelect, setupStyles as styles, useT } from "@pibot/renderer-kit";
import { Button, IconTile, TextField } from "@pibot/ui";
import { useRef, useState } from "react";
import detailStyles from "../providers/provider-detail.module.css";

export type ImageModelRow = CustomImageModel & { rowId: string };
export function CustomImageModels({
  api,
  models,
  change,
  commit,
}: {
  api: ImageApi;
  models: ImageModelRow[];
  change(models: ImageModelRow[]): void;
  commit(): void;
}) {
  const t = useT();
  const [importError, setImportError] = useState<string>();
  const workflowFile = useRef<HTMLInputElement>(null);
  const workflowRow = useRef<string | undefined>(undefined);
  const current = useRef({ models, change });
  current.current = { models, change };
  const comfy = api === "comfyui-images";
  const seedream = api === "seedream-images";
  const patch = (rowId: string, update: Partial<CustomImageModel>) =>
    change(models.map((model) => (model.rowId === rowId ? { ...model, ...update } : model)));
  async function importWorkflow(rowId: string, file: File) {
    setImportError(undefined);
    try {
      const source = file.size <= COMFY_WORKFLOW_LIMIT ? await file.text() : "";
      const graph = parseComfyWorkflow(source);
      if (!graph) {
        setImportError(rowId);
        return;
      }
      const { models, change } = current.current;
      if (!models.some((row) => row.rowId === rowId)) return;
      const name = file.name
        .replace(/\.json$/i, "")
        .trim()
        .slice(0, 200);
      change(
        models.map((row) =>
          row.rowId === rowId
            ? {
                ...row,
                id: row.id || name || crypto.randomUUID(),
                name: row.name || name || undefined,
                workflow: source,
                modes: [comfyUsesImage(graph) ? "image-to-image" : "text-to-image"],
              }
            : row,
        ),
      );
      commit();
    } catch {
      setImportError(rowId);
    }
  }
  return (
    <div className={styles.stack}>
      {/* Image models are their own card group inside the custom provider form. */}
      <strong className={detailStyles.groupHead}>
        <IconTile icon="image" tone="pink" size="sm" />
        {t("media.imageModels")}
      </strong>
      <p className={styles.note}>{t(comfy ? "media.comfyHint" : "media.imageModelsHint")}</p>
      {api === "xai-images" && <p className={styles.note}>{t("media.xaiEditHint")}</p>}
      {comfy && (
        <input
          ref={workflowFile}
          hidden
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            const rowId = workflowRow.current;
            event.currentTarget.value = "";
            workflowRow.current = undefined;
            if (file && rowId) void importWorkflow(rowId, file);
          }}
        />
      )}
      {models.map((model) => (
        <div className={detailStyles.imageModel} key={model.rowId}>
          <TextField
            required
            label={t(comfy ? "media.workflowId" : "media.modelId")}
            value={model.id}
            maxLength={200}
            onChange={(event) => patch(model.rowId, { id: event.currentTarget.value })}
          />
          <TextField
            label={t(comfy ? "media.workflowName" : "media.modelName")}
            value={model.name ?? ""}
            maxLength={200}
            onChange={(event) =>
              patch(model.rowId, { name: event.currentTarget.value || undefined })
            }
          />
          {(seedream || comfy) && (
            <TextField
              label={t(seedream ? "media.seedreamSize" : "media.comfySize")}
              value={model.size ?? ""}
              placeholder={seedream ? "2K" : "1024x1024"}
              maxLength={11}
              onChange={(event) =>
                patch(model.rowId, { size: event.currentTarget.value || undefined })
              }
            />
          )}
          {seedream && (
            <AppSelect
              label={t("media.aspectRatio")}
              value={model.aspectRatio ?? "auto"}
              change={(value) => {
                patch(model.rowId, {
                  aspectRatio: value === "auto" ? undefined : ImageAspectRatioSchema.parse(value),
                });
                commit();
              }}
              options={[
                { value: "auto", label: t("media.aspectAuto") },
                ...ImageAspectRatioSchema.options.map((value) => ({ value, label: value })),
              ]}
            />
          )}
          {comfy && (
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  workflowRow.current = model.rowId;
                  workflowFile.current?.click();
                }}
              >
                {t(model.workflow ? "media.replaceWorkflow" : "media.importWorkflow")}
              </Button>
              {model.workflow && model.modes[0] && (
                <span className={styles.note}>{t(`media.mode.${model.modes[0]}`)}</span>
              )}
              {importError === model.rowId && (
                <span role="alert" className={styles.error}>
                  {t("media.invalidWorkflow")}
                </span>
              )}
            </>
          )}
          {!comfy &&
            (["text-to-image", "image-to-image"] as const).map((mode) => (
              <label className={styles.check} key={mode}>
                <input
                  type="checkbox"
                  checked={model.modes.includes(mode)}
                  onChange={(event) =>
                    patch(model.rowId, {
                      modes: event.currentTarget.checked
                        ? [...model.modes, mode]
                        : model.modes.filter((value) => value !== mode),
                    })
                  }
                />
                {t(`media.mode.${mode}`)}
              </label>
            ))}
          <Button
            variant="ghost"
            onClick={() => change(models.filter((row) => row.rowId !== model.rowId))}
          >
            {t("common.delete")}
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        disabled={models.length >= 200}
        onClick={() =>
          change([...models, { rowId: crypto.randomUUID(), id: "", modes: ["text-to-image"] }])
        }
      >
        {t(comfy ? "media.addWorkflow" : "media.addImageModel")}
      </Button>
    </div>
  );
}
