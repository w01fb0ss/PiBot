import type { ModelPreference } from "@pibot/protocol";
import {
  botPanelStyles as styles,
  useComboboxText,
  useNavigation,
  useT,
} from "@pibot/renderer-kit";
import { Button, Combobox, type ComboboxOption, Icon, IconTile } from "@pibot/ui";
import type { useVideoCatalog } from "./video-catalog.ts";

const key = ({ provider, id }: ModelPreference) => JSON.stringify([provider, id]);

export function VideoModelFields({
  catalog,
  value,
  change,
  disabled,
  row = false,
}: {
  catalog: ReturnType<typeof useVideoCatalog>;
  value?: ModelPreference | null;
  change(value: ModelPreference | null): void;
  disabled: boolean;
  row?: boolean;
}) {
  const t = useT();
  const text = useComboboxText();
  const { openSettings } = useNavigation();
  const { models, loading, error, reload } = catalog;
  const options: ComboboxOption[] = [
    { value: "", label: t("video.automatic") },
    ...models.map((model) => {
      const label = `${model.providerName} · ${model.id}`;
      return { value: key(model), label, title: label };
    }),
  ];
  const selected = value ? key(value) : "";
  if (value && !options.some((option) => option.value === selected))
    options.push({
      value: selected,
      label: loading || error ? value.id : t("workspace.modelUnavailable", { model: value.id }),
      title: value.id,
      disabled: true,
    });
  const label = t("video.model");
  const picker = (
    <Combobox
      {...text}
      variant={row ? "pill" : "field"}
      hideLabel={row}
      label={label}
      placeholder={t("models.selectModel")}
      value={selected}
      disabled={disabled || loading || error || (!value && !models.length)}
      options={options}
      onValueChange={(value) => {
        if (!value) {
          change(null);
          return;
        }
        const model = models.find((model) => key(model) === value);
        if (model) change({ provider: model.provider, id: model.id });
      }}
    />
  );
  return (
    <>
      {row ? (
        <div className={styles.row}>
          <IconTile icon="camera" tone="violet" size="lg" />
          <span className={styles.rowLabel}>{label}</span>
          {picker}
        </div>
      ) : (
        picker
      )}
      {!models.length && !loading && !error && (
        <p className={styles.note}>
          {t("video.noModels")}{" "}
          <button type="button" className={styles.link} onClick={() => openSettings("models")}>
            {t("settings.models")} <Icon name="arrow" size={13} />
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
    </>
  );
}
