import { SettingsLine, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";

export function CopyPairCode({ code, disabled }: { code: string; disabled?: boolean }) {
  const t = useT();
  const [result, setResult] = useState<"copied" | "failed">();
  useEffect(() => {
    if (result !== "copied") return;
    const timer = setTimeout(() => setResult(undefined), 2000);
    return () => clearTimeout(timer);
  }, [result]);
  return (
    <>
      <Button
        variant="secondary"
        disabled={disabled || result === "copied"}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setResult("copied");
          } catch {
            setResult("failed");
          }
        }}
      >
        <span aria-live="polite">
          {result === "copied" ? t("remote.copied") : t("remote.copyPairCode")}
        </span>
      </Button>
      {result === "failed" && (
        <SettingsLine role="alert" tone="danger">
          {t("remote.copyFailed")}
        </SettingsLine>
      )}
    </>
  );
}
