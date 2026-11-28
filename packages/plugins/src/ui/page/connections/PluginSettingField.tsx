import {
  type ClaudePluginConfigField,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";
import { SettingsRow, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useState } from "react";
import { connectorError } from "../../shell/remote.ts";
import { DrawerField, SecretInput } from "./DrawerParts.tsx";
import styles from "./drawer.module.css";
import { localText } from "./local-text.ts";

type ConfigValue = string | number | boolean;

/** Readable folder or file name across macOS, Windows, and Linux paths. */
function readablePathName(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  if (!withoutTrailing) return trimmed;
  // Keep Windows drive roots like "C:" readable as "C:\".
  if (/^[A-Za-z]:$/.test(withoutTrailing)) return trimmed;
  return withoutTrailing.split(/[\\/]/).at(-1) || trimmed;
}

/** Whether a field is shown under the current values (`visibleWhen`). */
export function fieldVisible(
  field: ClaudePluginConfigField,
  fields: readonly ClaudePluginConfigField[],
  config: Record<string, ConfigValue>,
) {
  if (!field.visibleWhen) return true;
  const controlling = fields.find((candidate) => candidate.key === field.visibleWhen?.key);
  return (config[field.visibleWhen.key] ?? controlling?.default) === field.visibleWhen.equals;
}

/**
 * One plugin setting as the connect drawer shows it: a switch, a choice, a masked secret, an OS
 * folder/file picker, or a plain box. The connect drawer and 高级 → 设置 share it so a setting
 * looks the same in both.
 */
export function PluginSettingField({
  field,
  fields,
  config,
  idPrefix,
  disabled,
  showFullPath = false,
  setValue,
}: {
  field: ClaudePluginConfigField;
  fields: readonly ClaudePluginConfigField[];
  config: Record<string, ConfigValue>;
  idPrefix: string;
  disabled: boolean;
  /** Raw technical paths stay under Advanced; first-time import preview shows the readable name only. */
  showFullPath?: boolean;
  setValue(key: string, value: ConfigValue): void;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [picking, setPicking] = useState(false);
  const [pickerUnavailable, setPickerUnavailable] = useState(false);
  const [pickerError, setPickerError] = useState<ReturnType<typeof connectorError>>();
  if (!fieldVisible(field, fields, config)) return null;
  const id = `${idPrefix}-${field.key}`;
  const label = localText(field.title, language);
  const value = config[field.key] ?? "";
  const note = field.description && field.description !== field.key ? field.description : "";
  const help = localText(
    note || (field.sensitive ? t("connectors.generatedSecret") : t("connectors.generatedSetting")),
    language,
  );
  if (field.type === "boolean")
    return (
      <SettingsRow label={label} note={help}>
        <Switch
          id={id}
          label={label}
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => setValue(field.key, checked)}
        />
      </SettingsRow>
    );
  const isPathField =
    (field.type === "directory" || field.type === "file") && !field.options?.length;
  const isDirectory = field.type === "directory";
  const stringValue = String(value);
  const displayName = field.sensitive && stringValue ? "••••••" : readablePathName(stringValue);
  const showPathInput = pickerUnavailable || (showFullPath && !field.sensitive);
  const noPath = t(
    isDirectory ? "connections.drawer.noFolderChosen" : "connections.drawer.noFileChosen",
  );
  const pickPath = async () => {
    if (!peer || disabled || picking) return;
    setPicking(true);
    setPickerError(undefined);
    try {
      const result = await peer.call("plugins.pickSettingPath", {
        kind: isDirectory ? "directory" : "file",
      });
      if (result.path) setValue(field.key, result.path);
    } catch (error) {
      if (error instanceof RpcError && error.code === RpcErrorCodes.unsupported)
        setPickerUnavailable(true);
      else setPickerError(connectorError(error));
    } finally {
      setPicking(false);
    }
  };
  const fieldNote =
    isPathField && pickerError ? (
      <span role="alert" className={styles.fieldError}>
        {t(pickerError)}
      </span>
    ) : isPathField && pickerUnavailable ? (
      t("connections.drawer.pickerUnavailable")
    ) : (
      help
    );
  return (
    <DrawerField
      id={id}
      label={label}
      required={field.required}
      secret={field.sensitive}
      note={fieldNote}
      icon={
        field.sensitive
          ? "key"
          : field.type === "directory"
            ? "folder"
            : field.type === "file"
              ? "file"
              : undefined
      }
    >
      {isPathField ? (
        <>
          {showPathInput ? (
            <input
              id={id}
              type={field.sensitive ? "password" : "text"}
              value={stringValue}
              required={field.required}
              disabled={disabled}
              autoComplete={field.sensitive ? "new-password" : "off"}
              spellCheck={false}
              placeholder={noPath}
              onChange={(event) => {
                setPickerError(undefined);
                setValue(field.key, event.currentTarget.value);
              }}
            />
          ) : (
            <span
              className={styles.pathValue}
              data-empty={!stringValue ? "" : undefined}
              title={field.sensitive ? undefined : displayName || undefined}
            >
              {displayName || noPath}
            </span>
          )}
          {!field.required && stringValue && (
            <button
              type="button"
              className={styles.pathClear}
              disabled={disabled || picking}
              onClick={() => {
                setPickerError(undefined);
                setValue(field.key, "");
              }}
            >
              {t("connections.drawer.clearPath")}
            </button>
          )}
          {!pickerUnavailable && (
            <Button
              id={showPathInput ? undefined : id}
              type="button"
              variant="secondary"
              className={styles.pathButton}
              loading={picking}
              disabled={disabled || picking || !peer}
              onClick={() => void pickPath()}
            >
              {t(
                stringValue
                  ? isDirectory
                    ? "connections.drawer.changeFolder"
                    : "connections.drawer.changeFile"
                  : isDirectory
                    ? "connections.drawer.chooseFolder"
                    : "connections.drawer.chooseFile",
              )}
            </Button>
          )}
        </>
      ) : field.options?.length ? (
        <select
          id={id}
          value={stringValue}
          required={field.required}
          disabled={disabled}
          onChange={(event) => {
            const selected = field.options?.find(
              (option) => String(option.value) === event.currentTarget.value,
            );
            if (selected) setValue(field.key, selected.value);
          }}
        >
          {field.options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {localText(option.label, language)}
            </option>
          ))}
        </select>
      ) : field.sensitive ? (
        <SecretInput
          id={id}
          label={label}
          value={stringValue}
          disabled={disabled}
          onChange={(next) => setValue(field.key, next)}
        />
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={stringValue}
          required={field.required}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            setValue(field.key, field.type === "number" && raw !== "" ? Number(raw) : raw);
          }}
        />
      )}
    </DrawerField>
  );
}
