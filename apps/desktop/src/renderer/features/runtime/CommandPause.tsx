import type { CommandPause } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useCommandPause } from "../../app/command-pause.ts";

/**
 * Commands are paused because Pi Bot could not confirm a previous command stopped. The brain
 * releases the pause only with proof, so "Check again" asks for one more check and never forces it.
 */
export function CommandPauseBanner({ className }: { className?: string }) {
  const pause = useCommandPause();
  const t = useT();
  if (pause.cleanupUnconfirmed)
    return (
      <div role="status" className={className}>
        <IconTile icon="warning" tone="red" size="sm" />
        <span>{t("runtime.commandCleanupUnconfirmed")}</span>
      </div>
    );
  if (!pause.paused) return null;
  // Keyed by state: an earlier "still paused" answer belongs to that state only.
  return (
    <PausedBanner
      key={pause.paused}
      className={className}
      paused={pause.paused}
      update={pause.update}
    />
  );
}

function PausedBanner({
  className,
  paused,
  update,
}: {
  className?: string;
  paused: NonNullable<CommandPause["paused"]>;
  update?: (next: CommandPause) => void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  return (
    <div role="alert" className={className}>
      <IconTile icon="warning" tone="red" size="sm" />
      <span>
        {t(paused === "stuck" ? "runtime.commandsPausedStuck" : "runtime.commandsPausedRetrying")}
        {task.error && <> {t(task.error)}</>}
      </span>
      <Button
        variant="secondary"
        disabled={!peer}
        loading={task.busy}
        onClick={() => {
          if (!peer) return;
          // One check may wait for several slow process snapshots on a loaded Windows host.
          void task
            .run(
              (signal) =>
                peer.call("runtime.commands.recheck", undefined, { signal, timeoutMs: 120_000 }),
              () => "runtime.commandsStillPaused",
            )
            .then((result) => {
              if (!result) return;
              if (result.paused) task.setError("runtime.commandsStillPaused");
              update?.(result);
            });
        }}
      >
        {t("runtime.commandsRecheck")}
      </Button>
    </div>
  );
}
