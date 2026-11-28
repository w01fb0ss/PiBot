import { win32 } from "node:path";
import {
  applyWindowsCommandConsent,
  createPolicy,
  type EvaluationInput,
} from "../../../packages/policy/src/index.ts";
import {
  CategorySchema,
  GrantSchema,
  PermissionLevelsSchema,
} from "../../../packages/protocol-base/src/index.ts";

const botId = "84eb1445-521c-4af5-baa6-591198fb1a3c";
const userHome = String.raw`C:\Users\QA User`;
const desktop = win32.join(userHome, "Desktop");
const oneDrive = win32.join(userHome, "OneDrive - QA");
const documents = win32.join(userHome, "Documents");
const reads = [
  "dir",
  "Get-ChildItem -Recurse src",
  "type README.md",
  "gci | Select-String foo",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "Get-Location",
  "Test-Path README.md",
  "Get-Item README.md",
  "Resolve-Path .",
  "gci | Measure-Object",
  "Get-Command node",
  "Get-Date",
  "node --version",
  "cmd /c dir",
  "cmd /c type README.md",
  "cmd /c where node",
  "cmd /c echo QA",
];

// Same inputs as local-prepare for the default Windows Bot. The shell HOME is a sibling
// of the cwd, the whole data directory is protected, and the desktop has no command sandbox.
export async function windowsRuntimeCases(dataDir: string) {
  const bots = win32.join(dataDir, "bots");
  const bot = win32.join(bots, botId);
  const cwd = win32.join(bot, "home");
  const commandHome = win32.join(bot, "command-home");
  const protectedFile = win32.join(dataDir, "settings.json");
  const defaults = {
    botId,
    cwd,
    commandHome,
    workplace: { home: cwd, folders: [], currentId: "home" },
    boundary: {
      boundaryVersion: 1,
      location: { target: "local", platform: "win32" },
      conflict: "none",
      roots: [
        { id: "home", path: cwd, canonicalPath: cwd, device: "1", inode: "2", role: "primary" },
      ],
      revision: 0,
      primaryId: "home",
      primaryPath: cwd,
      readRoots: [cwd],
      writeRoots: [cwd],
      denyWriteRoots: [],
    },
    botData: {
      roots: [bots, win32.join(dataDir, "groups"), win32.join(dataDir, "skill-packages")],
      allowed: [bot],
    },
    protectedWriteRoots: async () => [dataDir, win32.join(userHome, ".ssh")],
    commandIsolation: async () => false,
  } satisfies Partial<EvaluationInput>;
  const policy = await createPolicy({
    platform: "win32",
    userHome,
    windowsUserPaths: {
      username: "QA User",
      onedrive: oneDrive,
      homedrive: "C:",
      homepath: String.raw`\Users\QA User`,
    },
    fs: {
      async realpath(path, signal) {
        signal.throwIfAborted();
        if (path === win32.join(cwd, "junction")) return dataDir;
        if (["src", "README.md", "qa-out.txt"].includes(win32.basename(path)))
          throw Object.assign(new Error("Missing fixture"), { code: "ENOENT" });
        return path;
      },
      async windowsReadEntries(directory, _recurse, signal, canVisit) {
        signal.throwIfAborted();
        if (directory !== cwd && directory !== desktop) return;
        const path = win32.join(directory, "file.txt");
        return canVisit(path) ? [{ path, directory: false }] : undefined;
      },
    },
  });
  const evaluate = async (
    request: EvaluationInput["request"],
    consent: boolean,
    level: "never" | "ask" | "always" = "ask",
    grants?: EvaluationInput["grants"],
  ) =>
    applyWindowsCommandConsent(
      await policy.evaluate({
        ...defaults,
        ...(request.category === "run_command" && request.command.startsWith("git ")
          ? { windowsGitReadScopeVerified: true as const }
          : {}),
        settings: {
          levels: PermissionLevelsSchema.parse(
            Object.fromEntries(CategorySchema.options.map((category) => [category, level])),
          ),
          network: { allowAll: false, domains: [] },
        },
        request,
        grants,
        yolo: consent,
        signal: AbortSignal.timeout(10_000),
      }),
      consent,
    );
  const check = async (
    command: string,
    consent: boolean,
    expected: readonly [string, string, string],
    level: "never" | "ask" | "always" = "ask",
  ) => {
    const result = await evaluate({ category: "run_command", command }, consent, level);
    const actual = [result.decision, result.reason, result.risk].join(":");
    if (
      actual !== expected.join(":") ||
      result.commandHome !== commandHome ||
      (command.startsWith("cmd /c ") &&
        expected[1] === "windows_read_only" &&
        result.windowsReadOnly !== true)
    )
      throw new Error(`Windows runtime matrix (${level}, YOLO=${consent}): ${command}: ${actual}`);
  };
  try {
    for (const command of reads) {
      const allowed = ["allow", "windows_read_only", "normal"] as const;
      await check(command, false, allowed);
      await check(command, false, allowed, "always");
      await check(command, true, allowed);
      await check(command, false, ["deny", "permission_never", "normal"], "never");
    }
    for (const [command, path] of [
      [`Get-ChildItem "${desktop}"`, desktop],
      [String.raw`Get-ChildItem "$env:USERPROFILE\Desktop"`, desktop],
      [String.raw`Get-ChildItem "C:\Users\$env:USERNAME\Desktop"`, desktop],
      [String.raw`Get-ChildItem "$env:HOMEDRIVE$env:HOMEPATH\Desktop"`, desktop],
      [String.raw`Get-ChildItem "$HOME\Desktop"`, desktop],
      ["Get-ChildItem ~/Desktop", desktop],
      ['Get-ChildItem "$env:OneDrive"', oneDrive],
      [`Get-ChildItem -Recurse "${desktop}"`, desktop],
      [`gci "${documents}" | Measure-Object`, documents],
    ] as const) {
      const request = { category: "run_command", command } as const;
      const listing = { category: "list_dir", path } as const;
      const direct = await evaluate(listing, false);
      const scope = direct.grantScope;
      if (direct.decision !== "ask" || scope?.kind !== "folder" || scope.path !== path)
        throw new Error(`Expected a scoped listing approval for ${path}`);
      const grant = GrantSchema.parse({
        id: botId,
        botId,
        category: "list_dir",
        scope,
        createdAt: "2026-11-01T00:00:00.000Z",
        revokedAt: null,
      });
      const allowed = await evaluate(request, false, "ask", [grant]);
      if (
        (await evaluate(listing, false, "ask", [grant])).decision !== "allow" ||
        allowed.decision !== "allow" ||
        allowed.reason !== "windows_read_only" ||
        allowed.windowsReadProven !== true
      )
        throw new Error(`The listing grant did not allow ${command}`);
      const content = await evaluate(
        { category: "run_command", command: `Get-Content '${win32.join(path, "file.txt")}'` },
        true,
        "ask",
        [grant],
      );
      if (content.decision !== "ask" || content.category !== "read_file")
        throw new Error(`The listing grant also allowed file contents at ${path}`);
      for (const consent of [false, true]) {
        const ask = await evaluate(request, consent);
        if (
          ask.decision !== "ask" ||
          ask.reason !== "windows_file_read_confirmation" ||
          ask.category !== "list_dir" ||
          !ask.canRemember ||
          JSON.stringify(ask.grantScope) !== JSON.stringify(scope) ||
          ask.command !== allowed.command ||
          ask.facts[0]?.value !== path
        )
          throw new Error(`Expected the same listing approval for ${command}`);
      }
      if (
        /[~$]/.test(command) &&
        (allowed.command !== `get-childitem -LiteralPath '${path}'` ||
          allowed.command.includes(commandHome))
      )
        throw new Error(`Expected the approved literal path to be used for ${command}`);
    }
    const multi = await evaluate(
      {
        category: "run_command",
        command: `gci "${desktop}"; gci "${documents}"`,
      },
      true,
    );
    if (
      multi.decision !== "ask" ||
      multi.category !== "list_dir" ||
      multi.canRemember ||
      multi.grantScope ||
      multi.facts.length !== 2
    )
      throw new Error("A compound read can't remember two folders as one grant");
    const write = "Set-Content -Path qa-out.txt -Value QA";
    await check(write, false, ["ask", "windows_unisolated", "normal"]);
    for (const ordinary of [write, "npm test", "node build.js"])
      await check(ordinary, true, ["allow", "yolo", "normal"]);
    await check("npm install", false, ["ask", "windows_unisolated", "normal"]);
    for (const danger of [
      "Remove-Item qa-x",
      "cmd /c del qa-x",
      `Set-Content -Path '${protectedFile}' -Value QA`,
      String.raw`Set-Content -Path junction\settings.json -Value QA`,
      `type '${protectedFile}'`,
    ])
      await check(danger, true, ["ask", "dangerous_operation", "danger"]);
    for (const opaque of [
      'iex ("Write-Output 1")',
      "Write-Output (",
      'Get-ChildItem "$env:UNRECOGNIZED"',
      'Get-ChildItem "$env:USERPROFILE名前"',
      'Get-ChildItem "$env:USERPROFILE\\Desktop"; Write-Output $env:UNKNOWN',
      String.raw`dir \\127.0.0.1\qa-never`,
    ])
      await check(opaque, true, ["ask", "windows_requires_approval", "normal"]);
    await check("runas /user:QA-NoUser whoami", true, [
      "deny",
      "privilege_escalation_denied",
      "danger",
    ]);
  } finally {
    policy.dispose();
  }
}
