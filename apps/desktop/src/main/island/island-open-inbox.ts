import { app } from "electron";
import { readIslandOpenArgument } from "./island-open-argument.ts";

export function captureIslandOpens(argv: readonly string[], signal: AbortSignal) {
  // Launchers can reach the GUI in a different order from the clicks. Keep every candidate
  // until the attached GUI can acknowledge it and the owner can match its latest click.
  const pending = new Set<string>();
  const handled = new Set<string>();
  let listener: (() => void) | undefined;
  let acknowledging = false;
  const offer = (id: string) => {
    if (handled.has(id)) return;
    pending.add(id);
    // The owner can renew foreground permission after the GUI has parsed the cold-launch argument.
    // Ask the still-pending window to activate again, while acknowledging the request only once.
    listener?.();
  };
  const capture = (args: readonly string[]) => {
    const id = readIslandOpenArgument(args);
    if (id) offer(id);
  };
  const receive = (_event: Electron.Event, args: string[]) => capture(args);
  capture(argv);
  app.on("second-instance", receive);
  signal.addEventListener(
    "abort",
    () => {
      listener = undefined;
      pending.clear();
      handled.clear();
      app.off("second-instance", receive);
    },
    { once: true },
  );
  return {
    offer,
    hasPending: () => pending.size > 0,
    subscribe(next: () => void) {
      listener = next;
      if (pending.size) next();
      return () => {
        listener = undefined;
      };
    },
    async acknowledge(send: (id: string) => Promise<unknown>, ready: () => boolean) {
      if (acknowledging) return;
      acknowledging = true;
      try {
        for (const id of pending) {
          if (!ready()) break;
          await send(id);
          pending.delete(id);
          handled.add(id);
          if (handled.size > 32) {
            const oldest = handled.values().next().value;
            if (oldest !== undefined) handled.delete(oldest);
          }
        }
      } finally {
        acknowledging = false;
      }
    },
  };
}
