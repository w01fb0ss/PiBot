import type { PairStatus } from "@pibot/remote-contract";
import { SettingsLine, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { CopyPairCode } from "./CopyPairCode.tsx";
import { QrCode } from "./QrCode.tsx";
import { displaySecurityCode } from "./security-code.ts";
export function Pairing({
  pair,
  busy,
  cancel,
  retry,
}: {
  pair: PairStatus & { payload?: string };
  busy: boolean;
  cancel(): void;
  retry(): void;
}) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (pair.status !== "waiting") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pair.status]);
  const seconds = Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 1000));
  if (pair.status === "paired")
    return (
      <SettingsLine role="status" tone="ok">
        {t("remote.securityCode", {
          code: pair.securityCode ? displaySecurityCode(pair.securityCode) : "",
        })}
      </SettingsLine>
    );
  if (pair.status !== "waiting" || !seconds)
    return (
      <SettingsLine
        role="status"
        action={
          <Button variant="secondary" disabled={busy} onClick={retry}>
            {t("remote.newPairCode")}
          </Button>
        }
      >
        {t("remote.pairEnded")}
      </SettingsLine>
    );
  return (
    <div>
      <SettingsLine>{t("remote.scan")}</SettingsLine>
      {pair.payload && (
        <QrCode payload={pair.payload} label={t("remote.scan")} errorLabel={t("remote.failed")} />
      )}
      {pair.payload && (
        <SettingsLine action={<CopyPairCode key={pair.id} code={pair.payload} disabled={busy} />}>
          {t("remote.shareCodeWarning")}
        </SettingsLine>
      )}
      <SettingsLine
        action={
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("remote.cancel")}
          </Button>
        }
      >
        {t("remote.expires", { seconds })}
      </SettingsLine>
    </div>
  );
}
