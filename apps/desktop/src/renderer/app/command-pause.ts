import type { CommandPause } from "@pibot/protocol";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useMemo, useSyncExternalStore } from "react";

const running: CommandPause = { paused: null };

/** Unlike the sticky drain health, this pause clears by itself, so each update replaces the last. */
class CommandPauseStore {
  private state: CommandPause = running;
  private listeners = new Set<() => void>();
  private off?: () => void;
  private epoch = 0;
  constructor(private readonly peer: Peer) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };
  set = (next: CommandPause) => {
    // A newer event or result supersedes a snapshot requested before it.
    this.epoch++;
    this.apply(next);
  };
  private apply(next: CommandPause) {
    if (
      next.paused === this.state.paused &&
      next.cleanupUnconfirmed === this.state.cleanupUnconfirmed
    )
      return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private start() {
    const epoch = ++this.epoch;
    this.off = this.peer.on("runtime.commands", (next) => this.set(next));
    void this.peer
      .call("runtime.commands.get", undefined)
      .then((next) => {
        if (epoch === this.epoch) this.apply(next);
      })
      .catch(() => {
        // Advisory only: a missed snapshot hides the banner; the next event shows it again.
      });
  }
  private stop() {
    this.epoch++;
    this.off?.();
    this.off = undefined;
  }
}

const stores = new WeakMap<Peer, CommandPauseStore>();
const runningSnapshot = () => running;
function useStore() {
  const { peer } = useRpc();
  return useMemo(() => {
    if (!peer) return undefined;
    let found = stores.get(peer);
    if (!found) {
      found = new CommandPauseStore(peer);
      stores.set(peer, found);
    }
    return found;
  }, [peer]);
}
export function useCommandPause(): CommandPause & { update?(next: CommandPause): void } {
  const store = useStore();
  const state = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.snapshot ?? runningSnapshot,
    store?.snapshot ?? runningSnapshot,
  );
  return store ? { ...state, update: store.set } : state;
}
