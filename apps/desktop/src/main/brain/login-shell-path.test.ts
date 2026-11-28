import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  collectLoginShellPath,
  type LoginShellChild,
  readLoginShellPath,
} from "./login-shell-path.ts";

class FakeChild extends EventEmitter implements LoginShellChild {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
}

describe("login-shell-path", () => {
  it("waits for buffered stdout chunks that arrive after exit", async () => {
    const child = new FakeChild();
    const pending = collectLoginShellPath(child, {
      timeoutMs: 500,
      checkDir: async (entry) => entry === "/opt/homebrew/bin" || entry === "/usr/local/bin",
    });

    // Simulate Node emitting "exit" before stdout finishes delivering the closing marker across chunks.
    child.stdout.write("__PIBOT_PATH_START__/opt/homebrew/bin:");
    child.emit("exit", 0);
    await new Promise((r) => setTimeout(r, 15));
    child.stdout.write("/usr/local/bin:/missing/dir__PIBOT_PATH_");
    child.stdout.end("END__");

    expect(await pending).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("resolves immediately on exit once markers arrive even if a helper keeps stdout open", async () => {
    const child = new FakeChild();
    const started = performance.now();
    const pending = collectLoginShellPath(child, {
      timeoutMs: 3_000,
      checkDir: async () => true,
    });

    child.stdout.write("__PIBOT_PATH_START__/usr/bin:/usr/local/bin__PIBOT_PATH_END__");
    child.emit("exit", 0);
    // Intentionally leave stdout open without emitting "close" (e.g. detached zsh helper).

    expect(await pending).toEqual(["/usr/bin", "/usr/local/bin"]);
    expect(performance.now() - started).toBeLessThan(500);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("returns undefined once stdout drains without markers after exit 0", async () => {
    const child = new FakeChild();
    const pending = collectLoginShellPath(child, {
      timeoutMs: 500,
      checkDir: async () => true,
    });

    child.emit("exit", 0);
    child.stdout.end("motd noise without markers");

    expect(await pending).toBeUndefined();
  });

  it("kills the process group and settles once when output exceeds maxOutput", async () => {
    const child = new FakeChild();
    let kills = 0;
    const pending = collectLoginShellPath(child, {
      timeoutMs: 500,
      maxOutput: 16,
      killGroup: () => {
        kills++;
      },
      checkDir: async () => true,
    });

    child.stdout.write("x".repeat(32));
    child.stdout.write("y".repeat(32));
    child.emit("exit", 0);

    expect(await pending).toBeUndefined();
    expect(kills).toBe(1);
  });

  it("returns undefined on win32 without spawning a shell", async () => {
    expect(await readLoginShellPath("win32", {})).toBeUndefined();
  });
});
