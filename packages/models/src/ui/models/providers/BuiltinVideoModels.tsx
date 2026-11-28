import {
  type BuiltinVideoProviderId,
  type MethodResults,
  suggestedOpenRouterVideo,
} from "@pibot/models-contract/full";
import { setupStyles as styles, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Chip, Switch } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { requirePeer } from "../../setup/operations.ts";
import { EnableVideoModel, VideoModelPrice } from "./EnableVideoModel.tsx";
import detailStyles from "./provider-detail.module.css";
import type { Task } from "./provider-form.tsx";

export function BuiltinVideoModels({
  providerId,
  task,
  name,
}: {
  providerId: BuiltinVideoProviderId;
  task: Task;
  name?: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [catalog, setCatalog] = useState<MethodResults["providers.videoModels"]>();
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController>(undefined);
  const retrying = useRef(false);
  const refresh = useCallback(
    (refresh = false) => {
      if (retrying.current && !refresh) return;
      pending.current?.abort();
      if (!peer) return;
      const load = new AbortController();
      pending.current = load;
      retrying.current = refresh;
      void peer
        .call("providers.videoModels", { providerId, refresh }, { signal: load.signal })
        .then(
          (result) => {
            if (load.signal.aborted) return;
            setCatalog(result);
            setFailed(false);
          },
          () => {
            if (!load.signal.aborted) setFailed(true);
          },
        )
        .finally(() => {
          if (pending.current === load) retrying.current = false;
        });
    },
    [peer, providerId],
  );
  useRpcEvent("providers.changed", () => refresh());
  useEffect(() => {
    refresh();
    return () => {
      retrying.current = false;
      pending.current?.abort();
    };
  }, [refresh]);

  return (
    <div className={styles.stack}>
      {name && <strong>{name}</strong>}
      {!catalog && !failed && <p role="status">{t("common.loading")}</p>}
      {(failed || catalog?.unavailable) && (
        <div role="alert" className={styles.wrap}>
          <span>
            {t(
              catalog?.models.some(({ cachedPricing }) => cachedPricing)
                ? "video.catalogCached"
                : "setup.failed",
            )}
          </span>
          <Button variant="secondary" disabled={!peer || task.busy} onClick={() => refresh(true)}>
            {t("setup.retry")}
          </Button>
        </div>
      )}
      {providerId === "google" && <p className={styles.note}>{t("video.builtinGoogleNote")}</p>}
      {providerId === "openrouter" && (
        <p className={styles.note}>{t("video.builtinOpenRouterNote")}</p>
      )}
      {catalog?.fallback && (
        <div className={styles.wrap}>
          <p className={styles.note}>
            {t(
              providerId === "openrouter"
                ? "video.builtinOpenRouterFallback"
                : "video.builtinFallback",
            )}
          </p>
          {!failed && !catalog.unavailable && (
            <Button variant="secondary" disabled={!peer || task.busy} onClick={() => refresh(true)}>
              {t("setup.retry")}
            </Button>
          )}
        </div>
      )}
      {catalog && !catalog.unavailable && !catalog.models.length && (
        <p className={styles.note}>{t("video.builtinEmpty")}</p>
      )}
      {!!catalog?.models.length && (
        <div className={detailStyles.switchCard}>
          {catalog.models.map((model) => {
            const { id, enabled } = model;
            return enabled ? (
              <div className={detailStyles.switchRow} key={id}>
                <span>
                  {id}
                  <br />
                  <VideoModelPrice model={model} />
                </span>
                {providerId === "openrouter" && suggestedOpenRouterVideo(id) && (
                  <Chip>{t("video.recommended")}</Chip>
                )}
                <Switch
                  label={id}
                  checked
                  disabled={!peer || task.busy}
                  onCheckedChange={() =>
                    void task.run(async () => {
                      await requirePeer(peer).call("providers.setVideoModel", {
                        providerId,
                        modelId: id,
                        enabled: false,
                      });
                    })
                  }
                />
              </div>
            ) : (
              <EnableVideoModel providerId={providerId} model={model} key={id} />
            );
          })}
        </div>
      )}
    </div>
  );
}
