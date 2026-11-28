import type { Bot } from "@pibot/plugins-contract/full";
import { useSettings } from "@pibot/renderer-kit";
import { type ReactNode, useState } from "react";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import styles from "./connections.module.css";
import { FacePicker } from "./Faces.tsx";

/**
 * The skills capability's writer (editor + saving), supplied by desktop: this package may only see
 * the skills contract. The page keeps the drawer and 「给谁用」 so it looks like a skill's details.
 */
export type SkillWriterSlot = (controls: {
  /**
   * Chosen Bots in the order they were picked; the first one owns the new skill. Empty is allowed:
   * the writer then keeps it unused until it is given to Bots from its details.
   */
  botIds: readonly string[];
  /** The 「给谁用」 section, placed by the writer below its fields. */
  audience: ReactNode;
  busy(value: boolean): void;
  close(): void;
}) => ReactNode;

/**
 * The skills capability's package editor for one existing copy (`skillId` in `groupId`'s store,
 * owned by `botId`), supplied by desktop like the writer. `saved` runs after an update landed.
 */
export type SkillEditorSlot = (controls: {
  skillId: string;
  groupId?: string;
  botId: string;
  busy(value: boolean): void;
  close(): void;
  saved(): void;
}) => ReactNode;

/**
 * Source/version, runtime and update blocks for one existing copy, supplied by desktop for
 * the same reason as the editor — the page may only see the skills contract.
 */
export type SkillExtrasSlot = (controls: {
  skillId: string;
  groupId?: string;
  botId: string;
  name: string;
  prepareRuntime?: boolean;
  runtime?: "python" | "node";
}) => ReactNode;

export function WriteSkillPanel({
  writer,
  bots,
  close,
}: {
  writer: SkillWriterSlot;
  bots: Bot[];
  close(): void;
}) {
  const { t } = useSettings();
  const [botIds, setBotIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const audience = (
    <section className={styles.section}>
      <h3>{t("connections.panel.who")}</h3>
      <FacePicker
        bots={bots}
        groups={[]}
        isOn={(_kind, id) => botIds.includes(id)}
        toggle={(_kind, id) =>
          setBotIds((list) =>
            list.includes(id) ? list.filter((value) => value !== id) : [...list, id],
          )
        }
        disabled={busy}
      />
      <p className={styles.note}>{t("connections.skill.writeNote")}</p>
    </section>
  );
  return (
    <ConnectorPanel title={t("connections.add.skill")} close={close} busy={busy}>
      {writer({ botIds, audience, busy: setBusy, close })}
    </ConnectorPanel>
  );
}
