import { SettingsRow, SettingsSection, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Icon, Switch } from "@pibot/ui";
import { useState } from "react";
import styles from "./conversation-import.module.css";
import { DestinationChip } from "./DestinationMenus.tsx";
import { known, type Plan, type PlanMemory, type Preview } from "./import-state.ts";
import type { ImportDraft } from "./use-import-draft.ts";

export function formatQuoteCost(costUsd: number | null): string {
  if (costUsd === null) return "";
  if (costUsd > 0 && costUsd < 0.01) return "<$0.01";
  return `$${Number(costUsd.toPrecision(3))}`;
}

type Props = { draft: ImportDraft; disabled: boolean };

/** 偏好和习惯 and 做事方法: one row per memory with its own destination and switch. */
export function MemoryRows({ draft, plan, disabled }: Props & { plan: Plan }) {
  const t = useT();
  const groups = [
    {
      kind: "preference" as const,
      title: t("conversationImport.prefTitle"),
      hint: t("conversationImport.prefHint"),
    },
    {
      kind: "method" as const,
      title: t("conversationImport.methodTitle"),
      hint: t("conversationImport.methodHint"),
    },
  ];
  return (
    <>
      {groups.map(({ kind, title, hint }) => {
        const items = plan.memories.filter((memory) => memory.kind === kind);
        if (!items.length) return null;
        return (
          <SettingsSection
            key={kind}
            title={title}
            action={<span className={styles.hint}>{hint}</span>}
          >
            {items.map((memory) => (
              <MemoryRow key={memory.id} memory={memory} draft={draft} disabled={disabled} />
            ))}
          </SettingsSection>
        );
      })}
      {plan.omitted > 0 && (
        <p className={styles.meta}>{t("conversationImport.omitted", { count: plan.omitted })}</p>
      )}
    </>
  );
}

function MemoryRow({ memory, draft, disabled }: Props & { memory: PlanMemory }) {
  const t = useT();
  const target = draft.memoryTarget(memory);
  const entry = known(memory, target);
  const duplicate = entry?.outcome === "duplicate";
  const on = draft.memoryOn(memory);
  const note = duplicate
    ? t("conversationImport.alreadyKnown")
    : entry?.outcome === "conflict"
      ? t("conversationImport.conflict", { text: entry.existingText ?? "" })
      : undefined;
  return (
    <div className={styles.item} data-off={duplicate || !on || undefined}>
      <SettingsRow
        icon={memory.kind === "preference" ? "star" : "briefcase"}
        tone={duplicate ? "neutral" : memory.kind === "preference" ? "pink" : "violet"}
        label={
          <span className={styles.reviewText} dir="auto">
            {memory.text}
          </span>
        }
        note={note}
      >
        <DestinationChip
          value={target}
          bots={draft.bots}
          aboutYou
          label={t("conversationImport.memoryDestination")}
          disabled={disabled}
          onChange={(next) => draft.setMemory(memory.id, { target: next })}
        />
        <Switch
          label={t("conversationImport.includeMemory")}
          checked={on}
          disabled={disabled || duplicate}
          onCheckedChange={(value) => draft.setMemory(memory.id, { on: value })}
        />
      </SettingsRow>
    </div>
  );
}

