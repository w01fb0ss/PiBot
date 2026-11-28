import type { MemoryMaintenanceStatus } from "@pibot/protocol";
import { SettingsFold, SettingsLine, SettingsRow, useSettings, useTask } from "@pibot/renderer-kit";
import { Switch, TextField } from "@pibot/ui";
import { type Ref, useEffect, useId, useRef, useState } from "react";
import menu from "./app-menu.module.css";

export function MemoryDreamSettings({
  dailyUsage,
  budgetFocus,
  disabled,
  onBudgetSaved,
}: {
  dailyUsage?: MemoryMaintenanceStatus["dailyUsage"];
  budgetFocus?: string;
  disabled: boolean;
  onBudgetSaved(): void;
}) {
  const { t, settings, update } = useSettings();
  const [open, setOpen] = useState(false);
  const dailyLimit = useRef<HTMLInputElement>(null);
  const focused = useRef<string>(undefined);
  const task = useTask();
  const daily = settings?.memoryExtractionDailyCostUsd ?? 0.5;
  const usage =
    dailyUsage &&
    t("memorySettings.dream.dailyUsage", {
      used: `$${dailyUsage.costUsd.toFixed(2)}`,
      limit: `$${daily.toFixed(2)}`,
    });

  useEffect(() => {
    if (!budgetFocus || focused.current === budgetFocus) return;
    if (!open) setOpen(true);
    else if (!disabled && dailyLimit.current) {
      focused.current = budgetFocus;
      dailyLimit.current.focus();
    }
  }, [budgetFocus, disabled, open]);

  return (
    <SettingsFold
      title={t("memorySettings.dream.options")}
      icon="settings"
      tone="violet"
      open={open}
      onOpenChange={setOpen}
    >
      <SettingsRow
        icon="clock"
        tone="violet"
        label={t("memorySettings.dream.automatic")}
        note={t("memorySettings.dream.automaticNote")}
      >
        <Switch
          label={t("memorySettings.dream.automatic")}
          checked={!!settings?.memoryDreamEnabled}
          disabled={disabled || task.busy}
          onCheckedChange={(memoryDreamEnabled) =>
            void task.run(() => update({ memoryDreamEnabled }))
          }
        />
      </SettingsRow>
      <SettingsRow
        icon="shield"
        tone="blue"
        label={t("memorySettings.dream.localOnly")}
        note={t("memorySettings.dream.localOnlyNote")}
      >
        <Switch
          label={t("memorySettings.dream.localOnly")}
          checked={!!settings?.memoryDreamLocalOnly}
          disabled={disabled || task.busy}
          onCheckedChange={(memoryDreamLocalOnly) =>
            void task.run(() => update({ memoryDreamLocalOnly }))
          }
        />
      </SettingsRow>
      {task.error && (
        <SettingsLine role="alert" tone="danger">
          {task.error}
        </SettingsLine>
      )}
      <MemoryBudgetRow
        icon="chart"
        label={t("memorySettings.dream.budget")}
        note={t("memorySettings.dream.budgetNote")}
        saved={settings?.memoryDreamCostUsd ?? 0.05}
        disabled={disabled}
        onSave={async (memoryDreamCostUsd) => {
          await update({ memoryDreamCostUsd });
          onBudgetSaved();
        }}
      />
      <MemoryBudgetRow
        icon="calendar"
        label={t("memorySettings.dream.dailyLimit")}
        note={usage}
        saved={daily}
        inputRef={dailyLimit}
        disabled={disabled}
        onSave={async (memoryExtractionDailyCostUsd) => {
          await update({ memoryExtractionDailyCostUsd });
          onBudgetSaved();
        }}
      />
    </SettingsFold>
  );
}

function MemoryBudgetRow({
  icon,
  label,
  note,
  saved,
  disabled,
  inputRef,
  onSave,
}: {
  icon: "chart" | "calendar";
  label: string;
  note?: string;
  saved: number;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onSave(value: number): Promise<void>;
}) {
  const { t } = useSettings();
  const task = useTask();
  const noteId = useId();
  const [draft, setDraft] = useState(String(saved));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(saved));
    setInvalid(false);
  }, [saved]);

  return (
    <>
      <SettingsRow
        icon={icon}
        tone="amber"
        label={label}
        note={note && <span id={noteId}>{note}</span>}
      >
        <div className={menu.dreamCurrency}>
          <TextField
            ref={inputRef}
            label={label}
            hideLabel
            aria-describedby={note ? noteId : undefined}
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.01}
            required
            value={draft}
            disabled={disabled}
            readOnly={task.busy}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setInvalid(false);
              task.setSuccess("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={({ currentTarget: input }) => {
              if (disabled || task.isBusy()) return;
              const value = input.valueAsNumber;
              if (value === saved) return;
              const valid = input.validity.valid;
              setInvalid(!valid);
              if (valid) {
                void task.run(async () => {
                  await onSave(value);
                  task.setSuccess(t("setup.saved"));
                });
              }
            }}
            error={invalid ? t("memorySettings.dream.budgetInvalid") : undefined}
          />
          <span className={menu.dreamCurrencyUnit} aria-hidden="true">
            $
          </span>
        </div>
      </SettingsRow>
      {task.error && (
        <SettingsLine role="alert" tone="danger">
          {task.error}
        </SettingsLine>
      )}
      {task.success && (
        <SettingsLine role="status" tone="ok" dot="ok">
          {task.success}
        </SettingsLine>
      )}
    </>
  );
}
