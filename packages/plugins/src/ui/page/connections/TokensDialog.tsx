import type { ConnectionToken } from "@pibot/plugins-contract/full";
import { Overlay, type Peer, useNavigation, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useConnectorRead } from "../../shell/remote.ts";
import { toolName } from "./ConnectionPanel.tsx";
import styles from "./connections.module.css";

export type TokensSlot = (controls: {
  create: number;
  formOpen(open: boolean): void;
  /** Connection tokens are listed above, so the slot's empty state must not claim there are none. */
  others: number;
  /** Optional shared secret name to open directly for updating its value. */
  initialSecret?: string;
}) => ReactNode;

/**
 * 访问令牌: one dialog for every token Pi Bot keeps for connections
 * and commands. Tokens a connection carries (typed when connecting or brought over) are listed
 * here; the ones the person added come from the credentials capability through `secrets`.
 */
export function TokensDialog({
  secrets,
  initialSecret,
  close,
}: {
  secrets: TokensSlot;
  initialSecret?: string;
  close(): void;
}) {
  const t = useT();
  const navigation = useNavigation();
  const read = useCallback(
    (peer: Peer, signal: AbortSignal) => peer.call("connections.tokens", {}, { signal }),
    [],
  );
  const tokens = useConnectorRead(read);
  useRpcEvent("connectors.changed", tokens.refresh);
  const [create, setCreate] = useState(0);
  const [secretForm, setSecretForm] = useState(false);
  const [replacing, setReplacing] = useState<ConnectionToken>();
  const items = tokens.value?.items ?? [];
  const missing = items.filter((token) => !token.hasValue);
  const settings = (section: "passwords" | "models") => {
    close();
    navigation.openSettings(section);
  };
  const formOpen = secretForm || !!replacing;
  return (
    <Overlay icon="key" tone="blue" title={t("connections.tokens.title")} close={close}>
      <div className={styles.tokens}>
        {replacing ? (
          <ReplaceToken
            token={replacing}
            close={() => {
              setReplacing(undefined);
              tokens.refresh();
            }}
          />
        ) : (
          !secretForm && (
            <>
              <p className={styles.tokensLead}>
                {t("connectors.secrets.subtitle")}
                {t("connections.tokens.elsewhere.before")}
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => settings("passwords")}
                >
                  {t("connections.tokens.passwords")}
                </button>
                {t("connections.tokens.elsewhere.middle")}
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => settings("models")}
                >
                  {t("connections.tokens.models")}
                </button>
                {t("connections.tokens.elsewhere.after")}
              </p>
              {missing.length > 0 && (
                <div className={styles.softCard} data-tint="amber">
                  {missing.map((token) => (
                    <div key={`${token.connectorId}:${token.name}`} className={styles.tileRow}>
                      <IconTile icon="key" tone="amber" size="lg" />
                      <span className={styles.tileText}>
                        {t("connections.tokens.missing", {
                          connection: token.connectorName,
                          name: token.name,
                        })}
                      </span>
                      <Button variant="secondary" onClick={() => setReplacing(token)}>
                        {t("connections.tokens.fill")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {tokens.error && <p className={styles.error}>{t(tokens.error)}</p>}
              {items.some((token) => token.hasValue) && (
                <div className={styles.softCard}>
                  {items
                    .filter((token) => token.hasValue)
                    .map((token) => (
                      <div key={`${token.connectorId}:${token.name}`} className={styles.tileRow}>
                        <IconTile icon="key" tone="violet" size="lg" />
                        <div className={styles.tokenText}>
                          <span className={styles.tokenName}>{token.name}</span>
                          <small>
                            {t("connections.tokens.usedBy", { connection: token.connectorName })}
                            {" · "}
                            {token.originTool
                              ? t("connections.tokens.from", {
                                  tool: toolName[token.originTool] ?? token.originTool,
                                })
                              : t("connections.tokens.typed")}
                          </small>
                        </div>
                        <span className={styles.tokenWho}>
                          {t("connections.tokens.follows", { connection: token.connectorName })}
                        </span>
                        <Button variant="ghost" onClick={() => setReplacing(token)}>
                          {t("connectors.secrets.replaceValue")}
                        </Button>
                      </div>
                    ))}
                </div>
              )}
            </>
          )
        )}
        {!replacing &&
          secrets({ create, formOpen: setSecretForm, others: items.length, initialSecret })}
      </div>
      {!formOpen && (
        <div className={styles.dialogFoot}>
          <Button variant="secondary" onClick={() => setCreate((value) => value + 1)}>
            ＋ {t("connectors.secrets.new")}
          </Button>
          <span />
          <Button onClick={close}>{t("connections.tokens.done")}</Button>
        </div>
      )}
    </Overlay>
  );
}

/**
 * 补上 / 更换值 for a connection's own token. It goes through `connectors.authorize`, the same path
 * as the connection's details panel, so the new value is checked by reconnecting.
 */
function ReplaceToken({ token, close }: { token: ConnectionToken; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = async () => {
    if (!peer || busy || !value.trim()) return;
    setBusy(true);
    setError(false);
    try {
      await peer.call(
        "connectors.authorize",
        {
          id: token.connectorId,
          expectedRevision: token.connectorRevision,
          token: value.trim(),
          tokenName: token.name,
        },
        { signal: AbortSignal.timeout(30_000) },
      );
      setValue("");
      close();
    } catch {
      // The details panel shows the connection's own failure reason; here a retry is enough.
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.tokenForm}>
      <div className={styles.tokenFormHead}>
        <Button variant="ghost" disabled={busy} onClick={close}>
          ← {t("connectors.secrets.back")}
        </Button>
        <h2>
          {t(token.hasValue ? "connectors.secrets.replaceValue" : "connections.tokens.fill")} ·{" "}
          {token.name}
        </h2>
      </div>
      <p className={styles.note}>
        {t("connections.tokens.replaceNote", { connection: token.connectorName })}
      </p>
      <label className={styles.tokenField}>
        <span>{t("connectors.secrets.value")}</span>
        <input
          ref={input}
          type="password"
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={16384}
          disabled={busy}
          placeholder={t("connectors.secrets.valuePlaceholder")}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            // Escape steps back to the list instead of closing the whole dialog.
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) close();
            }
          }}
        />
      </label>
      {error && <p className={styles.error}>{t("connectors.secrets.error.save")}</p>}
      <div className={styles.dialogFoot}>
        <span />
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t("connectors.secrets.cancel")}
        </Button>
        <Button
          loading={busy}
          disabled={!peer || busy || !value.trim()}
          onClick={() => void save()}
        >
          {t("connectors.secrets.save")}
        </Button>
      </div>
    </section>
  );
}
