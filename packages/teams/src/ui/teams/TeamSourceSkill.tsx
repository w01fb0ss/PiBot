import {
  RpcError,
  RpcErrorCodes,
  type SkillImportDetails,
  type TeamSkillReimport,
} from "@pibot/protocol";
import { useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./teams.module.css";

/** External metadata grants nothing: source download and skill installation each require a click. */
export function TeamSourceSkill({ skill, botId }: { skill: TeamSkillReimport; botId?: string }) {
  const t = useT();
  const { peer } = useRpc();
  const navigation = useNavigation();
  const life = useRef<{ controller: AbortController; previewId?: string }>({
    controller: new AbortController(),
  });
  const [preview, setPreview] = useState<SkillImportDetails>();
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{
    skillId: string;
    botId: string;
    name: string;
    needsRuntime: boolean;
  }>();
  const [error, setError] = useState<"teams.sourceUnavailable" | "teams.sourceFailed">();
  useEffect(() => {
    const current = {
      controller: new AbortController(),
      previewId: undefined as string | undefined,
    };
    life.current = current;
    return () => {
      current.controller.abort();
      if (current.previewId && peer)
        void peer.call("skills.cancelPreview", { previewId: current.previewId }).catch(() => {
          // Closing the peer also drains the import capability and its preview cache.
        });
    };
  }, [peer]);
  const prepare = async () => {
    if (!peer || !botId || !skill.reimport.source || busy) return;
    const current = life.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await peer.call(
        "teams.previewSkillSource",
        { botId, source: skill.reimport.source, contentHash: skill.reimport.contentHash },
        { signal: current.controller.signal },
      );
      if (current.controller.signal.aborted) {
        await peer.call("skills.cancelPreview", { previewId: result.previewId });
        return;
      }
      current.previewId = result.previewId;
      setPreview(result);
    } catch (error) {
      if (!current.controller.signal.aborted)
        setError(
          error instanceof RpcError && error.code === RpcErrorCodes.unsupported
            ? "teams.sourceUnavailable"
            : "teams.sourceFailed",
        );
    } finally {
      if (!current.controller.signal.aborted) setBusy(false);
    }
  };
  const install = async () => {
    if (!peer || !preview || busy) return;
    const current = life.current;
    setBusy(true);
    setError(undefined);
    try {
      const saved = await peer.call(
        "skills.import",
        { previewId: preview.previewId },
        { signal: current.controller.signal },
      );
      current.previewId = undefined;
      if (!current.controller.signal.aborted) {
        setImported({
          skillId: saved.id,
          botId: saved.botId,
          name: saved.name,
          needsRuntime: !!preview.summary?.runtimeRequirements?.length,
        });
        setPreview(undefined);
      }
    } catch {
      if (!current.controller.signal.aborted) setError("teams.sourceFailed");
    } finally {
      if (!current.controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className={styles.card}>
      <p className={styles.note}>
        {t(skill.reimport.source ? "teams.sourceRequired" : "teams.localOmitted", {
          name: skill.name,
        })}
      </p>
      {skill.reimport.source && (
        <a href={skill.reimport.source.url} target="_blank" rel="noreferrer">
          {skill.reimport.source.url}
        </a>
      )}
      {botId && skill.reimport.source && !preview && !imported && (
        <Button loading={busy} disabled={!peer || busy} onClick={() => void prepare()}>
          {t("teams.sourcePrepare")}
        </Button>
      )}
      {preview && (
        <>
          <p className={styles.note}>
            {t("teams.sourceReview", { files: preview.files.length, bytes: preview.totalBytes })}
          </p>
          <pre className={styles.code}>{preview.document.body}</pre>
          <Button
            loading={busy}
            disabled={busy || Date.parse(preview.expiresAt) <= Date.now()}
            onClick={() => void install()}
          >
            {t("teams.sourceConfirm")}
          </Button>
        </>
      )}
      {imported && <p role="status">{t("teams.sourceImported")}</p>}
      {imported?.needsRuntime && (
        <Button
          onClick={() => {
            const { skillId, botId, name } = imported;
            navigation.openPage("connectors");
            navigation.navigate({
              name: "connectors",
              skillConnection: { skillId, botId, name, prepareRuntime: true },
            });
          }}
        >
          {t("skills.runtime.prepareNow")}
        </Button>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
    </section>
  );
}
