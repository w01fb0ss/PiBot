import { useNavigation, useT } from "@pibot/renderer-kit";
import { Avatar, Button, Icon, IconTile } from "@pibot/ui";
import { type RefObject, useState } from "react";
import { ImageModelFields } from "../profile/ImageModelFields.tsx";
import { ModelFields } from "../profile/ModelFields.tsx";
import { VideoModelFields } from "../profile/VideoModelFields.tsx";
import styles from "./new-chat.module.css";
import type { NewBotState } from "./use-new-bot.ts";

export function CustomBotCreate({
  state,
  id,
  description,
}: {
  state: NewBotState;
  id: string;
  description: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const { openWorkspace } = useNavigation();
  const [personaOpen, setPersonaOpen] = useState(() => Boolean(state.persona || state.norms));
  const videoField = (
    <VideoModelFields
      catalog={state.videos}
      value={state.videoChoice}
      change={(value) => state.setVideoChoice(value ?? undefined)}
      disabled={state.task.busy}
    />
  );

  return (
    <form
      id={id}
      className={styles.createForm}
      aria-label={t("workspace.create")}
      onSubmit={(event) => {
        event.preventDefault();
        state.createBot();
      }}
    >
      {/* The way back to the role list leads the card, like the role detail. */}
      <div>
        <Button
          variant="pill"
          className={styles.backPill}
          disabled={state.task.busy}
          onClick={() => state.setRole(undefined)}
        >
          <Icon name="chevronRight" size={14} className={styles.backIcon} />
          {t("builtin.role.back")}
        </Button>
      </div>
      <div className={styles.creationHeading}>
        <div className={styles.avatarPreview}>
          <Avatar
            shape={state.appearance.avatarShape}
            color={state.appearance.avatarColor}
            size={56}
            label={t("workspace.create")}
          />
          <Button
            variant="pill"
            className={styles.reroll}
            disabled={state.task.busy}
            onClick={state.reroll}
          >
            {t("workspace.rerollAvatar")}
          </Button>
        </div>
        <div>
          <h1 className={styles.heading}>{t("builtin.custom.title")}</h1>
          <p className={styles.hint}>{t("builtin.custom.hint")}</p>
        </div>
        <Button
          variant="pill"
          className={styles.importAction}
          title={t("builtin.custom.importHint")}
          disabled={state.task.busy}
          onClick={() => openWorkspace({ name: "team" })}
        >
          {t("builtin.custom.import")}
        </Button>
      </div>
      <section className={styles.formCard}>
        <h2 className={styles.cardTitle}>{t("media.category")}</h2>
        <p className={styles.hint}>{t("media.categoryFixed")}</p>
        <fieldset
          className={styles.choices}
          aria-label={t("media.category")}
          disabled={state.task.busy}
        >
          {(["chat", "image"] as const).map((value) => (
            <label className={styles.choice} key={value}>
              <input
                type="radio"
                name={`${id}-category`}
                checked={state.category === value}
                onChange={() => state.setCategory(value)}
              />
              <IconTile icon={value === "chat" ? "message" : "image"} tone="violet" />
              {t(`media.category.${value}`)}
            </label>
          ))}
        </fieldset>
      </section>
      <section className={styles.formCard}>
        <h2 className={styles.cardTitle}>{t("workspace.description")}</h2>
        <label htmlFor={`${id}-job`} className={styles.fieldLabel}>
          {t("workspace.description")} *
        </label>
        <textarea
          ref={description}
          id={`${id}-job`}
          className={styles.description}
          required
          rows={3}
          maxLength={4000}
          value={state.description}
          disabled={state.task.busy}
          placeholder={t("workspace.jobExample")}
          onChange={(event) => state.setDescription(event.currentTarget.value)}
        />
        <label htmlFor={`${id}-name`} className={styles.fieldLabel}>
          {t("builtin.custom.name")}
        </label>
        <input
          id={`${id}-name`}
          className={styles.description}
          maxLength={200}
          value={state.name}
          disabled={state.task.busy}
          placeholder={t("builtin.custom.nameHint")}
          aria-invalid={state.task.error === "builtin.custom.nameTaken" || undefined}
          onChange={(event) => state.setName(event.currentTarget.value)}
        />
      </section>
      {state.category === "chat" ? (
        <details
          className={styles.formCard}
          open={personaOpen}
          onToggle={(event) => setPersonaOpen(event.currentTarget.open)}
        >
          <summary className={styles.cardTitle}>{t("workspace.personaNorms")}</summary>
          <label htmlFor={`${id}-persona`} className={styles.fieldLabel}>
            {t("workspace.persona")}
          </label>
          <textarea
            id={`${id}-persona`}
            className={styles.description}
            rows={4}
            maxLength={100000}
            value={state.persona}
            disabled={state.task.busy}
            placeholder={t("builtin.custom.personaHint")}
            onChange={(event) => state.setPersona(event.currentTarget.value)}
          />
          <label htmlFor={`${id}-norms`} className={styles.fieldLabel}>
            {t("builtin.profile.norms")}
          </label>
          <textarea
            id={`${id}-norms`}
            className={styles.description}
            rows={4}
            maxLength={20000}
            value={state.norms}
            disabled={state.task.busy}
            placeholder={t("builtin.custom.normsHint")}
            onChange={(event) => state.setNorms(event.currentTarget.value)}
          />
        </details>
      ) : (
        <p className={styles.hint}>{t("builtin.custom.imageHint")}</p>
      )}
      <section className={styles.formCard}>
        <h2 className={styles.cardTitle}>{t("workspace.model")}</h2>
        {state.category === "image" ? (
          <ImageModelFields
            models={state.images.models}
            providers={state.catalog.providers}
            value={state.imageChoice}
            change={state.setImageChoice}
            disabled={state.task.busy || state.images.loading || state.images.error}
            uncertain={state.images.loading || state.images.error}
            hasMore={state.images.hasMore}
            more={state.images.more}
          >
            {videoField}
          </ImageModelFields>
        ) : (
          <>
            <ModelFields
              {...state.catalog}
              creation
              value={state.value}
              thinking={state.thinking}
              disabled={state.task.busy || state.catalog.loading}
              change={state.changeModel}
            />
            {videoField}
          </>
        )}
        {state.category === "image" && state.images.error && (
          <p role="alert" className={styles.error}>
            {t("workspace.failed")}{" "}
            <Button variant="ghost" onClick={state.images.reload}>
              {t("common.retry")}
            </Button>
          </p>
        )}
      </section>
    </form>
  );
}
