import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { trashOnLinux } from "./linux-trash.ts";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (path: string, encoding: "utf8") =>
      path === "/proc/self/mountinfo" ? Promise.resolve("") : actual.readFile(path, encoding),
  };
});

it.skipIf(!process.getuid).each(["", "files", "info"])(
  "preserves the source when the private Trash directory %j is visible to other users",
  async (subdirectory) => {
    const home = await mkdtemp(join(tmpdir(), "pibot-trash-"));
    try {
      const data = join(home, "data");
      const trash = join(data, "Trash");
      await mkdir(trash, { recursive: true, mode: 0o700 });
      const directory = join(trash, subdirectory);
      if (subdirectory) await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o755);
      const note = join(home, "private.md");
      await writeFile(note, "fixture private content", { mode: 0o600 });
      await expect(trashOnLinux(note, home, data, AbortSignal.timeout(10_000))).rejects.toThrow(
        "Invalid Trash directory",
      );
      expect(await readFile(note, "utf8")).toBe("fixture private content");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