/** Chats outside any project (project chats go with their project) and optional distillation. */
export function ChatRows({ draft, preview, disabled }: Props & { preview: Preview }) {
  const { t, language } = useSettings();
  const [quoteDetailsOpen, setQuoteDetailsOpen] = useState(false);
  const locale = language === "zh" ? "zh-CN" : "en";
  const projects = preview.projects ?? [];
  const projectChats = projects.reduce((sum, { topics }) => sum + topics, 0);
  const projectMessages = projects.reduce((sum, { messages }) => sum + messages, 0);
  const chats = preview.topics - projectChats;
  const messages = preview.messages - projectMessages;
  const messageNote = t("conversationImport.messageCount", { count: messages });
  const totalTokens = draft.quote ? draft.quote.inputTokens + draft.quote.outputTokens : 0;
  const formattedCost = draft.quote ? formatQuoteCost(draft.quote.costUsd) : "";
  return (
    <SettingsSection
      title={t("conversationImport.tab.chats")}
      action={<span className={styles.hint}>{t("conversationImport.chatsHint")}</span>}
    >
      {chats > 0 && (
        <div className={styles.item} data-off={!draft.conversations || undefined}>
          <SettingsRow
            icon="message"
            tone={draft.conversations ? "blue" : "neutral"}
            label={
              projectChats
                ? t("conversationImport.otherChats", { count: chats })
                : t("conversationImport.allChats", { count: chats })
            }
            note={
              projectChats
                ? `${messageNote} · ${t("conversationImport.projectChatsFollow", { count: projectChats })}`
                : messageNote
            }
          >
            <DestinationChip
              value={draft.botId}
              bots={draft.bots}
              label={t("conversationImport.chatsBot")}
              disabled={disabled}
              onChange={draft.changeBot}
            />
            <Switch
              label={t("conversationImport.includeChats")}
              checked={draft.conversations}
              disabled={disabled}
              onCheckedChange={draft.changeConversations}
            />
          </SettingsRow>
        </div>
      )}
      <div className={styles.item}>
        <SettingsRow
          icon="bulb"
          tone="teal"
          label={t("conversationImport.distil")}
          note={
            draft.quote
              ? draft.quote.local
                ? t("conversationImport.quoteLocal", { model: draft.quote.modelName })
                : t(
                    draft.quote.costUsd === null
                      ? "conversationImport.quoteCloudUnknown"
                      : "conversationImport.quoteCloud",
                    {
                      provider: draft.quote.providerName,
                      model: draft.quote.modelName,
                      cost: formattedCost,
                    },
                  )
              : draft.quoteLoading
                ? `${t("conversationImport.loading.quote")} ${t("conversationImport.distilNote")}`
                : t(
                    draft.quoteFailed
                      ? "conversationImport.quoteFailed"
                      : "conversationImport.quoteUnavailable",
                  )
          }
        >
          {draft.quoteFailed && (
            <Button variant="secondary" disabled={disabled} onClick={draft.retryQuote}>
              {t("conversationImport.quoteRetry")}
            </Button>
          )}
          <Switch
            label={t("conversationImport.distil")}
            checked={draft.distillationOn}
            disabled={disabled || !draft.quote}
            onCheckedChange={draft.toggleQuote}
          />
        </SettingsRow>
        {draft.quote && (
          <div className={styles.quoteAdvanced}>
            <button
              type="button"
              className={styles.advancedToggle}
              aria-expanded={quoteDetailsOpen}
              onClick={() => setQuoteDetailsOpen((openState) => !openState)}
            >
              <Icon
                name="chevronRight"
                size={12}
                className={styles.codingCaret}
                style={{ transform: quoteDetailsOpen ? "rotate(90deg)" : undefined }}
              />
              <span>{t("conversationImport.quoteAdvancedToggle")}</span>
            </button>
            {quoteDetailsOpen && (
              <p className={styles.advancedBody}>
                {t("conversationImport.quoteAdvanced", {
                  count: totalTokens.toLocaleString(locale),
                  input: draft.quote.inputTokens.toLocaleString(locale),
                  output: draft.quote.outputTokens.toLocaleString(locale),
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/** Custom instructions become one Bot's role, only after the comparison was shown. */
export function RoleRows({ draft, plan, disabled }: Props & { plan: Plan }) {
  const t = useT();
  if (!plan.instructions) return null;
  const { persona } = draft;
  const review = persona.review;
  return (
    <SettingsSection
      title={t("conversationImport.roleTitle")}
      action={<span className={styles.hint}>{t("conversationImport.roleHint")}</span>}
    >
      <div className={styles.item} data-off={!persona.on || undefined}>
        <SettingsRow
          icon="user"
          tone={persona.on ? "green" : "neutral"}
          label={
            <span dir="auto">
              {t("conversationImport.roleExcerpt", { text: excerpt(plan.instructions) })}
            </span>
          }
          note={t("conversationImport.roleNote")}
        >
          <DestinationChip
            value={persona.botId}
            bots={draft.bots}
            label={t("conversationImport.roleBot")}
            disabled={disabled}
            onChange={(botId) => draft.setPersona({ botId })}
          />
          <Button
            variant="secondary"
            disabled={disabled}
            aria-expanded={persona.open}
            onClick={() =>
              persona.review
                ? draft.setPersona({ open: !persona.open })
                : draft.comparePersona(persona.botId, persona.on)
            }
          >
            {t("conversationImport.compare")}
          </Button>
          <Switch
            label={t("conversationImport.includeRole")}
            checked={persona.on}
            disabled={disabled}
            onCheckedChange={(on) => draft.setPersona({ on })}
          />
        </SettingsRow>
        {persona.open && (
          <div className={styles.compare}>
            {review ? (
              <>
                <section>
                  <h3>{t("conversationImport.currentPersona")}</h3>
                  <p dir="auto">{review.personaBefore || t("conversationImport.noPersona")}</p>
                </section>
                <section>
                  <h3>{t("conversationImport.newPersona")}</h3>
                  <p dir="auto">{review.items.map(({ text }) => text).join("\n\n")}</p>
                </section>
              </>
            ) : (
              <p className={styles.meta} role="status">
                {t("conversationImport.loading.persona")}
              </p>
            )}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function excerpt(text: string) {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}
