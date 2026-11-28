import type { ImageModelInfo, Provider } from "@pibot/protocol";
import {
  botPanelStyles as panelStyles,
  useComboboxText,
  useNavigation,
  useT,
} from "@pibot/renderer-kit";
import { Button, Combobox, type ComboboxOption, IconTile } from "@pibot/ui";
import type { ReactNode } from "react";
import styles from "../workspace.module.css";

export function ImageModelFields({
  models,
  providers,
  value,
  disabled,
  change,
  hasMore,
  more,
  selectedLabel,
  uncertain = false,
  settingsLink = true,
  row = false,
  children,
}: {
  /** The Bot panel draws the picker as a tiled row with a pill, like a text Bot's model. */
  row?: boolean;
  /** The Bot panel shows its own small「模型与密钥 →」link instead. */
  settingsLink?: boolean;
  models: ImageModelInfo[];
  providers: Provider[];
  value: string;
  disabled: boolean;
  change(value: string): void;
  hasMore?: boolean;
  more?(): void;
  selectedLabel?: string;
  uncertain?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const text = useComboboxText();
  const { openSettings } = useNavigation();
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  const eligible = models;
  const options: ComboboxOption[] = eligible.map((model) => ({
    value: JSON.stringify([model.provider, model.id]),
    label: model.name,
    keywords: [model.id, model.provider],
    group: names.get(model.provider) ?? model.provider,
    secondary: model.experimental
      ? t("media.experimental")
      : model.modes.map((mode) => t(`media.mode.${mode}`)).join(" / "),
  }));
  if (value && selectedLabel && !options.some((option) => option.value === value))
    options.unshift({
      value,
      label: uncertain ? selectedLabel : t("workspace.modelUnavailable", { model: selectedLabel }),
      disabled: true,
    });
  const picker = (
    <Combobox
      {...text}
      variant={row ? "pill" : "field"}
      hideLabel={row}
      label={t("media.model")}
      placeholder={t("models.selectModel")}
      value={value}
      disabled={disabled || !eligible.length}
      options={options}
      onValueChange={change}
    />
  );
  if (row)
    return (
      <>
        <div className={panelStyles.row}>
          <IconTile icon="image" tone="pink" size="lg" />
          <span className={panelStyles.rowLabel}>{t("media.model")}</span>
          {picker}
        </div>
        {children}
        <p className={panelStyles.note}>{t("media.autoMode")}</p>
        {!eligible.length && !uncertain && (
          <p className={panelStyles.note}>{t("media.noModels")}</p>
        )}
        <p className={panelStyles.note}>{t("media.defaults")}</p>
        {hasMore && (
          <Button
            variant="pill"
            className={panelStyles.smallPill}
            disabled={disabled}
            onClick={more}
          >
            {t("workspace.more")}
          </Button>
        )}
      </>
    );
  return (
    <div className={styles.grid}>
      <p className={styles.note}>{t("media.autoMode")}</p>
      {picker}
      {children}
      {!eligible.length && !uncertain && <p className={styles.note}>{t("media.noModels")}</p>}
      <p className={styles.note}>{t("media.defaults")}</p>
      {hasMore && (
        <Button variant="ghost" disabled={disabled} onClick={more}>
          {t("workspace.more")}
        </Button>
      )}
      {settingsLink && (
        <Button variant="ghost" disabled={disabled} onClick={() => openSettings("models")}>
          {t("settings.models")}
        </Button>
      )}
    </div>
  );
}
