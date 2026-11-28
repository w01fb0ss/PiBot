import {
  ANDROID_PHONE_CAPABILITIES,
  type MethodParams,
  type MethodResults,
  Methods,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { scopeTarget } from "../features/chat/controls/scope.ts";
import { CachedConversationsSchema } from "../features/conversations/model.ts";
import { appendPhoneDataLog, readPhoneDataPrefs } from "../features/phone-data/prefs.ts";
import {
  type PhoneDataDeps,
  type PhoneMediaSource,
  type PhoneSmsSource,
  phoneDataHandler,
} from "../features/phone-data/serve.ts";
import { uploadShared } from "../features/share/upload.ts";
import { StoredApprovalsSchema, StoredTopicsSchema, storeKeys } from "../storage/phone-store.ts";
import type { MobileStorage } from "../storage/state.ts";
import { ComputerSchema, PendingSchema } from "../storage/types.ts";
import { reportLinkEvent } from "../transport/diagnostics.ts";
import { createLenient } from "../transport/lenient.ts";
import type {
  ChatTarget,
  Computer,
  LinkConnection,
  MobileLink,
  PairResult,
  PendingFile,
  PendingMessage,
} from "../transport/link-port.ts";
import { type MobilePeer, MobileSession, type SessionState } from "../transport/session.ts";
import type { DesktopAbout } from "./compat.ts";

export interface MobileSnapshot extends SessionState {
  ready: boolean;
  devices: Computer[];
  selectedId?: string;
  pending: number;
  /**
   * Sends the computer just accepted, kept in memory for a few seconds so the bubble stays on
   * screen until the reloaded history carries the stored message (no blink in between).
   */
  delivered: (PendingMessage & { userMessageId: string; runIds?: string[] })[];
  /** Share of a pending message's files the computer has received, by client ID (0–1). */
  uploads: Record<string, number>;
  /**
   * The outbox message the last drain stopped at while online (upload refused, capacity, lost
   * receipt). It stays queued; the thread offers retry or removal.
   */
  failed?: string;
  revision: number;
  refreshVersion: number;
  /** The selected computer's version handshake (kept while offline). */
  desktop?: DesktopAbout;
  /** List items from the computer this app version could not read and left out. */
  skipped: number;
  /**
   * Android 「保持连接」 (maintainers 2026-11-11): the persistent remote-control service keeps the link in
   * the background. Off by default; on-demand push wake is the default (follow-up task).
   */
  keepConnected: boolean;
}
const KEEP_CONNECTED_KEY = "app:keepConnected";
/** Chats whose topic and messages are read into memory at start (the top of the chat list). */
const WARM_CHATS = 8;
// Proposal 5: 已送达 stays until the thread's history carries the message (the thread hides it
// then); this only bounds a history that never reloads (the chat was closed meanwhile).
const DELIVERED_MS = 60_000;
// A text send whose answer timed out goes again with the same client ID: the computer returns
// the first attempt's receipt, or says it is still finishing it ("uncertain", retried as well).
const SEND_RETRY_MS = [2_000, 5_000] as const;
// A quick app switch keeps the link: a fresh relay join + handshake + resume takes seconds, and
// the OS freezes or kills a socket that is left longer than this anyway.
const BACKGROUND_GRACE_MS = 30_000;
// With the remote-control service the link outlives the background; a computer that stays away
// this long (shut down, asleep) ends it, so a phone in a pocket does not retry for hours.
const BACKGROUND_RETRY_MS = 5 * 60_000;
export interface LinkServiceText {
  title: string;
  body: string;
  /** Name of the notification channel in the system settings. */
  channel: string;
}
/** Android remote-control foreground service; absent elsewhere. */
export interface LinkService {
  onTick?(listener: () => void): () => void;
  wakeReady?(): Promise<boolean>;
  /** False when the OS refused (a start from the background, a missing permission). */
  start(text: LinkServiceText): Promise<boolean>;
  update(text: LinkServiceText): Promise<void>;
  stop(): Promise<void>;
  /** "wake": the short service for one on-demand request (push wake, follow-up task). */
  text(state: "online" | "reconnecting" | "wake", computerName: string): LinkServiceText;
}
/**
 * Calls / notifications follow native support and the local switch (system permission is
 * checked at read time). Accessibility (phone.ui) and Shizuku (phone.shell) have no operation
 * contract yet, so they stay unsupported whatever is saved or granted.
 */
function androidCapability(
  id: (typeof ANDROID_PHONE_CAPABILITIES)[number]["id"],
  version: number,
  key: (typeof ANDROID_PHONE_CAPABILITIES)[number]["key"],
  platform: "ios" | "android",
  support: { calls: boolean; notifications: boolean },
  prefs: { calls: boolean; notifications: boolean },
) {
  if (platform !== "android")
    return { id, version, availability: "unsupported" as const, reason: "unsupported_platform" };
  if (key === "ui" || key === "shell")
    return {
      id,
      version,
      availability: "unsupported" as const,
      reason: "operation_contract_pending",
    };
  if (!support[key])
    return { id, version, availability: "unsupported" as const, reason: "native_adapter_missing" };
  return {
    id,
    version,
    availability: prefs[key] ? ("available" as const) : ("local_switch_off" as const),
  };
}
/** This phone's data sources; absent ones answer "unsupported". */
export interface PhoneDataNative {
  readPages?: PhoneDataDeps["readPages"];
  appVersion?: string;
  platform: "ios" | "android";
  media?: PhoneMediaSource;
  sms?: PhoneSmsSource;
}
/** The link went away under the call; nothing about the message itself. */
function linkLost(error: unknown) {
  if (error instanceof RpcError) return error.code === RpcErrorCodes.closed;
  return error instanceof Error && (error.message === "offline" || error.name === "AbortError");
}
/** No answer in time, or the computer still finishing the same ID: worth the same ID again. */
function unsettled(error: unknown) {
  if (error instanceof RpcError)
    return (
      error.code === RpcErrorCodes.timeout ||
      (error.code === RpcErrorCodes.busy && error.message === "remote_message_uncertain")
    );
  return error instanceof Error && error.name === "TimeoutError";
}
const pauseFor = (signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
export class MobileRuntime {
  private state: MobileSnapshot = {
    ready: false,
    devices: [],
    pending: 0,
    delivered: [],
    uploads: {},
    revision: 0,
    refreshVersion: 0,
    skipped: 0,
    keepConnected: false,
    status: "offline",
    peer: null,
  };
  private listeners = new Set<() => void>();
  private session: MobileSession;
  private tail: Promise<unknown> = Promise.resolve();
  private flushing?: Promise<void>;
  private flushAgain = false;
  private candidate?: PairResult;
  private foreground = true;
  private disposed = false;
  private wakeUntil = 0;
  private wakeWork?: Promise<void>;
  private pushRegistration?: { token: string | null; language: "zh" | "en"; computerId: string };
  private wakeReads = 0;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private stopping?: Promise<void>;
  private pairAbort?: AbortController;
  private skipped = 0;
  private skipQueued = false;
  private aboutPeer?: MobilePeer;
  private resyncSeen = 0;
  private serviceOn = false;
  private serviceKey?: string;
  private serviceWork: Promise<void> = Promise.resolve();
  private offlineSince?: number;
  private language: "zh" | "en" = "en";
  /** How this phone reads what the computer sends (shared by every session). */
  readonly lenient = createLenient(() => this.noteSkip());
  constructor(
    readonly storage: MobileStorage,
    private readonly link: MobileLink,
    /** 0 suspends at once (the dev scenarios check that path). */
    private readonly backgroundGraceMs = BACKGROUND_GRACE_MS,
    /** The offline engine answers its own tool calls with the same native sources. */
    readonly phone: PhoneDataNative = { platform: "android" },
    private readonly linkService?: LinkService,
  ) {
    this.session = new MobileSession(
      link,
      storage,
      () => {
        const state = this.session.state;
        this.patch(state);
        // A resumed reconnect keeps every screen; one whose read the drop cut off reads again.
        if (state.resync !== undefined && state.resync !== this.resyncSeen) {
          this.resyncSeen = state.resync;
          if (state.resync > 0) this.refresh();
        }
        if (state.status === "online") {
          this.offlineSince = undefined;
          void this.flush();
          void this.checkAbout();
        } else if (state.status === "offline") this.offlineSince ??= Date.now();
        if (
          !this.foreground &&
          this.serviceOn &&
          state.status === "offline" &&
          Date.now() - (this.offlineSince ?? Date.now()) > BACKGROUND_RETRY_MS
        )
          void this.serial(async () => {
            if (!this.disposed && !this.foreground) await this.session.stop(true);
          }).catch(() => this.patch({ error: "uncertain" }));
        this.syncService();
      },
      (computer, connection, signal) => this.connected(computer, connection, signal),
      this.lenient,
    );
  }
  // One patch per burst: a list page can skip many items in one parse.
  private noteSkip() {
    this.skipped++;
    if (this.skipQueued) return;
    this.skipQueued = true;
    queueMicrotask(() => {
      this.skipQueued = false;
      this.patch({ skipped: this.skipped });
    });
  }
  /** Once per connection, ask the computer for its version and compatibility level. */
  private async checkAbout() {
    const computerId = this.state.selectedId;
    let current: ReturnType<MobileSession["current"]>;
    try {
      current = this.session.current();
    } catch {
      return; // Went offline already; the next connection asks again.
    }
    if (!computerId || this.aboutPeer === current.peer) return;
    this.aboutPeer = current.peer;
    let about: DesktopAbout = { computerId };
    try {
      const answer = await current.peer.call("app.about", undefined, {
        signal: current.signal,
        timeoutMs: 10_000,
      });
      about = {
        computerId,
        version: answer.version,
        level: answer.phoneCompat,
        platform: answer.platform,
      };
    } catch {
      if (current.signal.aborted) return;
      // A desktop older than the handshake refuses the method: unknown, no notice. A known answer
      // for the same computer survives a one-off failure (timeout) until the next connection.
      if (this.state.desktop?.computerId === computerId) return;
    }
    if (this.state.selectedId === computerId) this.patch({ desktop: about });
  }
  /**
   * Answers the computer's data calls for this session (foreground or the background grace;
   * the link ends after it) with this computer's switches, and tells it which are on.
   */
  private connected(computer: Computer, connection: LinkConnection, signal: AbortSignal) {
    const handler = phoneDataHandler({
      ...this.phone,
      prefs: () => readPhoneDataPrefs(this.storage.data, computer.id),
      localRevoked: () => this.localSwitches(computer.id),
      log: (entry) => appendPhoneDataLog(this.storage.data, computer.id, entry),
    });
    const off = connection.serve(async (...args) => {
      this.wakeReads++;
      try {
        return await handler(...args);
      } finally {
        this.wakeReads--;
        if (this.wakeUntil) this.wakeUntil = Date.now() + 60_000;
      }
    });
    void this.reportPhoneData(computer.id, connection, signal);
    // The computer keeps the last state per phone across sessions; say where this one starts.
    void connection
      .reportForeground?.(
        this.foreground,
        this.language,
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      )
      .catch(() => {
        /* An older computer or a lost session: the next session reports again. */
      });
    return off;
  }
  wake(id: string, signal: AbortSignal) {
    this.wakeWork ??= this.runWake(id, signal).finally(() => {
      this.wakeWork = undefined;
    });
    return this.wakeWork;
  }
  private async runWake(id: string, signal: AbortSignal) {
    if (!this.linkService || this.disposed) return;
    const device = this.state.devices.find((d) => d.id === id);
    if (!device) return;
    if (this.foreground) return;
    if (this.state.selectedId !== id) await this.select(id);
    await this.serviceWork;
    this.wakeUntil = Date.now() + 60_000;
    if (!this.serviceOn)
      this.serviceOn = await this.linkService.start(this.linkService.text("wake", ""));
    if (!this.serviceOn) {
      this.wakeUntil = 0;
      return;
    }
    clearTimeout(this.backgroundTimer);
    try {
      if (!this.session.running()) await this.session.start(device);
      else await this.session.resume();
      while (!signal.aborted && (this.wakeReads > 0 || Date.now() < this.wakeUntil)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 500);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally {
      this.wakeUntil = 0;
      try {
        if (!this.foreground && !this.state.keepConnected) await this.session.stop(true);
      } finally {
        this.syncService();
        await this.serviceWork;
      }
    }
  }
  /** Whether this build can keep the link in the background (Android local module present). */
  canKeepConnected() {
    return !!this.linkService;
  }
  async setKeepConnected(on: boolean) {
    if (!this.linkService) throw new Error("unsupported");
    await this.storage.data.put(KEEP_CONNECTED_KEY, on);
    this.patch({ keepConnected: on });
    this.syncService();
  }
  /** The UI language, for the computer's per-phone record (pushes are worded in it). */
  setLanguage(language: "zh" | "en") {
    this.language = language;
  }
  private reportForeground(foreground: boolean) {
    let current: ReturnType<MobileSession["current"]>;
    try {
      current = this.session.current();
    } catch {
      return; // Offline: the next session reports its state on connect.
    }
    void current.connection
      .reportForeground?.(
        foreground,
        this.language,
        AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]),
      )
      .catch(() => {
        /* Lost with the session; the next session reports again. */
      });
  }
  /**
   * The remote-control service runs while a paired computer's link is up or coming back. Android
   * only lets it start in the foreground; updates and the stop work from the background too.
   */
  private offServiceTick?: () => void;
  private syncService() {
    const service = this.linkService;
    if (!service) return;
    const device = this.state.devices.find((d) => d.id === this.state.selectedId);
    // A short lease must survive session.start() retiring the previous socket: its temporary
    // offline publication is not the end of the background service's ownership.
    const want =
      device && !this.disposed
        ? Date.now() < this.wakeUntil
          ? ("wake" as const)
          : this.state.keepConnected && this.session.running()
            ? this.state.status === "online"
              ? ("online" as const)
              : ("reconnecting" as const)
            : undefined
        : undefined;
    this.serviceWork = this.serviceWork
      .then(async () => {
        if (this.disposed) return;
        if (!want || !device) {
          if (!this.serviceOn) return;
          this.session.setNativeClock(false);
          this.offServiceTick?.();
          this.offServiceTick = undefined;
          this.serviceOn = false;
          this.serviceKey = undefined;
          await service.stop();
          reportLinkEvent("service_stopped");
          return;
        }
        const key = `${want}:${device.name}`;
        if (!this.serviceOn) {
          if (!this.foreground) return;
          this.serviceOn = await service.start(service.text(want, device.name));
          // stop() awaits this queue before stopping native; do not attach a late listener.
          if (this.disposed) return;
          this.serviceKey = this.serviceOn ? key : undefined;
          this.session.setNativeClock(
            this.serviceOn && !this.foreground && this.state.keepConnected,
          );
          if (this.serviceOn)
            this.offServiceTick = service.onTick?.(() => {
              if (!this.disposed && !this.foreground && this.serviceOn && this.state.keepConnected)
                this.session.backgroundTick();
            });
          reportLinkEvent(this.serviceOn ? "service_started" : "service_refused");
          return;
        }
        if (this.serviceKey === key) return;
        this.serviceKey = key;
        await service.update(service.text(want, device.name));
      })
      .catch(() => {
        this.offServiceTick?.();
        this.offServiceTick = undefined;
        this.session.setNativeClock(false);
        // Without the service the background grace applies; nothing else depends on it.
        this.serviceOn = false;
        this.serviceKey = undefined;
      });
  }
  // One counter per computer (the session keeps a spread copy of the connection, so the
  // object is no key). A newer report — a switch change or a new session — supersedes older ones
  // still waiting on prefs or the native probe, so a stale manifest is never sent after it.
  private readonly reportGenerations = new Map<string, number>();
  private async reportPhoneData(id: string, connection: LinkConnection, signal: AbortSignal) {
    const generation = (this.reportGenerations.get(id) ?? 0) + 1;
    this.reportGenerations.set(id, generation);
    const latest = () => !signal.aborted && this.reportGenerations.get(id) === generation;
    try {
      const prefs = await readPhoneDataPrefs(this.storage.data, id);
      if (!latest()) return;
      // A probe failure must not withhold the whole manifest: it only reports that kind unsupported.
      const supported = (kind: "calls" | "notifications") =>
        this.phone.platform === "android" && this.phone.readPages
          ? this.phone.readPages.supported(kind, signal).catch(() => false)
          : Promise.resolve(false);
      const calls = await supported("calls");
      if (!latest()) return;
      const notifications = await supported("notifications");
      if (!latest()) return;
      const support = { calls, notifications };
      await connection.reportPhoneData(
        {
          ...(connection.supportsEndpointCapabilities?.()
            ? {
                manifest: {
                  endpointKind: "phone" as const,
                  platform: this.phone.platform,
                  appVersion: this.phone.appVersion ?? "unknown",
                  capabilities: [
                    ...ANDROID_PHONE_CAPABILITIES.map(({ id, version, key }) =>
                      androidCapability(id, version, key, this.phone.platform, support, prefs),
                    ),
                    {
                      id: "phone.media",
                      version: 1,
                      availability: !this.phone.media
                        ? ("unsupported" as const)
                        : prefs.media
                          ? ("available" as const)
                          : ("local_switch_off" as const),
                    },
                    {
                      id: "phone.sms",
                      version: 1,
                      availability:
                        this.phone.platform !== "android" || !this.phone.sms
                          ? ("unsupported" as const)
                          : prefs.smsCode
                            ? ("available" as const)
                            : ("local_switch_off" as const),
                    },
                  ],
                },
              }
            : {}),
          platform: this.phone.platform,
          media: prefs.media,
          smsCode: prefs.smsCode && this.phone.platform === "android",
        },
        AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      );
    } catch {
      // Modern sessions remain denied without an accepted enabled list; retry on reconnect or switch change.
    }
  }
  private readonly localRevocations = new Map<string, AbortController>();
  private localSwitches(computerId: string) {
    const current = this.localRevocations.get(computerId) ?? new AbortController();
    this.localRevocations.set(computerId, current);
    return current.signal;
  }
  /** The phone-data page changed a switch: show it on the computer now. */
  phoneDataChanged(computerId: string) {
    const push = this.pushRegistration;
    if (push?.computerId === computerId)
      void this.registerPush(push.token, push.language, computerId).catch(() => {
        // Local switch checks remain authoritative if the connection was lost before reporting.
      });
    // In-flight reads started under the old switches are revoked before anything else.
    // The transport is invalidated too, without waiting for the new manifest's native probe.
    this.localRevocations.get(computerId)?.abort();
    this.localRevocations.delete(computerId);
    if (computerId !== this.state.selectedId || this.state.status !== "online") return;
    try {
      const { connection, signal } = this.session.current();
      connection.invalidatePhoneReads?.();
      void this.reportPhoneData(computerId, connection, signal);
    } catch {
      // Went offline meanwhile; the next session reports on connect.
    }
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private patch(value: Partial<MobileSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value, revision: this.state.revision + 1 };
    for (const fn of this.listeners) fn();
  }
  private serial<T>(fn: () => Promise<T>) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => undefined); // Caller reports a fixed error; keep the mutation lane usable.
    return work;
  }
  async initialize() {
    const devices = await this.storage.computers();
    if (this.disposed) return;
    // Before any composer or share can create new copies; an unreadable outbox keeps every file.
    await this.storage.sweepShare().catch(() => undefined);
    const keepConnected =
      (await this.storage.data.get(KEEP_CONNECTED_KEY).catch(() => false)) === true;
    this.patch({ devices, ready: true, keepConnected: !!this.linkService && keepConnected });
    if (devices[0]) await this.select(devices[0].id);
  }
  select(id: string) {
    return this.serial(async () => {
      await this.session.stop();
      await this.flushing;
      await this.activateComputer(id);
    });
  }
  reconnect(id: string) {
    return this.serial(async () => {
      const device = this.state.devices.find((item) => item.id === id);
      if (!device || this.disposed || !this.foreground) return;
      if (id !== this.state.selectedId) {
        await this.session.stop();
        await this.flushing;
        await this.activateComputer(id);
      } else if (this.session.running() && this.state.error !== "unavailable")
        this.session.reconnectNow();
      else await this.session.start(device);
    });
  }
  private async activateComputer(id: string) {
    const device = this.state.devices.find((d) => d.id === id);
    if (!device || this.disposed) return;
    const same = this.state.desktop?.computerId === id;
    // What was skipped and what the handshake said belong to the computer they came from.
    if (!same) this.skipped = 0;
    this.patch({
      selectedId: id,
      desktop: same ? this.state.desktop : undefined,
      skipped: this.skipped,
      pending: (await this.storage.outbox(id)).length,
      delivered: [],
      uploads: {},
      failed: undefined,
    });
    // Before the first screens render (the provider waits for initialize): they open with the
    // last list and approvals instead of a blank state while the link comes up.
    await this.warm(id);
    if (!this.disposed && this.foreground) await this.session.start(device);
  }
  /** Proposal 10: reads the copies the first screens show into the phone store's memory. */
  private async warm(id: string) {
    const store = this.storage.store;
    const [rows] = await Promise.all([
      store.read(storeKeys.conversations(id), CachedConversationsSchema),
      store.read(storeKeys.approvals(id), StoredApprovalsSchema),
    ]).catch(() => [undefined]);
    // The newest chats' topic lists now, their messages right after (not on the start path), so
    // opening one of them shows its thread in the first frame.
    const recent = (rows ?? []).slice(0, WARM_CHATS);
    const topics = await Promise.all(
      recent.map((row) =>
        store
          .read(storeKeys.topics(id, row.kind, row.id), StoredTopicsSchema)
          .then((copy) => ({ row, topicId: copy?.current ?? row.topicId }))
          .catch(() => ({ row, topicId: undefined })),
      ),
    );
    void (async () => {
      for (const { row, topicId } of topics) {
        if (!topicId || this.state.selectedId !== id || this.disposed) return;
        const target = scopeTarget({ kind: row.kind, id: row.id, topicId });
        await store.history(id, JSON.stringify(target)).catch(() => []);
      }
    })();
  }
  networkChanged() {
    return this.serial(async () => {
      // Also while stopped (background): the session forgets direct failures of the old network.
      if (!this.disposed) await this.session.networkChanged();
    });
  }
  setForeground(active: boolean) {
    if (this.foreground === active) return Promise.resolve();
    this.foreground = active;
    this.session.setNativeClock(!active && this.serviceOn && this.state.keepConnected);
    this.reportForeground(active);
    if (!active && this.backgroundGraceMs <= 0) {
      this.cancelPair();
      return this.serial(async () => {
        if (!this.disposed) await this.session.stop(true);
      });
    }
    if (!active) {
      this.cancelPair();
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
      // The remote-control service keeps the process (and so the link) alive in the background.
      if (this.serviceOn) return Promise.resolve();
      this.backgroundTimer = setTimeout(() => {
        this.backgroundTimer = undefined;
        void this.serial(async () => {
          if (!this.disposed && !this.foreground) await this.session.stop(true);
        }).catch(() => {
          // Only an unconfirmed outbox drain fails here; the next start reports it the same way.
          this.patch({ error: "uncertain" });
        });
      }, this.backgroundGraceMs);
      return Promise.resolve();
    }
    const kept = this.backgroundTimer !== undefined || this.serviceOn;
    clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
    this.syncService();
    return this.serial(async () => {
      if (this.disposed) return;
      // Still linked (or retrying) after the background: probe a link that reads online (the OS
      // may have frozen it) and cut a retry backoff short, instead of tearing everything down.
      if (kept && this.session.running()) {
        void this.session.resume().then(() => {
          if (this.state.status === "online") void this.flush();
        });
        return;
      }
      const device = this.state.devices.find((d) => d.id === this.state.selectedId);
      if (!device) return;
      this.session.markResume();
      await this.session.start(device);
    });
  }
  async preparePair(qr: string, name: string) {
    this.cancelPair();
    if (
      !this.foreground ||
      qr.length > 8192 ||
      !name.trim() ||
      name.length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(name)
    )
      throw new Error("invalid");
    const abort = new AbortController();
    this.pairAbort = abort;
    const candidate = await this.link.pair(
      qr,
      name.trim(),
      AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    );
    if (abort.signal.aborted || this.pairAbort !== abort || this.disposed)
      throw new Error("cancelled");
    ComputerSchema.parse(candidate.computer);
    this.candidate = candidate;
    return candidate.computer;
  }
  cancelPair() {
    this.pairAbort?.abort();
    this.pairAbort = undefined;
    this.candidate = undefined;
  }
  async savePair() {
    const candidate = this.candidate;
    if (!candidate || !this.foreground) throw new Error("invalid");
    await this.storage.savePair(candidate);
    this.cancelPair();
    this.patch({ devices: await this.storage.computers() });
    await this.select(candidate.computer.id);
  }
  forget(id: string) {
    this.localRevocations.get(id)?.abort();
    this.localRevocations.delete(id);
    // Like a switch change: cut in-flight phone reads at the transport now, before the queued
    // stop() runs, or a read that already passed its last check could still send its page.
    // A pending manifest report for this computer must not land after the unpair.
    this.reportGenerations.set(id, (this.reportGenerations.get(id) ?? 0) + 1);
    if (id === this.state.selectedId) {
      try {
        this.session.current().connection.revokePhoneReads?.();
      } catch {
        // No live session: nothing in flight to revoke.
      }
    }
    // reportGenerations stays: restarting the counter could let a stale report match again.
    return this.serial(async () => {
      const wasSelected = id === this.state.selectedId;
      if (wasSelected) {
        try {
          await this.session.stop();
        } catch {
          // Local revocation must survive transport cleanup failures; deleting credentials
          // does not settle or retry any business operation whose result is uncertain.
          this.patch({ error: "uncertain" });
        }
        await this.flushing;
        this.patch({
          selectedId: undefined,
          desktop: undefined,
          peer: null,
          pending: 0,
          delivered: [],
          uploads: {},
          failed: undefined,
        });
      }
      await this.storage.forget(id);
      this.session.forget(id);
      const devices = await this.storage.computers();
      this.patch({ devices });
      // Devices shows the first remaining computer after removal, so its link must own the tab
      // immediately. Stay inside the same serialized switch while loading its local snapshot.
      if (wasSelected && devices[0]) await this.activateComputer(devices[0].id);
    });
  }
  async call<K extends keyof typeof Methods>(
    method: K,
    params: MethodParams[K],
    signal?: AbortSignal,
    // Restores and compaction legitimately outlast an ordinary read.
    timeoutMs = 20_000,
  ): Promise<MethodResults[K]> {
    // Event-driven reloads may still land during the background grace; the link is up then.
    if (!this.foreground && this.backgroundTimer === undefined) throw new Error("offline");
    const { peer, signal: sessionSignal } = this.session.current();
    return peer.call(method, params, {
      signal: AbortSignal.any([sessionSignal, ...(signal ? [signal] : [])]),
      timeoutMs,
    }) as Promise<MethodResults[K]>;
  }
  /**
   * `files`: shared or attached files already copied into the share store.
   * Once this resolves the outbox owns them; on a refusal they still belong to the caller.
   */
  async send(target: ChatTarget, text: string, mentions?: string[], files?: PendingFile[]) {
    const computerId = this.state.selectedId;
    if (!computerId) throw new Error("offline");
    const message = PendingSchema.parse({
      clientId: crypto.randomUUID(),
      computerId,
      target,
      text,
      mentions: mentions?.length && target.groupId && !target.threadId ? mentions : undefined,
      files: files?.length ? files : undefined,
      createdAt: new Date().toISOString(),
    });
    await this.storage.enqueue(message);
    const pending = (await this.storage.outbox(computerId)).length;
    if (this.state.selectedId === computerId) this.patch({ pending });
    void this.flush();
  }
  private flush() {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushAgain = false;
    let again = false;
    this.flushing = this.drainOutbox()
      .then((outcome) => {
        // A drain the link cut short (path switch, drop) goes on as soon as the link is back,
        // in order; one stopped by a refusal waits for the owner's retry.
        again = outcome === "done" || outcome === "lost";
      })
      .finally(() => {
        this.flushing = undefined;
        if (again && this.flushAgain && this.foreground && this.state.status === "online")
          void this.flush();
      });
    return this.flushing;
  }
  private async drainOutbox(): Promise<"done" | "lost" | "stopped" | undefined> {
    const id = this.state.selectedId;
    if (!id || !this.foreground || this.state.status !== "online") return;
    let current: string | undefined;
    let session: AbortSignal | undefined;
    if (this.state.failed) this.patch({ failed: undefined });
    try {
      const { connection, signal } = this.session.current();
      session = signal;
      for (const message of await this.storage.outbox(id)) {
        signal.throwIfAborted();
        if (this.state.selectedId !== id) return;
        current = message.clientId;
        // Files go up first, in this session; a retry uploads again (same content).
        const attachmentIds: string[] = [];
        const total = (message.files ?? []).reduce((sum, file) => sum + file.bytes, 0);
        let done = 0;
        for (const file of message.files ?? []) {
          if (!this.storage.share) throw new Error("share_unavailable");
          attachmentIds.push(
            await uploadShared(
              connection,
              this.storage.share,
              file,
              AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
              (bytes) => this.progress(message.clientId, (done + bytes) / total),
            ),
          );
          done += file.bytes;
        }
        const receipt = this.lenient(Methods["chat.send"].result).parse(
          await this.sendWithRetry(message, connection, signal, attachmentIds),
        );
        if (
          receipt.conversationId !== message.target.topicId ||
          receipt.groupId !== message.target.groupId ||
          receipt.threadId !== message.target.threadId
        )
          throw new Error("receipt_scope_changed");
        // An accepted receipt may outlive local cancellation; acknowledge only this exact ID.
        await this.storage.acknowledge(id, message.clientId);
        current = undefined;
        if (this.state.selectedId === id) {
          const { [message.clientId]: _sent, ...uploads } = this.state.uploads;
          this.patch({
            pending: (await this.storage.outbox(id)).length,
            uploads,
            delivered: [
              ...this.state.delivered.slice(-19),
              {
                ...message,
                userMessageId: receipt.userMessageId,
                // The replies this send started: drawn after its bubble until history has both.
                runIds: [receipt.runId, ...(receipt.runs?.map((run) => run.runId) ?? [])],
              },
            ],
          });
          setTimeout(() => this.settle(message.clientId), DELIVERED_MS);
        }
      }
      return "done";
    } catch (error) {
      // Unknown acceptance keeps the same durable clientId. The next drain or the owner's retry
      // sends it again; the gateway's receipt makes a repeat return the original.
      const lost = !!session?.aborted || this.state.status !== "online" || linkLost(error);
      if (this.state.selectedId === id) {
        const uploads = { ...this.state.uploads };
        if (current) delete uploads[current];
        // Proposal 5: a send the link cut short is still 待发送, not "not sent"; today's lost
        // sends were marked failed in the gap of a path switch and then waited for a tap.
        this.patch(lost ? { uploads } : { error: "uncertain", failed: current, uploads });
      }
      return lost ? "lost" : "stopped";
    }
  }
  /**
   * Each attempt on the link as it is now (a path switch replaces the connection). Messages with
   * files are not repeated here: their uploads belong to the attempt, the next drain sends again.
   */
  private async sendWithRetry(
    message: PendingMessage,
    first: LinkConnection,
    signal: AbortSignal,
    attachmentIds: string[],
  ) {
    for (let attempt = 0; ; attempt++) {
      const connection = attempt ? this.session.current().connection : first;
      try {
        return await connection.send(
          message,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          attachmentIds,
        );
      } catch (error) {
        const delay = SEND_RETRY_MS[attempt];
        if (signal.aborted || delay === undefined || message.files?.length || !unsettled(error))
          throw error;
        await pauseFor(signal, delay);
      }
    }
  }
  private progress(clientId: string, share: number) {
    if (this.state.uploads[clientId] === share) return;
    this.patch({ uploads: { ...this.state.uploads, [clientId]: share } });
  }
  /** The owner retries the outbox message the last drain stopped at. */
  retry() {
    if (this.state.failed) this.patch({ failed: undefined, error: undefined });
    return this.flush();
  }
  /**
   * Removes a pending message that keeps failing (and its file copies). Only the stopped one, and
   * not mid-drain: a message being uploaded or sent right now cannot be taken back.
   */
  discard(clientId: string) {
    return this.serial(async () => {
      const id = this.state.selectedId;
      if (!id || this.state.failed !== clientId || this.flushing) throw new Error("busy");
      await this.storage.acknowledge(id, clientId);
      this.patch({ failed: undefined, pending: (await this.storage.outbox(id)).length });
    });
  }
  private settle(clientId: string) {
    if (this.state.delivered.some((m) => m.clientId === clientId))
      this.patch({ delivered: this.state.delivered.filter((m) => m.clientId !== clientId) });
  }
  /** Hands the computer this phone's Expo push token, or null to make it stop pushing here. */
  async registerPush(token: string | null, language: "zh" | "en", computerId: string) {
    if (computerId !== this.state.selectedId || !this.foreground) throw new Error("offline");
    if (token !== null && !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,200}\]$/.test(token))
      throw new Error("invalid");
    const { connection, signal } = this.session.current();
    const prefs = await readPhoneDataPrefs(this.storage.data, computerId);
    const registered = (await this.linkService?.wakeReady?.()) ?? false;
    this.pushRegistration = { token, language, computerId };
    await connection.setPushToken(
      token,
      language,
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      registered &&
        !!this.linkService &&
        token !== null &&
        (prefs.media || prefs.smsCode || prefs.calls || prefs.notifications),
    );
  }
  refresh() {
    this.patch({ refreshVersion: this.state.refreshVersion + 1 });
  }
  dispose() {
    this.stopping ??= this.stop();
    return this.stopping;
  }
  private async stop() {
    this.disposed = true;
    this.offServiceTick?.();
    this.offServiceTick = undefined;
    clearTimeout(this.backgroundTimer);
    this.cancelPair();
    await this.session.stop();
    this.serviceOn = false;
    await this.serviceWork;
    await this.linkService?.stop().catch(() => {
      /* The module's own teardown stops it with the React context. */
    });
    await this.tail;
    await this.flushing;
    await this.storage.settled();
    await this.storage.data.close();
    this.listeners.clear();
  }
}
