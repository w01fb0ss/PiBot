import { type Bot, canonicalImageModelId } from "@pibot/protocol";
import {
  botPanelStyles as styles,
  useComboboxText,
  useModelOptions,
  useNavigation,
  useT,
} from "@pibot/renderer-kit";
import { BuiltinNorms, BuiltinUpdate, RoleLine } from "@pibot/teams/ui";
import { Button, Combobox, Icon, IconTile, SegmentedControl } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { ProfileAutoCheck } from "../../autocheck/ProfileAutoCheck.tsx";
import { UsedFolders } from "../../folders/UsedFolders.tsx";
import { ProfileHooks } from "../../hooks/ProfileHooks.tsx";
import { InlineBotField } from "../new-chat/InlineBotField.tsx";
import type { useCatalog } from "./catalog.ts";
import { ImageModelFields } from "./ImageModelFields.tsx";
import { useImageCatalog } from "./image-catalog.ts";
import { ProfileReview } from "./ProfileReview.tsx";
import type { BotUpdate } from "./use-bot-editor.ts";
import { useModelLocation } from "./use-model-location.ts";
import { VideoModelFields } from "./VideoModelFields.tsx";
import { useVideoCatalog } from "./video-catalog.ts";

/** Bot panel「资料」: model, role, persona & norms (collapsed), used folders. */
export function ProfileDetails({
  bot,
  save,
  busy,
  catalog,
}: {
  bot: Bot;
  save(patch: BotUpdate): Promise<boolean>;
  busy: boolean;
  catalog: ReturnType<typeof useCatalog>;
}) {
  const t = useT();
  const location = useModelLocation(bot.modelProvider, catalog.providers);
  const { openSettings } = useNavigation();
  const [advanced, setAdvanced] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [imageSaveError, setImageSaveError] = useState(false);
  const [pendingImageModel, setPendingImageModel] = useState<string>();
  const imageSaveVersion = useRef(0);
  const imageSaving = useRef(false);
  const images = useImageCatalog(
    undefined,
    bot.category === "image",
    bot.modelProvider && bot.modelId ? { provider: bot.modelProvider, id: bot.modelId } : undefined,
  );
  const videos = useVideoCatalog();
  const videoField = (
    <VideoModelFields
      catalog={videos}
      value={bot.defaultVideoModel}
      disabled={busy}
      change={(defaultVideoModel) => void save({ defaultVideoModel })}
      row
    />
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Confirmed model or Bot identity replaces tentative picker state.
  useEffect(() => {
    imageSaveVersion.current++;
    imageSaving.current = false;
    setPendingImageModel(undefined);
    setImageError(false);
    setImageSaveError(false);
    return () => {
      imageSaveVersion.current++;
    };
  }, [bot.id, bot.modelProvider, bot.modelId]);
  const text = useComboboxText();
  const availableOptions = useModelOptions(catalog.models, catalog.providers, true);
  const selectedValue =
    bot.modelProvider && bot.modelId
      ? JSON.stringify([
          bot.modelProvider,
          bot.category === "image"
            ? canonicalImageModelId(bot.modelProvider, bot.modelId)
            : bot.modelId,
        ])
      : "";
  const imageSelectedValue = pendingImageModel ?? selectedValue;
  async function saveImageSelection(value: string) {
    if (imageSaving.current) return;
    const next = images.models.find(
      (model) => JSON.stringify([model.provider, model.id]) === value,
    );
    if (!next) {
      setImageError(true);
      return;
    }
    const version = imageSaveVersion.current;
    imageSaving.current = true;
    setPendingImageModel(value);
    setImageError(false);
    setImageSaveError(false);
    let saved = false;
    try {
      saved = await save({
        modelProvider: next.provider,
        modelId: next.id,
        thinkingLevel: "off",
      });
    } catch {
      // Keep the tentative pair when the editor cannot confirm the RPC result.
    } finally {
      if (version === imageSaveVersion.current) imageSaving.current = false;
    }
    if (version !== imageSaveVersion.current) return;
    if (saved) {
      setPendingImageModel(undefined);
    } else setImageSaveError(true);
  }
  const options =
    selectedValue && !availableOptions.some((option) => option.value === selectedValue)
      ? [
          {
            value: selectedValue,
            label: t("workspace.modelUnavailable", { model: bot.modelId ?? "" }),
            disabled: true,
          },
          ...availableOptions,
        ]
      : availableOptions;
  const model = catalog.models.find(
    (model) => model.provider === bot.modelProvider && model.id === bot.modelId,
  );
  const levels: readonly Bot["thinkingLevel"][] = model?.reasoning
    ? (model.thinkingLevels ?? (["off", "low", "medium", "high"] as const))
    : (["off"] as const);
  const settingsLink = (
    <button type="button" className={styles.link} onClick={() => openSettings("models")}>
      {t("settings.models")} <Icon name="arrow" size={13} />
    </button>
  );
  return (
    <div className={styles.stack}>
      {bot.category === "image" ? (
        <section className={styles.modelRows}>
          <p className={styles.note}>
            {t("media.category.image")} · {t("media.categoryFixed")}
          </p>
          <ImageModelFields
            models={images.models}
            providers={catalog.providers}
            value={imageSelectedValue}
            selectedLabel={bot.modelId ?? undefined}
            uncertain={images.loading || images.error}
            disabled={busy || images.loading || images.error}
            hasMore={images.hasMore}
            more={images.more}
            settingsLink={false}
            row
            change={(value) => {
              void saveImageSelection(value);
            }}
          >
            {videoField}
          </ImageModelFields>
          {settingsLink}
          {imageError && (
            <p role="alert" className={styles.error}>
              {t("media.modeMismatch")}
            </p>
          )}
          {imageSaveError && (
            <p role="alert" className={styles.error}>
              {t("workspace.failed")}{" "}
              <Button
                variant="ghost"
                disabled={busy || images.loading || images.error}
                onClick={() => void saveImageSelection(imageSelectedValue)}
              >
                {t("common.retry")}
              </Button>
            </p>
          )}
          {images.error && (
            <p role="alert" className={styles.error}>
              {t("workspace.failed")}{" "}
              <Button variant="ghost" onClick={images.reload}>
                {t("common.retry")}
              </Button>
            </p>
          )}
        </section>
      ) : (
        <section className={styles.modelRows}>
          <p className={styles.note}>
            {t(
              location.local === true
                ? "agentWork.local"
                : location.local === false
                  ? "agentWork.remote"
                  : "agentWork.locationUnknown",
            )}
          </p>
          <div className={styles.row}>
            <IconTile icon="key" tone="violet" size="lg" />
            <span className={styles.rowLabel}>{t("workspace.model")}</span>
            <Combobox
              {...text}
              variant="pill"
              hideLabel
              label={t("workspace.model")}
              placeholder={t("models.selectModel")}
              options={options}
              value={selectedValue}
              disabled={busy || catalog.loading || !availableOptions.length}
              onValueChange={(value) => {
                const next = catalog.models.find(
                  (model) => JSON.stringify([model.provider, model.id]) === value,
                );
                if (next)
                  void save({
                    modelProvider: next.provider,
                    modelId: next.id,
                  });
              }}
            />
          </div>
          {videoField}
          <div className={styles.row}>
            <IconTile icon="bolt" tone="amber" size="lg" />
            <span className={styles.rowLabel}>{t("workspace.thinking")}</span>
            {/* The levels are a short fixed list (off / low / medium / high at most). */}
            <SegmentedControl<Bot["thinkingLevel"]>
              label={t("workspace.thinking")}
              className={styles.segSmall}
              options={levels.map((value) => ({ value, label: t(`models.thinking.${value}`) }))}
              value={levels.includes(bot.thinkingLevel) ? bot.thinkingLevel : (levels[0] ?? "off")}
              disabled={busy || !model?.reasoning}
              onValueChange={(value) => void save({ thinkingLevel: value })}
            />
          </div>
          {!catalog.models.length && <p className={styles.note}>{t("models.noConfigured")}</p>}
          {settingsLink}
          {catalog.error && (
            <p className={styles.error} role="alert">
              {t("workspace.failed")}{" "}
              <Button variant="pill" onClick={catalog.reload}>
                {t("common.retry")}
              </Button>
            </p>
          )}
        </section>
      )}
      {bot.role && <RoleLine role={bot.role} />}
      {/* Offered only while the role has a newer built-in version. */}
      {bot.role && !bot.isMain && <BuiltinUpdate target={{ botId: bot.id }} disabled={busy} />}
      <ProfileAutoCheck key={bot.id} bot={bot} />
      <ProfileReview key={`review:${bot.id}`} bot={bot} save={save} busy={busy} />
      <ProfileHooks key={`hooks:${bot.id}`} bot={bot} />
      {bot.category !== "image" && (
        <section className={styles.foldCard} data-open={advanced || undefined}>
          <button
            type="button"
            className={styles.foldHead}
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
          >
            <IconTile icon="user" tone="pink" size="lg" />
            <span className={styles.rowText}>
              <strong>{t("panel.persona")}</strong>
              <small>{t("panel.personaSummary")}</small>
            </span>
            <Icon name="chevronRight" size={16} className={styles.foldChevron} />
          </button>
          {advanced && (
            <div className={styles.foldBody}>
              <span className={styles.note}>{t("workspace.persona")}</span>
              <InlineBotField
                multiline
                className={styles.persona}
                label={t("workspace.persona")}
                value={bot.systemPrompt}
                maxLength={100000}
                disabled={busy}
                save={(systemPrompt) => save({ systemPrompt })}
              />
              {!bot.systemPrompt.trim() && (
                <p className={styles.note}>{t("workspace.emptyPersona")}</p>
              )}
              {/* Norms are kept and edited apart from the persona; they follow it. */}
              <span className={styles.note}>{t("builtin.profile.norms")}</span>
              <InlineBotField
                multiline
                className={styles.persona}
                label={t("builtin.profile.norms")}
                value={bot.norms ?? ""}
                maxLength={20000}
                disabled={busy}
                save={(norms) => save({ norms })}
              />
              <span className={styles.note}>{t("builtin.profile.normsHint")}</span>
              {bot.role && <BuiltinNorms key={bot.id} bot={bot} save={save} busy={busy} />}
            </div>
          )}
        </section>
      )}
      {/* Folders are chosen per conversation; the Bot only lists what it has used. */}
      <UsedFolders botId={bot.id} />
    </div>
  );
}
