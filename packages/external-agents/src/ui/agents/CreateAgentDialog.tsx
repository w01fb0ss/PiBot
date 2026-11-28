import {
  agentAllowances,
  agentDescriptor,
  type CustomAgent,
  type DetectedAgent,
  type ExternalAgentId,
} from "@pibot/external-agents-contract";
import { AGENT_COLORS } from "@pibot/external-agents-contract/logos";
import { hostPlatform, Overlay, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon, SegmentedControl } from "@pibot/ui";
import type { CSSProperties } from "react";
import { useState } from "react";
import styles from "./agents.module.css";
import { AgentLogo, errorKey, megabytes, readOnlyLabel } from "./shared.tsx";

/**
 * The approved "before you create" card (external-agents.html `create`): who bills, where it can
 * write, what it can reach, what is opened for it, how it runs, and the adapter download. On
 * Windows the same dialog carries the "run unisolated" confirmation (`win-confirm`).
 */
export function CreateAgentDialog({
  agentId,
  detected,
  custom,
  onClose,
  onCreated,
}: {
  agentId: ExternalAgentId;
  detected?: DetectedAgent;
  custom?: CustomAgent;
  onClose(): void;
  onCreated(botId: string): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const platform = hostPlatform() ?? "darwin";
  const windows = platform === "win32";
  const accent = agentId === "custom" ? "var(--prim)" : `var(--avatar-${AGENT_COLORS[agentId]})`;
  const descriptor = agentId === "custom" ? undefined : agentDescriptor(agentId);
  const name = custom?.name ?? descriptor?.name ?? "";
  const vendor = descriptor?.vendor ?? t("externalAgents.vendor.custom");
  const allowances = agentAllowances({ id: agentId, custom: custom ?? null }, platform);
  const adapter = descriptor?.launch.kind === "adapter" ? descriptor.launch.adapter : undefined;
  const download = adapter && !detected?.adapter?.installed;
  const confirm = windows && !detected?.confirmedUnisolated;
  const allowed = [
    ...allowances.readWrite.map((path) => `~/${path}`),
    ...allowances.readOnly.map((path) => readOnlyLabel(path, t)),
    ...(allowances.unixSockets.length ? [t("externalAgents.create.dnsSocket")] : []),
    // macOS: the system certificate service; it fetches intermediate certificates outside the
    // sandbox, a channel the domain list does not cover (a known cost).
    ...(allowances.machLookup.some((service) => service.startsWith("com.apple.trustd")) &&
    platform === "darwin"
      ? [t("externalAgents.create.trustd")]
      : []),
    ...(allowances.localBinding && platform === "darwin"
      ? [t("externalAgents.create.localPorts")]
      : []),
    ...(allowances.pty && platform === "darwin" ? [t("externalAgents.create.pty")] : []),
  ];

  const create = async () => {
    if (!peer) return;
    setBusy(true);
    setFailure(undefined);
    try {
      // A known agent is confirmed by id first; a custom command is confirmed for its new Bot.
      if (confirm && agentId !== "custom")
        await peer.call("externalAgents.confirmUnisolated", { agentId, confirmed: true });
      if (download)
        await peer.call("externalAgents.installAdapter", { agentId }, { timeoutMs: 600_000 });
      const { botId } = await peer.call(
        "externalAgents.createBot",
        { agentId, ...(custom ? { custom } : {}) },
        { timeoutMs: 60_000 },
      );
      if (confirm && agentId === "custom")
        await peer.call("externalAgents.confirmUnisolated", { agentId, botId, confirmed: true });
      onCreated(botId);
    } catch (error) {
      setFailure(t("externalAgents.create.failed", { reason: t(errorKey(error)) }));
      setBusy(false);
    }
  };

  return (
    <Overlay
      title={
        confirm
          ? t("externalAgents.windows.title", { name })
          : t("externalAgents.create.title", { name })
      }
      titleIcon={<AgentLogo agentId={agentId} />}
      tone="neutral"
      busy={busy}
      close={onClose}
      footer={
        <div
          className={styles.footer}
          style={
            {
              "--button-fill": accent,
              "--button-on":
                agentId === "custom"
                  ? "var(--onPrim)"
                  : agentId === "codex"
                    ? "var(--avatar-eye-gray)"
                    : "var(--on-tone)",
            } as CSSProperties
          }
        >
          <span>
            {descriptor
              ? t("externalAgents.create.footnote", { name })
              : t("externalAgents.create.footnoteCustom")}
          </span>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void create()}>
            {confirm
              ? t("externalAgents.create.confirmWindows")
              : download
                ? t("externalAgents.create.downloadAndCreate")
                : t("externalAgents.create.create")}
          </Button>
        </div>
      }
    >
      <div
        className={styles.stack}
        style={
          {
            "--form-accent": accent,
          } as CSSProperties
        }
      >
        <div className={styles.lead}>
          <span>
            {t("externalAgents.create.subtitle", {
              program: detected?.version ?? descriptor?.commands[0] ?? custom?.command ?? "",
            })}
          </span>
        </div>
        {confirm && (
          <>
            <p className={styles.note}>{t("externalAgents.windows.body", { name })}</p>
            <p className={styles.band} data-tone="warn">
              <Icon name="warning" size={16} />
              {t("externalAgents.windows.advice")}
            </p>
          </>
        )}
        <section className={styles.createCard}>
          <h2 className={styles.cardTitle}>{t("externalAgents.create.capabilities")}</h2>
          <dl className={styles.createFacts}>
            <dt>
              <Icon name="user" size={18} />
              {t("externalAgents.create.account")}
            </dt>
            <dd>
              {descriptor
                ? t("externalAgents.create.accountValue", { name, vendor })
                : t("externalAgents.create.accountValueCustom")}
            </dd>
            {/* Without a sandbox (Windows) there is no write boundary, network list or opened
              paths to describe; only how it runs. */}
            {!windows && (
              <>
                <dt>
                  <Icon name="folder" size={18} />
                  {t("externalAgents.create.write")}
                </dt>
                <dd>{t("externalAgents.create.writeValue")}</dd>
                <dt>
                  <Icon name="globe" size={18} />
                  {t("externalAgents.create.network")}
                </dt>
                <dd className={allowances.network.length ? styles.mono : undefined}>
                  {allowances.network.length
                    ? allowances.network.map((domain) => (
                        <span className={styles.tag} key={domain}>
                          {domain}
                        </span>
                      ))
                    : t("externalAgents.create.networkNone")}
                </dd>
                <dt>
                  <Icon name="shield" size={18} />
                  {t("externalAgents.create.allow")}
                </dt>
                <dd className={allowed.length ? styles.mono : undefined}>
                  {allowed.length ? allowed.join(" · ") : t("externalAgents.create.allowNone")}
                </dd>
              </>
            )}
          </dl>
        </section>
        <section className={styles.createCard}>
          <h2 className={styles.cardTitle}>{t("externalAgents.create.run")}</h2>
          {/* The platform fixes the execution mode; this control does not grant an alternative. */}
          <SegmentedControl
            label={t("externalAgents.create.run")}
            options={[
              {
                value: "current",
                label: t(
                  windows
                    ? "externalAgents.create.modeWindows"
                    : "externalAgents.create.modeSandbox",
                ),
              },
            ]}
            value="current"
            onValueChange={() => undefined}
          />
          <p className={styles.note}>
            {t(windows ? "externalAgents.create.runWindows" : "externalAgents.create.runSandbox")}
          </p>
        </section>
        {descriptor?.noPerCommandAsk && !windows && (
          <p className={styles.band} data-tone="warn">
            <Icon name="warning" size={16} />
            {t("externalAgents.noPerCommandAsk", { name })}
          </p>
        )}
        {download && adapter && (
          <p className={styles.band} data-tone="info">
            <Icon name="download" size={16} />
            {t("externalAgents.create.adapter", {
              name,
              package: adapter.name.split("/").at(-1) ?? adapter.name,
              version: adapter.version,
              size: megabytes(adapter.bytes),
            })}
          </p>
        )}
        {failure && (
          <p role="alert" className={styles.error}>
            {failure}
          </p>
        )}
      </div>
    </Overlay>
  );
}
