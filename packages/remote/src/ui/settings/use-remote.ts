import { RpcError } from "@pibot/protocol";
import type { DeviceView, PairStatus, RemoteSettings, RemoteState } from "@pibot/remote-contract";
import { RelayUrlSchema } from "@pibot/remote-contract";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export function useRemoteSettings() {
  const { peer } = useRpc();
  const [loadedPeer, setLoadedPeer] = useState<Peer | null>(null);
  const [settings, setSettings] = useState<RemoteSettings>();
  const [status, setStatus] = useState<RemoteState>();
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [pair, setPair] = useState<PairStatus & { payload?: string; kind?: "runner" }>();
  const [error, setError] = useState<"failed" | "stale" | undefined>();
  const [actionError, setActionError] = useState<
    | "failed"
    | "stale"
    | "pairUnavailable"
    | "pairFailed"
    | "phonePairFailed"
    | "runnerPairStartFailed"
    | "revocationPending"
    | "revocationPending.runner"
    | "revocationPending.phone"
    | "busy"
    | "pairInvalid"
    | "pairRelayMismatch"
    | "relayInvalid"
  >();
  const [errorScope, setErrorScope] = useState<"runner" | "phone">();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const lifetime = useRef(new AbortController());
  const reading = useRef<AbortController | undefined>(undefined);
  const pending = useRef<AbortController | undefined>(undefined);
  const activePair = useRef<string | undefined>(undefined);
  const load = useCallback(
    async (after?: string) => {
      if (!peer) return;
      reading.current?.abort();
      const controller = new AbortController();
      reading.current = controller;
      const signal = AbortSignal.any([
        controller.signal,
        lifetime.current.signal,
        AbortSignal.timeout(20_000),
      ]);
      try {
        const [saved, state, page] = await Promise.all([
          peer.call("remote.settings.get", undefined, { signal }),
          peer.call("remote.status", undefined, { signal }),
          peer.call(
            "devices.list",
            { after, limit: 50, includeRevocationPending: true },
            { signal },
          ),
        ]);
        signal.throwIfAborted();
        setSettings((old) => (old?.version === saved.version ? old : saved));
        setLoadedPeer(peer);
        setStatus(state);
        setNext(page.nextAfter);
        const visible = page.items.filter(
          (device) => !device.revokedAt || device.revocationPending,
        );
        setDevices((old) =>
          after ? [...new Map([...old, ...visible].map((d) => [d.id, d])).values()] : visible,
        );
        setError(undefined);
      } catch {
        if (!controller.signal.aborted && !lifetime.current.signal.aborted) setError("failed");
      } finally {
        if (reading.current === controller) setLoading(false);
      }
    },
    [peer],
  );
  useEffect(() => {
    lifetime.current = new AbortController();
    setSettings(undefined);
    setBusy(false);
    setError(undefined);
    setActionError(undefined);
    setDevices([]);
    setPair(undefined);
    setLoading(true);
    void load();
    const offDevices = peer?.on("devices.changed", () => {
      void load();
    });
    const offState = peer?.on("remote.state", (state) => setStatus(state));
    return () => {
      lifetime.current.abort();
      reading.current?.abort();
      offDevices?.();
      offState?.();
      const id = activePair.current;
      activePair.current = undefined;
      if (id && peer)
        void peer
          .call("devices.pairCancel", { id }, { signal: AbortSignal.timeout(5000) })
          .catch(() => {
            // The server's ten-minute expiry remains authoritative after a disconnected viewport.
          });
    };
  }, [peer, load]);
  const pairId = pair?.id;
  const pairStatus = pair?.status;
  useEffect(() => {
    if (!peer || !pairId || pairStatus !== "waiting") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await peer.call(
          "devices.pairStatus",
          { id: pairId },
          { signal: controller.signal, timeoutMs: 5000 },
        );
        if (controller.signal.aborted) return;
        setPair((old) =>
          old?.id === value.id
            ? { ...old, ...value, ...(value.status !== "waiting" ? { payload: undefined } : {}) }
            : old,
        );
        if (value.status !== "waiting") {
          activePair.current = undefined;
          void load();
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(() => {
        void poll();
      }, 1000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [peer, pairId, pairStatus, load]);
  // "Add phone" and "add runner" share remote_pair_failed; each needs its own explanation.
  const perform = async (
    action: (current: Peer, signal: AbortSignal) => Promise<void>,
    pairFailed: "pairFailed" | "phonePairFailed" | "runnerPairStartFailed" = "pairFailed",
    timeoutMs = 30_000,
    scope?: "runner" | "phone",
  ) => {
    if (!peer || loadedPeer !== peer) return false;
    if (pending.current === lifetime.current) {
      setErrorScope(scope);
      setActionError("busy");
      return false;
    }
    const owner = lifetime.current;
    pending.current = owner;
    setBusy(true);
    setActionError(undefined);
    const signal = AbortSignal.any([owner.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      await action(peer, signal);
      signal.throwIfAborted();
      await load();
      return true;
    } catch (cause) {
      if (!owner.signal.aborted) {
        setErrorScope(scope);
        const reasons = {
          remote_settings_stale: "stale",
          remote_pair_unavailable: "pairUnavailable",
          remote_pair_failed: pairFailed,
          remote_revocation_pending: "revocationPending",
          remote_runner_revocation_pending: "revocationPending.runner",
          remote_phone_revocation_pending: "revocationPending.phone",
          remote_busy: "busy",
          remote_pair_invalid: "pairInvalid",
          remote_pair_relay_mismatch: "pairRelayMismatch",
          remote_relay_invalid: "relayInvalid",
        } as const;
        setActionError(
          cause instanceof RpcError && Object.hasOwn(reasons, cause.message)
            ? reasons[cause.message as keyof typeof reasons]
            : pairFailed === "pairFailed"
              ? "failed"
              : pairFailed,
        );
      }
      return false;
    } finally {
      if (pending.current === owner) pending.current = undefined;
      if (!owner.signal.aborted) setBusy(false);
    }
  };
  return {
    settings: loadedPeer === peer ? settings : undefined,
    status: loadedPeer === peer ? status : undefined,
    devices: loadedPeer === peer ? devices : [],
    pair: loadedPeer === peer ? pair : undefined,
    busy,
    loading: loading || loadedPeer !== peer,
    error: actionError ?? error,
    errorScope: actionError ? errorScope : undefined,
    clearActionError: () => setActionError(undefined),
    reload: () => {
      setActionError(undefined);
      return load();
    },
    more: () => (next ? load(next) : Promise.resolve()),
    hasMore: !!next,
    save: (patch: Omit<RemoteSettings, "version">, consent: boolean) =>
      perform(async (p, signal) => {
        if (!settings) return;
        if (patch.relay === "custom" && !RelayUrlSchema.safeParse(patch.relayUrl).success)
          throw new RpcError(-32602, "remote_relay_invalid");
        await p.call(
          "remote.settings.set",
          {
            expectedVersion: settings.version,
            patch,
            ...(consent ? { disclosureAccepted: true as const } : {}),
          },
          { signal },
        );
      }),
    add: (kind?: "runner") =>
      perform(
        async (p, signal) => {
          setPair(undefined);
          const value = await p.call("devices.pairStart", kind ? { kind } : undefined, { signal });
          activePair.current = value.id;
          setPair({ ...value, kind, status: "waiting" });
        },
        kind === "runner" ? "runnerPairStartFailed" : "phonePairFailed",
        65_000,
        kind === "runner" ? "runner" : "phone",
      ),
    addRunner: (code: string) =>
      perform(
        async (p, signal) => {
          await p.call("devices.runnerPair", { code }, { signal, timeoutMs: 35_000 });
        },
        "pairFailed",
        40_000,
        "runner",
      ),
    cancel: () =>
      perform(async (p, signal) => {
        if (!pair) return;
        await p.call("devices.pairCancel", { id: pair.id }, { signal });
        activePair.current = undefined;
        setPair(undefined);
      }),
    rename: (id: string, name: string) =>
      perform(async (p, signal) => {
        await p.call("devices.rename", { id, name }, { signal });
      }),
    revoke: (id: string, removeAnyway?: true) =>
      perform(async (p, signal) => {
        await p.call("devices.revoke", { id, removeAnyway }, { signal });
      }),
  };
}
