import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createExec } from "../command/command.ts";
import type { ExecRedactor } from "../core/types.ts";
import { isolationProbeStderr } from "../sandbox/isolation-probe.ts";
import { linuxIsolationFailure } from "../sandbox/linux-isolation.ts";
import { sandboxDoctor } from "./sandbox-doctor.ts";

vi.mock("../command/command.ts", () => ({ createExec: vi.fn() }));

describe("sandbox doctor isolation diagnosis", () => {
  it("retains canonical repair features while withholding other host output", async () => {
    let redactor: ExecRedactor | undefined;
    const runCommand = vi.fn();
    const dispose = vi.fn();
    const privateHostOutput = "/private/fixture/private-location";
    vi.mocked(createExec).mockImplementation(({ redactor: configured }) => {
      redactor = configured;
      return {
        // The shared probe receives the redacted stream, including an initialization error that
        // may be split across chunks. Its real classifier still decides the reason.
        async isolationStatus() {
          const stream = configured.stream();
          const safe = [
            stream.push(`${privateHostOutput}\nlookup failed: soc`),
            stream.push("at not installed\n"),
            stream.finish(),
          ].join("");
          expect(safe).toBe("socat not installed\n");
          const probe = {
            stage: "initialize_runtime" as const,
            stderr: isolationProbeStderr(safe),
          };
          return { available: false, reason: await linuxIsolationFailure(probe), probe };
        },
        runCommand,
        dispose,
      } as unknown as ReturnType<typeof createExec>;
    });

    const rows = await sandboxDoctor({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      systemHome: tmpdir(),
      tempDir: tmpdir(),
      signal: new AbortController().signal,
    });

    expect(rows[0]).toMatchObject({
      status: "failed",
      reason: "linux_socat_missing",
      signatures: ["initialize_runtime", "socat not installed"],
    });
    expect(JSON.stringify(rows)).not.toContain(privateHostOutput);
    expect(runCommand).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    if (!redactor) throw new Error("Diagnostic redactor was unavailable");
    const commandOutput = redactor.stream();
    expect(commandOutput.push("socat not installed\n")).toBe("");
    expect(commandOutput.finish()).toBe("");
  });
});
