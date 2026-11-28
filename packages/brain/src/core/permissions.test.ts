import { type Permissions, PermissionsSchema } from "@pibot/protocol-base";
import { openDatabase, runMigrations } from "@pibot/storage";
import { expect, it, vi } from "vitest";
import { PermissionService } from "./permissions.ts";

it.each([
  {
    name: "a missing Linux dependency",
    status: {
      available: false,
      reason: "linux_socat_missing",
      probe: { stage: "initialize_runtime", stderr: "socat not installed" },
    },
    expected: { available: false, reason: "linux_socat_missing" },
  },
  {
    name: "Windows YOLO consent",
    status: { available: false, reason: "windows_unisolated", windowsYoloConsent: false },
    expected: { available: false, reason: "windows_unisolated", windowsYoloConsent: false },
  },
])("returns a permission schema result for $name", async ({ status, expected }) => {
  const database = openDatabase(":memory:");
  try {
    runMigrations(database);
    const changed = vi.fn<(value: Permissions) => void>();
    const service = new PermissionService(database, async () => status, changed);

    expect(PermissionsSchema.parse(await service.get()).isolation).toStrictEqual(expected);

    const updated = PermissionsSchema.parse(
      await service.set({ levels: { run_command: "always" } }),
    );
    expect(updated.levels.run_command).toBe("always");
    expect(updated.isolation).toStrictEqual(expected);
    expect(changed).toHaveBeenCalledExactlyOnceWith(updated);
  } finally {
    database.close();
  }
});
