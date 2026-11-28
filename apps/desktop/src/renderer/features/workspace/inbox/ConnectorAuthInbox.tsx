import { ConnectorDetails, useConnectorAction, useConnectorOperations } from "@pibot/plugins/ui";
import type { InboxItem } from "@pibot/protocol";
import { useNavigation, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useCallback, useState } from "react";
import styles from "./inbox.module.css";

export function ConnectorAuthInbox({
  item,
  refresh,
}: {
  item: Extract<InboxItem, { kind: "connector_auth" }>;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const navigation = useNavigation();
  const [selected, setSelected] = useState(false);
  const [snapshot, setSnapshot] = useState(0);
  const [authorization, setAuthorization] = useState<string>();
  const changed = useCallback(() => {
    setSnapshot((value) => value + 1);
    void refresh();
  }, [refresh]);
  const operations = useConnectorOperations(changed);
  const action = useConnectorAction(changed);
  useRpcEvent("connectors.changed", (event) => {
    if (event.connectorId === item.connectorId) changed();
  });
  const authorize = async () => {
    await action.run(async (peer, signal) => {
      const detail = await peer.call("connectors.get", { id: item.connectorId }, { signal });
      if (detail.auth !== "oauth") {
        setSelected(true);
        return;
      }
      const result = await peer.call(
        "connectors.authorize",
        { id: item.connectorId, expectedRevision: detail.connector.revision },
        { signal },
      );
      setAuthorization(result.authorizationId);
    });
  };
  return (
    <article className={styles.card}>
      <header className={styles.cardHeader}>
        <Icon name="link" />
        <strong>{item.name}</strong>
        <span className={styles.badge}>{t("connectors.reauthTab")}</span>
      </header>
      <p className={styles.cardText}>{t("connectors.reauthNote")}</p>
      {authorization && (
        <p role="status" className={styles.cardText}>
          {t("connectors.authorizing")}
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
      <div className={styles.links}>
        {authorization ? (
          <Button
            variant="secondary"
            disabled={action.disabled}
            onClick={() =>
              void action.run(async (peer, signal) => {
                await peer.call(
                  "connectors.cancelAuthorization",
                  { authorizationId: authorization },
                  { signal },
                );
                setAuthorization(undefined);
              })
            }
          >
            {t("connectors.cancelAuth")}
          </Button>
        ) : (
          <Button disabled={action.disabled} onClick={() => void authorize()}>
            {t("connectors.reauthorize")}
          </Button>
        )}
        <Button variant="ghost" onClick={() => setSelected(true)}>
          {t("connectors.viewConnection")}
        </Button>
      </div>
      {selected && (
        <ConnectorDetails
          id={item.connectorId}
          snapshot={snapshot}
          operations={operations}
          openTokens={(secretName) => {
            setSelected(false);
            navigation.navigate({
              name: "connectors",
              connection: { id: item.connectorId, connectorId: item.connectorId },
              tokens: secretName ? { secretName } : {},
            });
          }}
          changed={changed}
          close={() => setSelected(false)}
        />
      )}
    </article>
  );
}
