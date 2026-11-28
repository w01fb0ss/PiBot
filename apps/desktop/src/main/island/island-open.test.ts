import { ChildProcess } from "node:child_process";
import { app } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIslandOpen } from "./island-open.ts";
import { islandOpenArgument, readIslandOpenArgument } from "./island-open-argument.ts";
import { captureIslandOpens } from "./island-open-inbox.ts";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter() };
});

const target = { view: "settings" } as const;

function setup() {
  const children: ChildProcess[] = [];
  const launch = vi.fn((_id: string) => {
    const child = new ChildProcess();
    children.push(child);
    return child;
  });
  const alive = vi.fn((_pid: number) => true);
  const grantForeground = vi.fn(async (_pid: number, _signal: AbortSignal) => {});
  const notify = vi.fn((_client: string, _id: string) => {});
  const failed = vi.fn();
  return {
    open: createIslandOpen({ launch, alive, grantForeground, notify, failed }),
    children,
    launch,
    alive,
    grantForeground,
    notify,
    failed,
  };
}

describe("live island open", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a slow attached GUI alive and delivers its click over the owner connection", async () => {
    const { open, launch, grantForeground, notify } = setup();
    open.attach("attached", 2480);
    const clicked = open.open(target);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(launch).not.toHaveBeenCalled();
    expect(grantForeground).toHaveBeenCalledExactlyOnceWith(2480, expect.any(AbortSignal));
    const id = notify.mock.calls[0]?.[1] ?? "";
    expect(notify).toHaveBeenCalledExactlyOnceWith("attached", id);
    expect(open.opened("other", 2480, id)).toBeUndefined();
    expect(open.opened("attached", 2481, id)).toBeUndefined();
    expect(open.opened("attached", 2480, "stale")).toBeUndefined();
    expect(open.opened("attached", 2480, id)).toEqual(target);
    expect(open.opened("attached", 2480, id)).toBeUndefined();
    await clicked;
  });

  it("lets the singleton recipient attach after the launching process exits", async () => {
    const { open, children, launch } = setup();
    const clicked = open.open(target);
    const id = launch.mock.calls[0]?.[0] ?? "";
    children[0]?.emit("close", 0, null);
    open.attach("actual", 2480);
    vi.advanceTimersByTime(1000);

    expect(launch).toHaveBeenCalledOnce();
    expect(open.opened("actual", 2480, id)).toEqual(target);
    await clicked;
  });

  it.each([
    { clicks: "different targets", firstTarget: { view: "inbox" } },
    { clicks: "the same target", firstTarget: target },
  ] as const)(
    "keeps the later click on $clicks when the earlier notification arrives before subscription",
    async ({ firstTarget }) => {
      const { open, launch } = setup();
      const first = open.open(firstTarget);
      const second = open.open(target);
      const firstId = launch.mock.calls[0]?.[0] ?? "";
      const secondId = launch.mock.calls[1]?.[0] ?? "";
      const lifetime = new AbortController();
      try {
        const inbox = captureIslandOpens(
          ["PiBot.exe", islandOpenArgument(secondId)],
          lifetime.signal,
        );
        app.emit("second-instance", {}, ["PiBot.exe", islandOpenArgument(firstId)]);

        const activate = vi.fn();
        inbox.subscribe(activate);
        expect(activate).toHaveBeenCalledOnce();
        const acknowledge = vi.fn(async (id: string) => open.opened("actual", 2480, id));
        await inbox.acknowledge(acknowledge, () => false);
        expect(acknowledge).not.toHaveBeenCalled();

        open.attach("actual", 2480);
        await inbox.acknowledge(acknowledge, () => true);
        expect(acknowledge.mock.calls).toEqual([[secondId], [firstId]]);
        await expect(acknowledge.mock.results[0]?.value).resolves.toEqual(target);
        await expect(acknowledge.mock.results[1]?.value).resolves.toBeUndefined();
        await Promise.all([first, second]);
      } finally {
        lifetime.abort();
        open.dispose();
      }
    },
  );

  it("waits for an island-launched GUI to finish exiting", async () => {
    const { open, children, launch, alive } = setup();
    const first = open.open(target);
    open.attach("initial", 2480);
    const firstId = launch.mock.calls[0]?.[0] ?? "";
    expect(open.opened("initial", 2480, firstId)).toEqual(target);
    await first;

    open.detach("initial");
    const second = open.open(target);
    expect(launch).toHaveBeenCalledOnce();
    expect(alive).toHaveBeenCalledWith(2480);
    alive.mockReturnValue(false);
    children[0]?.emit("close", 0, null);
    vi.advanceTimersByTime(250);
    expect(launch).toHaveBeenCalledTimes(2);

    open.attach("replacement", 2481);
    const secondId = launch.mock.calls[1]?.[0] ?? "";
    expect(open.opened("initial", 2480, secondId)).toBeUndefined();
    expect(open.opened("replacement", 2481, secondId)).toEqual(target);
    await second;
  });

  it("retains the activity if the recipient exits before confirming focus", async () => {
    const { open, launch, notify, alive } = setup();
    open.attach("exiting", 2480);
    const clicked = open.open(target);
    await vi.advanceTimersByTimeAsync(0);
    const id = notify.mock.calls[0]?.[1] ?? "";
    open.detach("exiting");
    expect(open.opened("exiting", 2480, id)).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
    alive.mockReturnValue(false);
    vi.advanceTimersByTime(250);

    expect(launch).toHaveBeenLastCalledWith(id);
    open.attach("replacement", 2481);
    expect(open.opened("replacement", 2481, id)).toEqual(target);
    await clicked;
  });

  it("cold launches after a bounded grace even when the departed PID is still occupied", async () => {
    const { open, launch, alive } = setup();
    open.attach("departed", 2480);
    open.detach("departed");
    const clicked = open.open(target);
    expect(launch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(alive).toHaveBeenCalledWith(2480);
    expect(launch).toHaveBeenCalledOnce();
    const id = launch.mock.calls[0]?.[0] ?? "";
    expect(readIslandOpenArgument(["PiBot.exe", islandOpenArgument(id)])).toBe(id);
    open.attach("new", 2481);
    expect(open.opened("new", 2481, id)).toEqual(target);
    await clicked;
  });

  it("expires an unconfirmed click", async () => {
    const { open, notify, failed } = setup();
    open.attach("covered", 2480);
    const clicked = open.open(target);
    await vi.advanceTimersByTimeAsync(0);
    const id = notify.mock.calls[0]?.[1] ?? "";
    vi.advanceTimersByTime(120_000);

    expect(failed).toHaveBeenCalledWith("gui_open_unconfirmed");
    expect(open.opened("covered", 2480, id)).toBeUndefined();
    await clicked;
  });
});
