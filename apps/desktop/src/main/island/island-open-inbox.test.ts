import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { islandOpenArgument } from "./island-open-argument.ts";
import { captureIslandOpens } from "./island-open-inbox.ts";

vi.mock("electron", () => ({ app: { on: vi.fn(), off: vi.fn() } }));

describe("the Windows island open inbox", () => {
  it("retries the cold launch request when the owner renews the foreground grant", async () => {
    const id = randomUUID();
    const lifetime = new AbortController();
    const inbox = captureIslandOpens([islandOpenArgument(id)], lifetime.signal);
    const activate = vi.fn();
    const acknowledge = vi.fn(async () => {});
    inbox.subscribe(activate);
    await inbox.acknowledge(acknowledge, () => false);
    expect(inbox.hasPending()).toBe(true);

    inbox.offer(id);
    expect(activate).toHaveBeenCalledTimes(2);
    await inbox.acknowledge(acknowledge, () => true);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id);
    expect(inbox.hasPending()).toBe(false);

    inbox.offer(id);
    expect(activate).toHaveBeenCalledTimes(2);
    lifetime.abort();
  });

  it("keeps the latest pending activation available at renderer startup", async () => {
    const id = randomUUID();
    const lifetime = new AbortController();
    const inbox = captureIslandOpens([], lifetime.signal);
    const activate = vi.fn();
    const acknowledge = vi.fn(async () => {});
    inbox.offer(id);
    inbox.subscribe(activate);
    expect(activate).toHaveBeenCalledTimes(1);
    await inbox.acknowledge(acknowledge, () => false);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(inbox.hasPending()).toBe(true);
    lifetime.abort();
    expect(inbox.hasPending()).toBe(false);
  });
});
