import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { createEvaluator } from "@pibot/policy";
import { CategorySchema, PermissionLevelsSchema } from "@pibot/protocol-base";
import { expect, it, vi } from "vitest";
import { approvalDisplay } from "../../../core/approval-display.ts";
import type { PreparedTool } from "../../../core/local-types.ts";
import { FolderWriteLocks } from "../../../resources/workplaces/folder-write-lock.ts";
import { writeLockRootsStep } from "./local-run-execution.ts";

it("runs a proven Windows query while an earlier run still holds the workspace write lease", async () => {
  const botId = "84eb1445-521c-4af5-baa6-591198fb1a3c";
  const home = String.raw`C:\Users\QA\AppData\Local\PiBot\bots\qa\home`;
  const workspace = await mkdtemp(join(tmpdir(), "pibot-windows-read-lock-"));
  const locks = new FolderWriteLocks({
    platform: "win32",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    waitMs: 50,
  });
  const signal = new AbortController().signal;
  const earlier = { botId, runId: "earlier", lease: "cleanup" };
  const later = { botId, runId: "later", lease: "query" };
  const lockScope = { writeRoots: () => [workspace] } as unknown as ThisParameterType<
    typeof writeLockRootsStep
  >;
  const evaluate = createEvaluator(
    {
      platform: "win32",
      userHome: String.raw`C:\Users\QA`,
      fs: { realpath: async (path) => path },
    },
    () => {
      throw new Error("Windows uses the PowerShell shape proof");
    },
  );
  const prepare = async (command: string) => {
    const settings = {
      levels: PermissionLevelsSchema.parse(
        Object.fromEntries(CategorySchema.options.map((category) => [category, "ask"])),
      ),
      network: { domains: [], allowAll: false },
    };
    const result = await evaluate({
      botId,
      signal,
      workplace: { home, folders: [], currentId: "home" },
      settings,
      request: { category: "run_command", command },
    });
    return {
      call: { id: command, tool: "run_command", input: { command } },
      result,
      settings,
      roots: [workspace],
      cwd: home,
      home,
      authorization: "fixture",
    } satisfies PreparedTool;
  };
  try {
    await locks.acquire(earlier, [workspace], signal);
    const query = await prepare("Get-Date");
    expect(query.result).toMatchObject({ decision: "allow", reason: "windows_read_only" });
    const queryRoots = writeLockRootsStep.call(lockScope, query);
    if (queryRoots.length) await locks.acquire(later, queryRoots, signal);
    expect(locks.assertOwner(earlier)).toBeUndefined();

    const write = await prepare("Set-Content qa.txt QA");
    const writeRoots = writeLockRootsStep.call(lockScope, write);
    expect(writeRoots).toEqual([workspace]);
    await expect(locks.acquire(later, writeRoots, signal)).rejects.toThrow("folder_lock_timeout");
    locks.release(earlier.runId, earlier.lease);
    await locks.acquire(later, writeRoots, signal);
    expect(locks.assertOwner(later)).toBeUndefined();
  } finally {
    locks.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("shows the Desktop and Documents listings as file requests on each platform", () => {
  for (const [platform, home, path] of [
    ["win32", String.raw`C:\Users\QA User`, win32],
    ["darwin", "/Users/qa", posix],
    ["linux", "/home/qa", posix],
  ] as const) {
    for (const [folder, zh, en] of [
      ["Desktop", "Pi 想查看你桌面上的文件列表", "Pi wants to list the files on your Desktop"],
      [
        "Documents",
        "Pi 想查看你「文档」文件夹里的文件列表",
        "Pi wants to list the files in your Documents folder",
      ],
    ] as const) {
      const listing = { path: path.join(home, folder), home, platform };
      const facts = [{ kind: "read" as const, value: listing.path }];
      const direct = { id: "direct", tool: "list_dir", input: { path: listing.path } };
      expect(approvalDisplay(direct, facts, "zh", "Pi", { listing }).title).toBe(zh);
      expect(approvalDisplay(direct, facts, "en", "Pi", { listing }).title).toBe(en);
      if (platform === "win32") {
        const command = {
          id: "command",
          tool: "run_command",
          input: { command: `gci '${listing.path}'` },
        };
        expect(
          approvalDisplay(command, facts, "zh", "Pi", { listing, fileRead: "list_dir" }),
        ).toEqual({ title: zh, facts });
      }
    }
  }
});
