// Lets users choose the browser route and check the extension connection.
import type { BrowserExtensionStatusSchema } from "@pibot/protocol";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  TaskStatus,
  useRpc,
  useRpcEvent,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { browserExtensionStores } from "../../app/browser-extension-store.ts";

type BrowserExtensionStatus = z.infer<typeof BrowserExtensionStatusSchema>;
type ExtensionState = BrowserExtensionStatus["extension"];

const STATUS_TONES = {
  connected: "ok",
  installed: "warn",
  not_installed: "warn",
  unsupported: undefined,
} as const;

export function BrowserSettings() {
  const { peer } = useRpc();
  const t = useT();
  const task = useTask();
  const [status, setStatus] = useState<BrowserExtensionStatus>();
  useEffect(() => {
    if (!peer) return;
    let pending: AbortController | undefined;
    const refresh = () => {
      pending?.abort();
      const request = new AbortController();
      pending = request;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
      void peer
        .call("browserExtension.status", {}, { signal })
        .then((value) => {
          if (!request.signal.aborted) setStatus(value);
        })
        .catch(() => {
          // Leave the last status visible during a temporary failure.
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      pending?.abort();
    };
  }, [peer]);
  useRpcEvent("browserExtension.changed", setStatus);
  useRpcEvent("settings.changed", ({ browserExtensionPreference }) => {
    if (!browserExtensionPreference) return;
    setStatus((current) => current && { ...current, preference: browserExtensionPreference });
  });
  const disabled = !peer || task.busy || !status;
  const change = (preference: "user" | "bot", takeOver?: true) => {
    if (!peer) return;
    void task.run(async () => {
      setStatus(
        await peer.call("browserExtension.setPreference", {
          preference,
          ...(takeOver ? { takeOver } : {}),
        }),
      );
    });
  };
  const [checked, setChecked] = useState(false);
  const check = () => {
    if (!peer) return;
    void task.run(async () => {
      setStatus(await peer.call("browserExtension.status", {}, { timeoutMs: 5000 }));
      setChecked(true);
    });
  };
  const registration = status?.preference === "user" ? status.registration : undefined;
  const extension: ExtensionState = status?.extension ?? "unsupported";
  const extensionLabel = {
    connected: t("settings.browserExtensionStatus.connected"),
    installed: t("settings.browserExtensionStatus.installed"),
    not_installed: t("settings.browserExtensionStatus.not_installed"),
    unsupported: t("settings.browserExtensionStatus.unsupported"),
  }[extension];
  const browser = status?.defaultBrowser;
  const browserName = browser?.name || t("settings.browserUnknown");
  const store = browser && browserExtensionStores[browser.id];
  return (
    <SettingsPage>
      <TaskStatus task={task} />
      <SettingsSection title={t("settings.browserSection")}>
        <SettingsRow
          icon="globe"
          tone="blue"
          label={t("settings.browserDefault")}
          note={browserName}
        />
        <SettingsRow
          icon="plug"
          tone="teal"
          label={t("settings.browserExtension")}
          note={
            status && (
              <>
                {extensionLabel}
                {browser?.id === "edge" &&
                  store &&
                  extension === "not_installed" &&
                  ` · ${t("settings.browserExtensionEdgeHelp")}`}
                {browser?.id === "safari" &&
                  extension === "unsupported" &&
                  ` · ${t("settings.browserExtensionSafariHelp")}`}
                {checked &&
                  (extension === "installed" || extension === "not_installed") &&
                  ` · ${t("settings.browserExtensionCheckHelp")}`}
              </>
            )
          }
          dot={status ? STATUS_TONES[extension] : undefined}
        >
          {!status && (
            <Button variant="secondary" disabled={!peer || task.busy} onClick={check}>
              {t("settings.browserExtensionCheck")}
            </Button>
          )}
          {store && extension === "not_installed" && (
            <Button
              variant="secondary"
              onClick={() => window.open(store, "_blank", "noopener,noreferrer")}
            >
              {t("settings.browserExtensionInstall")}
            </Button>
          )}
          {extension !== "unsupported" && status?.preference === "user" && !registration && (
            <Button variant="secondary" disabled={disabled} onClick={check}>
              {t("settings.browserExtensionCheck")}
            </Button>
          )}
        </SettingsRow>
        {registration && (
          <SettingsRow
            icon="plug"
            tone="amber"
            label={t(`settings.browserExtensionStatus.${registration}`)}
          >
            {registration === "other_instance" && (
              <Button variant="secondary" disabled={disabled} onClick={() => change("user", true)}>
                {t("settings.browserExtensionConnectHere")}
              </Button>
            )}
            {registration === "registration_failed" && (
              <Button variant="secondary" disabled={disabled} onClick={() => change("user")}>
                {t("settings.browserExtensionRetry")}
              </Button>
            )}
          </SettingsRow>
        )}
        <SettingsRow icon="shield" tone="violet" label={t("settings.browserPreference")}>
          <SegmentedControl
            label={t("settings.browserPreference")}
            disabled={disabled}
            value={status?.preference ?? "user"}
            options={[
              { value: "user", label: t("settings.browserPreferenceUser") },
              { value: "bot", label: t("settings.browserPreferenceBot") },
            ]}
            onValueChange={change}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
}
