import { type MethodResults, ProxyAddressSchema } from "@pibot/protocol";
import {
  layoutStyles,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useSettings,
  useTask,
} from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import { requirePeer, SetupError, writeCredential } from "./operations.ts";

async function wait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void pending.then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * No separate save button. The switch saves at once, the address saves when the field loses
 * focus (or on Enter), and provider limits are only mentioned next to a test result.
 */
export function NetworkProxySettings({ focus = false }: { focus?: boolean } = {}) {
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("network-proxy-settings")?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const { peer } = useRpc();
  const { t, network } = useSettings();
  const task = useTask();
  const testTask = useTask();
  const [address, setAddress] = useState("");
  const [testResult, setTestResult] = useState<MethodResults["network.test"]>();
  // The proxy this computer already uses, offered only while nothing is saved; the user's own
  // switch or Enter saves it, so Pi Bot never starts routing through it by itself.
  const [suggested, setSuggested] = useState<string>();
  useEffect(() => {
    let live = true;
    void window.pibot
      ?.systemProxy?.()
      .then((value) => {
        if (live && value) setSuggested(value);
      })
      // No suggestion is the only effect of a failed lookup.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const scope = useRef(new AbortController());
  const revision = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new peer invalidates the previous form operation.
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    return () => controller.abort();
  }, [peer]);
  useEffect(() => {
    if (!network) return;
    revision.current++;
    setTestResult(undefined);
    setAddress(network.address ?? suggested ?? "");
  }, [network, suggested]);
  const offering = !!suggested && !network?.address && address.trim() === suggested;
  const disabled = task.busy || testTask.busy || !peer || !network;
  const saved = network?.address ?? "";
  const save = (patch: { enabled: boolean; clearCredentials?: boolean }) =>
    void task.run(async () => {
      const current = scope.current;
      current.signal.throwIfAborted();
      setTestResult(undefined);
      const draft = address.trim();
      if (/^socks/i.test(draft)) throw new SetupError("network.socks");
      if ((draft || patch.enabled) && !ProxyAddressSchema.safeParse(draft).success)
        throw new SetupError("network.invalid");
      let publicAddress = saved;
      try {
        const result = await wait(
          writeCredential(() =>
            requirePeer(peer).call(
              "network.setConfig",
              {
                enabled: patch.enabled,
                address: draft || null,
                clearCredentials: patch.clearCredentials ?? false,
              },
              { timeoutMs: 30_000 },
            ),
          ),
          current.signal,
        );
        publicAddress = result.address ?? "";
      } finally {
        // Never leave credentials visible in the draft after a save attempt.
        if (!current.signal.aborted && /@/.test(draft)) setAddress(publicAddress);
      }
    });
  const test = () =>
    void testTask.run(async () => {
      const current = scope.current;
      current.signal.throwIfAborted();
      setTestResult(undefined);
      const version = revision.current;
      const result = await wait(
        requirePeer(peer).call("network.test", undefined, { timeoutMs: 25_000 }),
        current.signal,
      );
      if (!current.signal.aborted && version === revision.current) setTestResult(result);
    });
  return (
    <SettingsSection id="network-proxy-settings" title={t("network.title")}>
      <SettingsRow
        icon="network"
        tone="orange"
        label={t("network.address")}
        note={t("network.short")}
        info={t("network.note")}
      >
        <span className={layoutStyles.labelled}>
          {t("network.enabled")}
          <Switch
            label={t("network.enabled")}
            checked={network?.enabled ?? false}
            disabled={disabled}
            onCheckedChange={(enabled) => save({ enabled })}
          />
        </span>
      </SettingsRow>
      <form
        className={layoutStyles.row}
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim() !== saved) save({ enabled: network?.enabled ?? false });
        }}
      >
        <input
          className={layoutStyles.input}
          aria-label={t("network.address")}
          value={address}
          type="text"
          placeholder={t("network.placeholder")}
          disabled={disabled}
          autoComplete="off"
          maxLength={2048}
          onChange={(event) => setAddress(event.target.value)}
          onBlur={() => {
            if (address.trim() !== saved) save({ enabled: network?.enabled ?? false });
          }}
        />
        <Button
          type="button"
          variant="secondary"
          loading={testTask.busy}
          disabled={disabled || !network?.enabled}
          onClick={test}
        >
          {t("network.test")}
        </Button>
      </form>
      {offering && (
        <SettingsLine role="status" dot="ok">
          {t("network.systemSuggested")}
        </SettingsLine>
      )}
      {network?.hasCredentials && (
        <SettingsRow icon="user" tone="blue" label={t("network.savedAccount")}>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => save({ enabled: network.enabled, clearCredentials: true })}
          >
            {t("network.clearAccount")}
          </Button>
        </SettingsRow>
      )}
      {(task.error || testTask.error) && (
        <SettingsLine role="alert" tone="danger" dot="danger">
          {task.error ?? testTask.error}
        </SettingsLine>
      )}
      {testResult && (
        <SettingsLine
          role={testResult.ok ? "status" : "alert"}
          dot={testResult.ok ? "ok" : "danger"}
        >
          {t(`network.${testResult.reason}`, {
            address: testResult.address ?? t("network.unknown"),
          })}{" "}
          {t("network.localBypass")}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
