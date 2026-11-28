import { isChatGPTPlanProvider, type MemoryModelFallback } from "@pibot/protocol";
import { SettingsLine, useT } from "@pibot/renderer-kit";

export function MemoryFallbackNotice({
  fallback,
  partial,
  settingsLine,
}: {
  fallback: MemoryModelFallback;
  partial?: boolean;
  settingsLine?: boolean;
}) {
  const t = useT();
  const note = t(
    partial ? "memorySettings.maintenance.fallbackPartial" : "memorySettings.maintenance.fallback",
    {
      provider: isChatGPTPlanProvider(fallback.from.provider) ? "ChatGPT" : fallback.from.provider,
      model: fallback.to.id,
    },
  );
  return settingsLine ? (
    <SettingsLine role="status">{note}</SettingsLine>
  ) : (
    <p role="status">{note}</p>
  );
}
