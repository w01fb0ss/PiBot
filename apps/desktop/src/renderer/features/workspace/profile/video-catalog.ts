import type { MethodResults } from "@pibot/protocol";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

type VideoModels = MethodResults["videos.models"];

export function useVideoCatalog(enabled = true) {
  const { peer } = useRpc();
  const [revision, setRevision] = useState(0);
  const [models, setModels] = useState<VideoModels>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision starts a new catalog read.
  useEffect(() => {
    if (!peer || !enabled) return;
    const abort = new AbortController();
    const { signal } = abort;
    setLoading(true);
    setError(false);
    const read = async () => {
      const models: VideoModels = [];
      const limit = 200;
      for (;;) {
        const page = await peer.call("videos.models", { offset: models.length, limit }, { signal });
        models.push(...page);
        if (page.length < limit) return models;
      }
    };
    void read().then(
      (models) => {
        if (!signal.aborted) {
          setModels(models);
          setLoading(false);
        }
      },
      () => {
        if (!signal.aborted) {
          setError(true);
          setLoading(false);
        }
      },
    );
    const off = peer.on("providers.changed", reload);
    return () => {
      abort.abort();
      off();
    };
  }, [peer, enabled, reload, revision]);
  return { models, loading, error, reload };
}
