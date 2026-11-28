import { useRpc } from "@pibot/renderer-kit";
import type { MethodResults } from "@pibot/skills-contract/full";
import { useEffect, useState } from "react";
import { skillError } from "./presentation.ts";

export type SkillDetailData = MethodResults["skills.get"];

/** Keep the costly read out of the summary request and cancel it when its panel goes away. */
export function useSkillDetailRead(
  skillId: string,
  groupId: string | undefined,
  botId: string,
  revision: number,
  kind: "summary" | "resources",
  enabled = true,
) {
  const { peer } = useRpc();
  const key = JSON.stringify([skillId, groupId, botId, kind]);
  const [state, setState] = useState<{
    key: string;
    revision: number;
    data?: SkillDetailData;
    error?: ReturnType<typeof skillError>;
  }>();
  useEffect(() => {
    if (!peer || !enabled) return;
    const controller = new AbortController();
    void peer
      .call(
        "skills.get",
        { groupId, skillId, ...(kind === "summary" ? { includeResources: false as const } : {}) },
        { signal: controller.signal },
      )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.skill.id !== skillId || data.skill.botId !== botId)
          throw new Error("skill_owner_changed");
        setState({ key, revision, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState((old) => ({
            key,
            revision,
            data: old?.key === key ? old.data : undefined,
            error: skillError(error),
          }));
      });
    return () => controller.abort();
  }, [peer, enabled, key, skillId, groupId, botId, kind, revision]);
  const result = state?.key === key ? state : undefined;
  const current = result?.revision === revision;
  // Keep same-skill data visible while refreshing, without carrying it to a different owner.
  return {
    data: result?.data,
    error: current ? result?.error : undefined,
    loading: enabled && !current,
  };
}

export function useSkillResources(
  skillId: string,
  groupId: string | undefined,
  botId: string,
  revision: number,
  enabled = true,
) {
  const [request, setRequest] = useState(0);
  const read = useSkillDetailRead(
    skillId,
    groupId,
    botId,
    revision + request,
    "resources",
    enabled,
  );
  return { ...read, load: () => setRequest((value) => value + 1) };
}
