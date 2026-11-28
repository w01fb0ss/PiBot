import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { UiNavigation } from "@pibot/protocol";

type Gui = { client: string; pid: number };
const EXIT_GRACE_MS = 1500;

export function createIslandOpen(options: {
  launch(id: string): ChildProcess;
  alive(pid: number): boolean;
  grantForeground(pid: number, signal: AbortSignal): Promise<void>;
  notify(client: string, id: string): void;
  failed(reason: string): void;
}) {
  let gui: Gui | undefined;
  let departed: { pid: number; at: number } | undefined;
  let pending:
    | {
        id: string;
        target: UiNavigation;
        finish(): void;
        foreground?: AbortController;
        retries: number;
        retry?: ReturnType<typeof setTimeout>;
        releaseLaunch?(): void;
      }
    | undefined;

  const dispatch = () => {
    const request = pending;
    if (!request) return;
    clearTimeout(request.retry);
    request.foreground?.abort();
    if (gui) {
      const attached = gui;
      const foreground = new AbortController();
      request.foreground = foreground;
      // Never ask Electron's singleton to notify a connected GUI. The singleton can
      // terminate an unresponsive hidden window before the user's draft is saved.
      void options
        .grantForeground(attached.pid, foreground.signal)
        .catch(() => {})
        .then(() => {
          if (!foreground.signal.aborted && pending === request && gui === attached)
            options.notify(attached.client, request.id);
        });
      return;
    }
    try {
      if (departed && Date.now() - departed.at < EXIT_GRACE_MS && options.alive(departed.pid)) {
        // A detached GUI may still own the single-instance lock while draining the owner.
        request.retry = setTimeout(dispatch, 250);
        return;
      }
      // An unverified PID can belong to another process after exit. Do not poll it indefinitely.
      departed = undefined;
      const child = options.launch(request.id);
      const exited = () => {
        request.releaseLaunch = undefined;
        // The child may have notified a primary GUI that is still starting. Give it time
        // to attach and allow one replacement if the child lost to a GUI that was exiting.
        if (request.retries++ === 0) request.retry = setTimeout(dispatch, 1000);
      };
      request.releaseLaunch = () => child.off("close", exited);
      child.once("close", exited);
    } catch {
      options.failed("gui_launch_failed");
      request.finish();
    }
  };

  return {
    open(target: UiNavigation) {
      pending?.finish();
      return new Promise<void>((resolve) => {
        const deadline = setTimeout(() => {
          options.failed("gui_open_unconfirmed");
          pending?.finish();
        }, 120_000);
        pending = {
          id: randomUUID(),
          target,
          retries: 0,
          finish() {
            clearTimeout(deadline);
            clearTimeout(pending?.retry);
            pending?.foreground?.abort();
            pending?.releaseLaunch?.();
            pending = undefined;
            resolve();
          },
        };
        dispatch();
      });
    },
    attach(client: string, pid: number) {
      gui = { client, pid };
      departed = undefined;
      if (!pending) return;
      clearTimeout(pending.retry);
      pending.releaseLaunch?.();
      pending.releaseLaunch = undefined;
      // Let the authenticated socket finish its attach before sending the event.
      const request = pending;
      setImmediate(() => {
        if (pending === request && gui?.client === client) dispatch();
      });
    },
    detach(client: string) {
      if (gui?.client !== client) return;
      departed = { pid: gui.pid, at: Date.now() };
      gui = undefined;
      if (pending) {
        pending.retries = 0;
        dispatch();
      }
    },
    opened(client: string, pid: number, id: string) {
      if (!pending || pending.id !== id || gui?.client !== client || gui.pid !== pid) return;
      const { target } = pending;
      pending.finish();
      return target;
    },
    dispose() {
      pending?.finish();
    },
  };
}
