import type { DirectFailure, PathByeReason } from "@pibot/link";
import { createPeer, Events, type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { z } from "zod";
import type { MobileStorage } from "../storage/state.ts";
import { readCredential, sanitizeLanAddresses, withLanAddresses } from "./credential.ts";
import { reportLinkEvent, reportLinkFailure } from "./diagnostics.ts";
import { createLenient, type Lenient, lenientEvents, lenientMethods } from "./lenient.ts";
import type { Computer, LinkConnection, MobileLink } from "./link-port.ts";
import { PhoneMethods } from "./phone-methods.ts";
import { type StreamPort, streamPort } from "./stream-port.ts";

export type MobilePeer = ReturnType<typeof createPeer<typeof PhoneMethods, typeof Events>>;
export type ConnectionStatus = "offline" | "connecting" | "online" | "suspended";
export interface SessionState {
  status: ConnectionStatus;
  path?: "direct" | "relay" | "lan";
  /** Where a WebRTC direct path runs (LinkConnection.pathKind); absent otherwise. */
  pathKind?: "lan" | "punched";
  peer: MobilePeer | null;
  error?: string;
  directFailure?: DirectFailure;
  /** A link that was online dropped and is coming back: "reconnecting", not "offline". */
  reconnecting?: boolean;
  /** When the selected computer was last reachable (epoch ms), shown while it is offline. */
  lastSeen?: number;
  /**
   * Bumped when a resumed reconnect cut off a request: the screens keep their Peer (no reload)
   * but the one that lost its answer must read again (the runtime turns it into a refresh).
   */
  resync?: number;
}
/**
 * One desktop event stream and the business Peer over it. It outlives connections: a reconnect
 * (or path change) that resumes it keeps the same Peer, so screens neither resubscribe nor
 * reload; a stream that cannot be resumed gets a new Peer, which makes every screen reload.
 */
interface Stream {
  computerId: string;
  /** `stream:<desktop id>` from devices.self, else the link's own epoch (older desktops). */
  epoch: string;
  port: StreamPort;
  peer: MobilePeer;
}
/**
 * After a drop the UI says "reconnecting" this long before it admits the computer is offline
 * (maintainers 2026-11-14: an unreachable computer is a calm status, not an endless "connecting").
 */
const RECONNECT_WINDOW_MS = 10_000;
/**
 * The longest a phone-side drop keeps chats with the computer while reconnecting (v0.0.2 round 3:
 * a 37 s reconnect after a network change flipped the thread to offline mode). Bounded, so a
 * computer that quit while the phone could reach its model but not the relay still hands over.
 */
const PHONE_RECONNECT_MAX_MS = 120_000;
/**
 * The first attempt after a start or a return to the app gets this grace. A known phone-side
 * drop instead keeps reconnecting until the computer is confirmed absent. v0.0.2 phone test: back from 40 s in the
 * background the relay socket alone took 4 s; at 10 s the thread flipped to the phone's model
 * although the computer was there all along.
 */
const PHONE_SIDE_WINDOW_MS = 20_000;
/** A first connect that is not up by then is shown offline while the attempt goes on quietly. */
const QUIET_AFTER_MS = 6_000;
/**
 * While the computer is known to be away, each quiet attempt waits this long in the relay room,
 * so its return is noticed the moment it joins instead of at the next backoff step.
 */
const AWAY_WAIT_MS = 50_000;
/**
 * Why a live link ended that means the computer itself left (not this phone's network). Not
 * `peer_left`: the relay says that too when the computer gave up on a phone the OS had frozen
 * (v0.0.2: every return after 40 s in the background showed the computer offline). A computer
 * that really quit is found absent by the next attempt (room_empty) within seconds.
 */
const COMPUTER_GONE = new Set(["peer_user"]);
/**
 * After a direct path failed to bind, new sessions to that computer stay on the relay this long.
 * Phone log 2026-11-14: every reconnect tried direct again and lost about 10 s each time.
 */
const DIRECT_PAUSE_MS = 30 * 60_000;
const presenceKey = (computerId: string) => `cache:${computerId}:presence`;
const PresenceSchema = z.object({
  away: z.boolean(),
  lastSeen: z.number().int().nonnegative().optional(),
});
type Presence = z.infer<typeof PresenceSchema>;
const SelfSchema = z.object({
  id: z.uuid(),
  name: z.string().max(200),
  lanAddresses: z.unknown().optional(),
  interactive: z.enum(["available", "quit"]).optional(),
  eventStream: z
    .object({ id: z.string().min(16).max(64), seq: z.number().int().nonnegative().safe() })
    .optional(),
});
/** What events.resume returned; undefined when the desktop no longer has the gap. */
type MissedEvents = MethodResults["events.resume"] | undefined;
// A JS timer that fires far later than scheduled means the OS froze the app (background limits).
const FREEZE_TICK_MS = 10_000;
const FREEZE_GAP_MS = 25_000;
// Resume probes and time-to-usable only mean something shortly after returning to the app.
const RESUME_MEASURE_MS = 120_000;
const pause = (signal: AbortSignal, ms: number) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

export class MobileSession {
  state: SessionState = { status: "offline", peer: null };
  private lifetime?: AbortController;
  private loop?: Promise<void>;
  private connection?: LinkConnection;
  private wake = new AbortController();
  private round?: AbortController;
  private stream?: Stream;
  /** The current session (all its paths); aborts when it ends. */
  private sessionClosed?: AbortSignal;
  private resyncs = 0;
  /** Per process: how connects went (logged with each, so a log excerpt shows the ratio). */
  private refreshes = { resumed: 0, full: 0 };
  /** Why the owner stopped the loop (logged as the close reason, announced to the computer). */
  private stopReason?: { reason: string; bye: PathByeReason };
  private lastTick = Date.now();
  private frozenAt?: number;
  /** The last session ended because of this phone (frozen, network change), not the computer. */
  private phoneSideDrop = false;
  private resumeAt?: number;
  /** The selected computer is known unreachable: attempts go on quietly, the UI says offline. */
  private away = false;
  private lastSeen?: number;
  private lastError?: string;
  private computerId?: string;
  private quietTimer?: ReturnType<typeof setTimeout>;
  /** Per computer, so a stop/start (background, reselect) keeps what this process learned. */
  private presence = new Map<string, Presence>();
  /** Per computer: until when direct upgrades are skipped (epoch ms); cleared on a new network. */
  private directPausedUntil = new Map<string, number>();
  private network = 0;
  // Everything the desktop answers or emits may come from a newer desktop.
  private readonly methods: typeof PhoneMethods;
  private readonly events: typeof Events;
  constructor(
    private readonly link: MobileLink,
    private readonly storage: MobileStorage,
    private readonly changed: () => void,
    /** Per-session wiring (answering the computer's calls); returns its cleanup. */
    private readonly connected?: (
      computer: Computer,
      connection: LinkConnection,
      signal: AbortSignal,
    ) => () => void,
    lenient: Lenient = createLenient(),
  ) {
    this.methods = lenientMethods(PhoneMethods, lenient);
    this.events = lenientEvents(Events, lenient);
  }
  private publish(state: SessionState) {
    // Explicit keys: the runtime merges snapshots, and an absent key would keep a stale value.
    this.state = {
      ...state,
      pathKind: state.pathKind,
      directFailure: state.directFailure,
      reconnecting: state.reconnecting,
      lastSeen: this.lastSeen,
      resync: this.resyncs,
    };
    this.changed();
  }
  /**
   * The Peer screens keep while a stream may still resume (reconnecting, in the background), so a
   * short drop or an app switch does not reload them; offline drops it as before.
   */
  private kept() {
    return this.stream?.computerId === this.computerId ? (this.stream?.peer ?? null) : null;
  }
  private dropStream() {
    const stream = this.stream;
    this.stream = undefined;
    stream?.peer.dispose();
  }
  private openStream(computerId: string, epoch: string) {
    this.dropStream();
    const port = streamPort();
    const peer = createPeer(port.port, { methods: this.methods, events: this.events });
    this.stream = { computerId, epoch, port, peer };
    return this.stream;
  }
  private offlineState(): SessionState {
    return { status: "offline", peer: null, error: this.lastError };
  }
  /** The computer is not reachable now: say so calmly; the run loop keeps trying quietly. */
  private goAway() {
    if (!this.away) {
      this.away = true;
      this.savePresence();
      reportLinkEvent("computer_away", { reason: this.lastError ?? "slow_connect" });
    }
    this.publish(this.offlineState());
  }
  private reachable() {
    this.away = false;
    this.lastError = undefined;
    this.lastSeen = Date.now();
    this.savePresence();
  }
  private savePresence() {
    const id = this.computerId;
    if (!id) return;
    const value: Presence = { away: this.away, lastSeen: this.lastSeen };
    this.presence.set(id, value);
    void this.storage.data.put(presenceKey(id), value).catch(() => {
      /* A hint for the next app start only; the live state is already published. */
    });
  }
  private async loadPresence(id: string) {
    this.computerId = id;
    this.lastError = undefined;
    let value = this.presence.get(id);
    if (!value) {
      const stored = PresenceSchema.safeParse(
        await this.storage.data.get(presenceKey(id)).catch(() => undefined),
      );
      // A new process keeps only when it was last seen: "away" from an earlier run would show the
      // computer offline (and hand chats to the phone's model) before this run tried it once.
      value = { away: false, lastSeen: stored.success ? stored.data.lastSeen : undefined };
      this.presence.set(id, value);
    }
    this.away = value.away;
    this.lastSeen = value.lastSeen;
  }
  private nativeClock = false;
  setNativeClock(active: boolean) {
    if (this.nativeClock === active) return;
    if (active) this.lastTick = Date.now();
    // Preserve the last native tick on return: a genuinely stalled JS context must stay visible.
    this.nativeClock = active;
    this.connection?.setExternalClock?.(active);
  }
  private tick = () => {
    const now = Date.now();
    if (now - this.lastTick > FREEZE_GAP_MS) {
      this.frozenAt = now;
      reportLinkEvent("phone_frozen", { gapMs: now - this.lastTick });
    }
    this.lastTick = now;
  };
  backgroundTick() {
    this.tick();
    this.connection?.pulse?.();
  }
  /** The close came right after (or is noticed before the ticker saw) an OS freeze. */
  private frozenRecently() {
    const now = Date.now();
    return (
      now - this.lastTick > FREEZE_GAP_MS ||
      (this.frozenAt !== undefined && now - this.frozenAt < 15_000)
    );
  }
  private usable(mode: "kept" | "reconnected", path?: string) {
    const at = this.resumeAt;
    this.resumeAt = undefined;
    if (at === undefined || Date.now() - at > RESUME_MEASURE_MS) return;
    reportLinkEvent("resume_usable", { mode, ms: Date.now() - at, ...(path ? { path } : {}) });
  }
  /** Time to usable is measured from now (a resume that restarts the link from scratch). */
  markResume() {
    this.resumeAt = Date.now();
  }
  /**
   * Back in the foreground: a link that still reads online gets one liveness round trip (a link
   * the OS froze is given up at once instead of after the dead timer); a link waiting out a retry
   * backoff reconnects now. Time to usable is logged either way.
   */
  async resume() {
    this.resumeAt = Date.now();
    this.tick();
    const connection = this.connection;
    if (this.state.status === "online" && connection?.probe) {
      const ok = await connection.probe(3000);
      reportLinkEvent("resume_probe", { ok: ok ? 1 : 0, ms: Date.now() - this.resumeAt });
      if (ok) {
        connection.refreshLan?.();
        this.usable("kept", this.state.path);
      }
      return;
    }
    if (this.state.status === "online") this.usable("kept", this.state.path);
    else this.wake.abort();
  }
  async start(computer: Computer) {
    // A running loop is restarted from scratch; after a background stop the stream stays, so the
    // return to the app resumes it (and its screens) instead of reloading them.
    if (this.running()) await this.stop();
    else await this.loop;
    if (this.stream?.computerId !== computer.id) this.dropStream();
    await this.loadPresence(computer.id);
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    this.loop = this.run(computer, lifetime.signal).catch((error) => {
      reportLinkFailure(error, "session");
      this.publish({ status: "offline", peer: null, error: "busy" });
    });
  }
  async stop(suspended = false) {
    if (this.lifetime && !this.lifetime.signal.aborted) {
      this.stopReason ??= suspended
        ? { reason: "app_backgrounded", bye: "background" }
        : { reason: "user_stop", bye: "user" };
      // Announce first: aborting the lifetime closes the paths before the loop could say why.
      void this.connection?.close(this.stopReason.bye).catch(() => {
        /* The loop's own close below owns the drain result. */
      });
    }
    this.lifetime?.abort();
    if (!suspended) this.dropStream();
    const state = () =>
      suspended
        ? { status: "suspended" as const, peer: this.kept() }
        : { status: "offline" as const, peer: null };
    this.publish(state());
    try {
      await this.loop;
    } finally {
      this.stopReason = undefined;
    }
    this.publish(state());
    this.loop = undefined;
    this.lifetime = undefined;
  }
  reconnectNow() {
    if (this.state.status === "online") return;
    this.away = false;
    this.lastError = undefined;
    this.markResume();
    clearTimeout(this.quietTimer);
    this.wake.abort();
    this.round?.abort();
  }
  /** Connected or still trying; false once stopped. */
  running() {
    return !!this.lifetime && !this.lifetime.signal.aborted;
  }
  forget(id: string) {
    if (this.stream?.computerId === id) this.dropStream();
    this.presence.delete(id);
    this.directPausedUntil.delete(id);
  }
  async networkChanged() {
    // A direct path that could not bind on the old network may well work on this one.
    this.directPausedUntil.clear();
    this.network++;
    this.phoneSideDrop = true;
    if (!this.running()) return;
    this.wake.abort();
    if (this.connection?.networkChanged) await this.connection.networkChanged();
    else this.round?.abort();
  }
  current() {
    if (this.state.status !== "online" || !this.connection || !this.lifetime)
      throw new Error("offline");
    return {
      connection: this.connection,
      peer: this.state.peer as MobilePeer,
      // The whole session, not this path: the Peer survives a path switch and holds the calls
      // made during it (stream-port.ts). Path-bound calls on `connection` add their own path.
      signal: this.sessionClosed
        ? AbortSignal.any([this.lifetime.signal, this.sessionClosed])
        : this.lifetime.signal,
    };
  }
  private async run(computer: Computer, signal: AbortSignal) {
    let attempt = 0;
    let droppedAt: number | undefined;
    const startedAt = Date.now();
    let window = RECONNECT_WINDOW_MS;
    let phoneReconnect = false;
    const reconnecting = () =>
      !this.away &&
      droppedAt !== undefined &&
      Date.now() - droppedAt < (phoneReconnect ? PHONE_RECONNECT_MAX_MS : window);
    this.lastTick = Date.now();
    const ticker = setInterval(() => {
      if (!this.nativeClock) this.tick();
    }, FREEZE_TICK_MS);
    try {
      while (!signal.aborted) {
        this.wake = new AbortController();
        const wake = this.wake.signal;
        const round = new AbortController();
        this.round = round;
        const quiet = this.away;
        if (quiet) this.publish(this.offlineState());
        else {
          const again = reconnecting();
          this.publish({ status: "connecting", peer: this.kept(), reconnecting: again });
          // An attempt that hangs (a dead relay socket) must not keep the spinner up either. The
          // first attempt of a start (cold start, back from the background) gets the longer
          // window: until it resolves the chats stay with the computer and sends wait in the
          // outbox instead of going to the phone's own model.
          const first = droppedAt === undefined && attempt === 0;
          const deadline =
            again && droppedAt !== undefined
              ? droppedAt + (phoneReconnect ? PHONE_RECONNECT_MAX_MS : window)
              : first
                ? Math.max(startedAt, this.resumeAt ?? startedAt) + PHONE_SIDE_WINDOW_MS
                : Date.now() + QUIET_AFTER_MS;
          this.quietTimer = setTimeout(
            () => {
              if (
                !signal.aborted &&
                this.state.status === "connecting" &&
                !(
                  phoneReconnect &&
                  droppedAt !== undefined &&
                  Date.now() - droppedAt < PHONE_RECONNECT_MAX_MS
                )
              )
                this.goAway();
            },
            Math.max(0, deadline - Date.now()),
          );
        }
        let dropped = false;
        let absent = false;
        try {
          dropped = await this.once(
            computer,
            AbortSignal.any([signal, round.signal]),
            quiet ? AWAY_WAIT_MS : undefined,
          );
          attempt = 0;
          if (dropped && !this.away) {
            droppedAt = Date.now();
            // A slow phone network is not evidence that the computer left. Keep queued sends
            // visible until the relay reports room_empty or the desktop explicitly quits.
            phoneReconnect = this.phoneSideDrop;
            window = this.phoneSideDrop ? PHONE_SIDE_WINDOW_MS : RECONNECT_WINDOW_MS;
          }
          this.phoneSideDrop = false;
        } catch (error) {
          if (signal.aborted) break;
          // A network change or a manual retry cut this attempt short.
          if (round.signal.aborted) continue;
          const failure = reportLinkFailure(error, "session");
          const unavailable = error instanceof Error && error.message === "link_unavailable";
          if (unavailable) {
            this.publish({ status: "offline", peer: null, error: "unavailable" });
            return;
          }
          this.lastError = failure;
          // The relay answered and the computer is not in the room: that is definite.
          absent = failure === "room_empty";
          // Otherwise (likely this phone's network) inside the window: keep saying "reconnecting".
          if (reconnecting() && !absent)
            this.publish({ status: "connecting", peer: this.kept(), reconnecting: true });
          else this.goAway();
        } finally {
          clearTimeout(this.quietTimer);
        }
        if (signal.aborted) break;
        // A link that was online comes back at once: the first retry after a drop has no wait.
        if (wake.aborted || dropped) {
          attempt = 0;
          continue;
        }
        try {
          await pause(
            AbortSignal.any([signal, wake]),
            // The wait in the room already paced an attempt that found the computer away.
            quiet && absent ? 1000 : Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)),
          );
        } catch {
          if (signal.aborted) break;
          attempt = 0;
        } // Parent cancellation ends the reconnect loop.
      }
    } finally {
      clearInterval(ticker);
    }
  }
  private async missed(stream: Stream, after: number, signal: AbortSignal): Promise<MissedEvents> {
    try {
      return await stream.peer.call(
        "events.resume",
        { afterSeq: after },
        { signal, timeoutMs: 10_000 },
      );
    } catch (error) {
      if (error instanceof RpcError && error.code === RpcErrorCodes.resumeUnavailable)
        return undefined;
      throw error;
    }
  }
  /**
   * After the identity check: keep the stream when the desktop names the same one and still has
   * the gap (no screen reloads), else start a new stream with a new Peer (every screen reloads).
   */
  private async resumeOrOpen(
    computerId: string,
    named: { id: string; seq: number } | undefined,
    next: LinkConnection,
    guess: Stream | undefined,
    missed: Promise<MissedEvents> | undefined,
    context: { closed: AbortSignal; overflow(): void; path: boolean; at: number },
  ): Promise<Stream> {
    const epoch = named ? `stream:${named.id}` : (next.epoch ?? "");
    const replayed = guess && missed && epoch && guess.epoch === epoch ? await missed : undefined;
    const log = (mode: "resumed" | "full", count: number) => {
      this.refreshes[mode]++;
      reportLinkEvent("events_resume", {
        mode,
        on: context.path ? "path_change" : "connect",
        replayed: count,
        ms: Date.now() - context.at,
        resumed: this.refreshes.resumed,
        full: this.refreshes.full,
      });
    };
    if (guess && replayed) {
      guess.port.finish(replayed);
      // A request this stream lost in the drop leaves a stale screen: refresh it in place.
      if (guess.port.takeInterrupted()) this.resyncs++;
      log("resumed", replayed.length);
      return guess;
    }
    const stream = this.openStream(computerId, epoch);
    stream.port.attach(next.port, context);
    // A named stream starts at the desktop's position: what came before is in the fresh reads
    // every screen makes for the new Peer. An older desktop replays its whole buffer as before.
    const after = named?.seq ?? 0;
    stream.port.reset(after);
    stream.port.takeInterrupted();
    const done = this.missed(stream, after, context.closed).then((events) => {
      stream.port.finish(events ?? [], !events);
      return events?.length ?? 0;
    });
    // A named stream has nothing to replay but what follows the identity answer, and live events
    // queue until then: the screens start their fresh reads now instead of a round trip later.
    // The call still tells the desktop this phone's cursor. Older desktops keep the old order.
    if (named) {
      log("full", 0);
      void done.catch(() => {
        if (!context.closed.aborted) context.overflow();
      });
    } else log("full", await done);
    return stream;
  }
  /** Resolves true when an established session ended; throws when it never got online. */
  private async once(
    computer: Computer,
    signal: AbortSignal,
    waitForComputerMs?: number,
  ): Promise<boolean> {
    const started = Date.now();
    const credential = await this.storage.secrets.get(computer.id);
    signal.throwIfAborted();
    if (!credential) throw new Error("credential_missing");
    reportLinkEvent("connect_stage", { stage: "credential_ready", ms: Date.now() - started });
    const paused = (this.directPausedUntil.get(computer.id) ?? 0) > Date.now();
    const network = this.network;
    const owner = await this.link.connect(computer, credential, signal, 20_000, {
      ...(waitForComputerMs ? { waitForComputerMs } : {}),
      ...(paused ? { direct: false } : {}),
    });
    reportLinkEvent("connect_stage", { stage: "transport_ready", ms: Date.now() - started });
    // The computer answered its key exchange: it is reachable, whatever the identity check and
    // event resume still take (v0.0.2: "away" was declared during them, then online 1 s later).
    clearTimeout(this.quietTimer);
    owner.setExternalClock?.(this.nativeClock);
    let connection = owner;
    const closed = new AbortController();
    this.sessionClosed = closed.signal;
    const off = owner.onClose(() => closed.abort());
    /** The credential as stored now (its LAN hints are refreshed on each identity answer). */
    let stored = credential;
    const active = AbortSignal.any([signal, closed.signal]);
    let release: (() => void) | undefined;
    const retire = () => {
      release?.();
      release = undefined;
      offInteractive?.();
      offInteractive = undefined;
    };
    const bind = async (next: LinkConnection) => {
      retire();
      connection = next;
      const active = AbortSignal.any([
        signal,
        closed.signal,
        ...(next.closed ? [next.closed] : []),
      ]);
      active.throwIfAborted();
      const admissionAt = Date.now();
      const attach = { closed: active, overflow: () => closed.abort() };
      // The stream this phone was on is asked for what it missed while the identity is checked
      // (one round trip instead of two). Nothing it returns is delivered before the identity is
      // confirmed and the desktop names the same stream (resumeOrOpen).
      const prior = this.stream?.computerId === computer.id ? this.stream : undefined;
      const guess =
        prior && (prior.epoch.startsWith("stream:") || (!!next.epoch && prior.epoch === next.epoch))
          ? prior
          : undefined;
      let missed: Promise<MissedEvents> | undefined;
      if (guess) {
        guess.port.attach(next.port, attach);
        missed = this.missed(guess, guess.port.seq(), active);
        void missed.catch(() => undefined);
      }
      const self = SelfSchema.parse(await next.self(active));
      if (self.id !== computer.id) throw new Error("credential_identity_changed");
      reportLinkEvent("connect_stage", { stage: "identity_ready", ms: Date.now() - admissionAt });
      const replayAt = Date.now();
      const hints = sanitizeLanAddresses([
        ...(sanitizeLanAddresses(self.lanAddresses) ?? []),
        ...(owner.lanAddress ? [owner.lanAddress] : []),
        ...readCredential(stored).lanAddresses,
      ]);
      const updatedCredential = hints.length ? withLanAddresses(stored, hints) : undefined;
      // A SecureStore write costs a keystore round trip on Android: only when the hints changed,
      // and alongside the event resume instead of before it.
      const saving =
        updatedCredential !== undefined &&
        updatedCredential !== JSON.stringify(readCredential(stored))
          ? this.storage.secrets.set(computer.id, updatedCredential).then(() => {
              stored = updatedCredential;
            })
          : undefined;
      void saving?.catch(() => undefined);
      const [stream] = await Promise.all([
        this.resumeOrOpen(computer.id, self.eventStream, next, guess, missed, {
          ...attach,
          path: next !== owner,
          at: admissionAt,
        }),
        saving,
      ]);
      active.throwIfAborted();
      reportLinkEvent("connect_stage", { stage: "events_ready", ms: Date.now() - replayAt });
      // Path snapshots carry the business port; owner-wide controls stay with the owner.
      this.connection = {
        ...next,
        networkChanged: owner.networkChanged,
        refreshLan: owner.refreshLan,
        probe: owner.probe,
        pulse: owner.pulse,
        setExternalClock: owner.setExternalClock,
        endReason: owner.endReason,
      };
      // A quit desktop keeps the link but takes no work: the phone shows it offline so
      // its own model and direct runner control take over until it comes back.
      const bound = stream.peer;
      offInteractive = next.onInteractive?.((state) => {
        if (state === "quit") {
          this.lastSeen = Date.now();
          this.away = true;
          this.savePresence();
          this.publish({ ...this.state, status: "offline", peer: bound });
        } else if (!active.aborted) {
          this.reachable();
          this.publish({ ...this.state, status: "online", peer: bound });
        }
      });
      release = this.connected?.(computer, next, active);
      clearTimeout(this.quietTimer);
      if (self.interactive === "quit") {
        this.away = true;
        this.savePresence();
      } else this.reachable();
      this.publish({
        status: self.interactive === "quit" ? "offline" : "online",
        path: next.path ?? "relay",
        ...(next.pathKind ? { pathKind: next.pathKind } : {}),
        peer: bound,
        directFailure:
          next.path === "direct" || next.path === "lan" ? undefined : this.state.directFailure,
      });
      this.usable("reconnected", next.path ?? "relay");
    };
    let offPath: (() => void) | undefined;
    let offFailure: (() => void) | undefined;
    let offInteractive: (() => void) | undefined;
    let openedAt: number | undefined;
    try {
      await bind(owner);
      openedAt = Date.now();
      reportLinkEvent("session_opened", {
        path: owner.path ?? "relay",
        connectMs: openedAt - started,
      });
      offFailure = owner.onDirectFailure?.((directFailure) => {
        if (!active.aborted) this.publish({ ...this.state, directFailure });
      });
      offPath = owner.onPath?.(bind);
      // Rejects when the session ends, for whatever reason; that is the normal way out.
      await pause(active, 2_147_000_000).catch(() => undefined);
      return true;
    } finally {
      offFailure?.();
      offPath?.();
      offInteractive?.();
      const path = connection.path ?? "relay";
      retire();
      // The stream and its cursor stay for the next connection; only this wire is let go.
      if (this.stream?.computerId === computer.id) this.stream.port.detach();
      if (this.sessionClosed === closed.signal) this.sessionClosed = undefined;
      off();
      this.connection = undefined;
      // A failure seen on a network the phone has since left says nothing about the new one.
      if (owner.directBroken?.() && network === this.network) {
        this.directPausedUntil.set(computer.id, Date.now() + DIRECT_PAUSE_MS);
        reportLinkEvent("direct_paused", { minutes: DIRECT_PAUSE_MS / 60_000 });
      }
      const transport = openedAt !== undefined ? owner.endReason?.() : undefined;
      if (openedAt !== undefined) {
        // A quit desktop was marked away when it said so; its last-seen time stays that moment.
        if (!this.away) this.lastSeen = Date.now();
        if (!signal.aborted && transport && COMPUTER_GONE.has(transport)) this.away = true;
        this.savePresence();
      }
      // A drop of a live session shows "reconnecting" right away, also while the old wire drains;
      // a computer that left (or had quit) is offline at once. A session that never got online
      // publishes nothing here: the run loop says what its failure means, without an "offline"
      // flash inside the reconnect window (the offline engine would take over chats for it).
      // The stream's Peer stays on screen while it may resume (see kept()).
      if (signal.aborted) this.publish({ status: "suspended", peer: this.kept() });
      else if (openedAt !== undefined)
        this.publish(
          this.away
            ? this.offlineState()
            : { status: "connecting", peer: this.kept(), reconnecting: true },
        );
      if (openedAt !== undefined) {
        const frozen = !signal.aborted && this.frozenRecently();
        if (frozen || transport === "network_change") this.phoneSideDrop = true;
        const reason = signal.aborted
          ? (this.stopReason?.reason ?? "stopped")
          : frozen
            ? "phone_background_frozen"
            : (transport ?? "closed");
        reportLinkEvent("session_closed", {
          reason,
          ...(transport && transport !== reason ? { transport } : {}),
          path,
          onlineMs: Date.now() - openedAt,
        });
      }
      // This owner holds transports, not executing mutations. A retry resumes the stream (or gets
      // a fresh Peer); uncertain business results remain owned by the caller/outbox, never
      // replayed here.
      const draining = Date.now();
      await owner.close(signal.aborted ? this.stopReason?.bye : undefined);
      // The next attempt waits for this drain; a slow one delays the reconnect.
      if (Date.now() - draining > 1000)
        reportLinkEvent("session_drain_slow", { ms: Date.now() - draining });
    }
  }
}
