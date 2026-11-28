import { sameYoloScope, yoloScopeUnavailable } from "@pibot/client-core";
import { useRuntime, useText } from "../../../runtime/context.tsx";
import { confirmLocally } from "../../../runtime/local-auth.ts";
import { readYolo, setYolo } from "./calls.ts";
import { type ChatScope, scopeKey } from "./scope.ts";
import { useRemoteValue } from "./use-remote-value.ts";

/** The topic's YOLO switch; turning it on needs the phone unlocked first. */
export function useYolo(scope: ChatScope | undefined, folderId: string | undefined) {
  const runtime = useRuntime(),
    t = useText();
  const state = useRemoteValue(
    scope ? `yolo:${scopeKey(scope)}:${folderId ?? ""}` : undefined,
    (signal) => readYolo(runtime, scope as ChatScope, signal),
    ["conversations.yolo.changed", "devices.changed"],
  );
  const change = (enabled: boolean) =>
    state.write.run(async (signal) => {
      if (!scope) return;
      if (enabled) {
        const shown = state.value;
        if (!shown || state.action.error || yoloScopeUnavailable(shown)) return;
        await confirmLocally(t("unlockYolo"), t("cancel"), signal);
        const latest = await readYolo(runtime, scope, signal).catch(() => {
          if (!signal.aborted) state.action.setError("yoloScopeFailed");
          return undefined;
        });
        signal.throwIfAborted();
        if (!latest) return;
        state.setValue(latest);
        if (yoloScopeUnavailable(latest)) return;
        if (!sameYoloScope(latest, shown)) {
          state.write.setError("yoloScopeChanged");
          return;
        }
      }
      const next = await setYolo(runtime, scope, enabled, signal);
      signal.throwIfAborted();
      state.setValue(next);
      return next.enabled;
    });
  return {
    ...state,
    enabled: !!state.value?.enabled,
    turnOn: () => change(true),
    turnOff: () => change(false),
  };
}
