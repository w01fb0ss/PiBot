import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { diagnosticCommand, type SandboxDiagnosticRow } from "./report.ts";
import {
  createSandboxDiagnosticSession,
  type SandboxDiagnosticCheck,
  type SandboxDiagnosticOptions,
} from "./session.ts";

export {
  diagnosticCommand,
  diagnosticSignatures,
  type SandboxDiagnosticRow,
  sandboxDiagnosticMarkdown,
} from "./report.ts";
export {
  createSandboxDiagnosticSession,
  type SandboxDiagnosticCheck,
  type SandboxDiagnosticOptions,
} from "./session.ts";

/** Fixed public endpoints and a disposable workspace make this independent of a running brain. */
export async function sandboxDoctor(
  options: SandboxDiagnosticOptions,
): Promise<SandboxDiagnosticRow[]> {
  const started = performance.now();
  const session = await createSandboxDiagnosticSession(options);
  const rows: SandboxDiagnosticRow[] = [
    {
      tool: "命令隔离 / Command isolation",
      status: session.isolation.available
        ? "passed"
        : options.platform === "win32"
          ? "skipped"
          : "failed",
      durationMs: Math.round(performance.now() - started),
      reason: session.isolation.available
        ? "available"
        : (session.isolation.reason ?? "isolation_unavailable"),
      kinds: [],
      rules: [],
      // Only the probing isolation status carries a probe; other shapes report no signature.
      signatures: (() => {
        const probe = "probe" in session.isolation ? session.isolation.probe : undefined;
        return probe ? [probe.stage, ...(probe.stderr ? [probe.stderr] : [])] : [];
      })(),
    },
  ];
  try {
    const runNode = async (
      tool: string,
      source: string,
      extra: Omit<SandboxDiagnosticCheck, "tool" | "command"> = {},
    ) => session.run({ tool, command: await session.script(source), ...extra });
    const curl = options.platform === "darwin" ? "/usr/bin/curl" : await session.executable("curl");
    rows.push(
      await session.run({
        tool: "证书校验 / Certificate verification",
        command: curl
          ? diagnosticCommand(options.platform, [
              curl,
              "--fail",
              "--silent",
              "--show-error",
              "--max-time",
              "10",
              "https://example.com",
              "--output",
              options.platform === "win32" ? "NUL" : "/dev/null",
            ])
          : await session.script(
              "fetch('https://example.com',{signal:AbortSignal.timeout(10000)}).then(r=>{if(!r.ok)process.exitCode=1}).catch(e=>{console.error(e.cause?.code??e.code??'https_failed');process.exitCode=1});",
            ),
        network: { allowAll: false, domains: ["example.com"] },
      }),
    );
    rows.push(
      await session.run({
        tool: "系统代理读取 / System proxy lookup",
        command:
          options.platform === "darwin"
            ? await session.script(
                "const r=require('node:child_process').spawnSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:10000});if(r.status!==0||!r.stdout.includes('<dictionary>'))process.exitCode=1;",
              )
            : undefined,
        skip: options.platform === "darwin" ? undefined : "macos_system_service_only",
      }),
    );
    rows.push(
      await runNode(
        "写入工作区 / Workspace write",
        "const fs=require('node:fs');fs.writeFileSync('doctor-write.txt','ok');if(fs.readFileSync('doctor-write.txt','utf8')!=='ok')process.exitCode=1;",
      ),
    );
    rows.push(
      await runNode(
        "受保护名称 / Protected name",
        "try{require('node:fs').writeFileSync('.bashrc','changed')}catch(e){if(['EPERM','EACCES','EROFS'].includes(e.code))process.exitCode=19;else process.exitCode=20}",
        {
          skip: options.platform === "win32" ? "windows_unisolated" : undefined,
          expectedExitCode: 19,
          verify: async () =>
            (await readFile(join(session.project, ".bashrc"), "utf8")) === "doctor fixture\n",
        },
      ),
    );
    rows.push(
      await runNode(
        "网站清单拒绝 / Domain allowlist denial",
        "fetch('https://example.org',{signal:AbortSignal.timeout(10000)}).then(()=>{process.exitCode=0}).catch(e=>{console.error(e.cause?.code??e.code??'https_failed');process.exitCode=1});",
        {
          network: { allowAll: false, domains: ["example.com"] },
          deniedKind: "network",
        },
      ),
    );
    return rows;
  } finally {
    await session.close();
  }
}
