import { basename } from "node:path";
import { rememberableSystemService, type SandboxBlock } from "@pibot/execution";
import type { CommandInvocation, Platform } from "@pibot/policy";
import { sandboxSignatureGuidance } from "./sandbox-signatures.ts";

/**
 * What a sandboxed command prints when it touches a path it was not given. Package
 * managers clean caches this way without the analysis ever seeing the path.
 */
const SANDBOX_WRITE_DENIED =
  /operation not permitted|read-only file system|\bEPERM\b|\bEACCES\b|permission denied/i;
const OUTSIDE_WRITE_GUIDANCE =
  "写入权限提示：命令在隔离里只能写工作位置。如果失败的是工作位置之外的路径（比如包管理器或构建工具的缓存），用 run_command 的 writePaths 列出这些路径（最多 8 个）后重跑，会先请用户逐次确认；根目录、主目录本身、系统目录、Pi Bot 数据目录和凭据位置仍不能写。不要改用 sudo、chmod 或绕过沙箱。 / Write permission note: sandboxed commands can only write the workplace. If the failing path is outside it (for example a package manager or build tool cache), rerun with run_command writePaths listing those paths (at most 8); the user is asked to confirm that one call. The filesystem root, the home folder itself, system folders, Pi Bot's data folder and credential stores stay blocked. Do not switch to sudo, chmod or sandbox bypasses.";

const BLOCK_LABELS: Record<SandboxBlock["kinds"][number], string> = {
  outside_workplace_write: "工作位置外写入 / write outside the workplace",
  protected_name: "受保护名称 / protected name",
  git_resource: "Git 钩子或配置 / Git hooks or config",
  network: "网络 / network",
  local_service: "本机服务 / local service",
  system_service: "系统服务 / system service",
  protected_path: "受保护位置 / protected location",
  credential_read: "凭据或用户配置读取 / credential or user config read",
  protected_read: "受保护位置读取 / protected location read",
  other: "其他 / other",
};
const BLOCK_ADVICE: Partial<Record<SandboxBlock["kinds"][number], string>> = {
  protected_name:
    "编辑器、Shell 和 Git 的配置名（如 .vscode、.idea、.gitconfig、.bashrc）在工作目录下任意深度都禁止写入，因为它们可能在沙箱外被自动执行；依赖包里自带这些目录也会被拦。 / Editor, shell and Git configuration names (.vscode, .idea, .gitconfig, .bashrc, …) are write-protected at any depth below the working directory because they may run outside the sandbox later; a dependency that ships such a folder is blocked too.",
  git_resource:
    ".git/hooks 和 .git/config 在沙箱里不能写（钩子和可执行配置）；改 Git 配置用普通 git config 命令，Pi Bot 会按受控做法处理。 / .git/hooks and .git/config cannot be written inside the sandbox (hooks and executable configuration); change Git settings with a plain git config command, which Pi Bot handles through its controlled recipe.",
  network:
    "网络被沙箱拦截：联网设置不允许这个地址，或这个程序不走 Pi Bot 的网络代理（ssh、数据库客户端等）。要监听本机端口（开发服务器）用 run_command background=true；要访问某个公网网站，请用户到「设置 → 权限 → 联网 → 允许的网站」添加域名；如果此 Bot 有独立的联网设置，在 Bot 的权限里编辑清单；本地网络设备请在命令里直接写出地址（如 curl http://192.168.1.1），会请用户确认；路由表、Wi-Fi 状态和 ping 用 local_network。 / The sandbox blocked network access: network settings do not allow this host, or the program does not use Pi Bot's proxy (ssh, database clients). To listen on a local port (dev server) use run_command background=true; to reach a site, ask the user to add its domain in Settings → Permissions → Network → Allowed websites; use the Bot's own permissions if it has a network override; for a device on the local network write its address in the command (curl http://192.168.1.1) and the user is asked; for routes, Wi-Fi state and ping use local_network.",
  system_service:
    "系统服务被沙箱拦截（剪贴板、打开其他应用、Apple Events 等）；要操作界面或应用，用已授权的操作电脑工具。 / The sandbox blocked a system service (clipboard, opening other apps, Apple Events); use the authorized computer tools to operate apps or the screen.",
  local_service:
    "本机服务或 Docker Unix socket 被沙箱拦截：这不是外网访问。原样再运行同一条命令（同一工作目录，不加 outsideSandbox），会请用户允许这一个本机端口或 socket；放行范围只包括卡片列出的文件夹、程序和端口（或 socket 路径）。 / A local service or Docker Unix socket was blocked; this is not internet access. Run the same command again unchanged (same folder, without outsideSandbox) and the user is asked to allow this one local port or socket; access is limited to the folder, program and port (or socket path) listed on the card.",
  protected_path:
    "凭据位置、Pi Bot 数据目录、只读参考文件夹等受保护位置不能写，也没有别的办法放开；如实告诉用户。 / Credential stores, Pi Bot's data folder, read-only reference folders and similar protected locations cannot be written and cannot be opened up; tell the user plainly.",
  credential_read:
    '凭据和用户配置在沙箱里读不到：沙箱里的 HOME 是 Bot 的私有命令主目录，~/.aws、~/.config/gh、~/.kube、~/.ssh、钥匙串等用户的登录信息和配置都不可读，所以命令行工具会说「找不到凭据」「未登录」或用默认配置；这不说明用户没登录或配置有错，退出码为 0 时输出也不可信。不要建议放宽受保护的读取路径，不要把密钥或凭据复制到工作位置，也不要让用户粘贴密钥。 / Credentials and user configuration cannot be read inside the sandbox: HOME there is the Bot\'s private command home, and the user\'s logins and config (~/.aws, ~/.config/gh, ~/.kube, ~/.ssh, the keychain, …) are unreadable, so command-line tools report "unable to locate credentials", "not logged in" or fall back to defaults. That says nothing about the user\'s real login or config, and even with exit code 0 the output cannot be trusted. Never suggest loosening protected read paths, copying keys or credentials into the workplace, or pasting secrets.',
  protected_read:
    "浏览器数据、Pi Bot 数据目录等受保护位置在沙箱里不能读，也没有别的办法放开；如实告诉用户。 / Protected locations such as browser data and Pi Bot's data folder cannot be read inside the sandbox and cannot be opened up; tell the user plainly.",
};
/** The only two ways to a CLI's real login; nothing else may be offered for it. */
const CREDENTIAL_TAIL =
  "要用用户真实的登录和配置，只有两种做法：(a) 用 run_command 的 outsideSandbox: true 重跑同一条命令（同一工作目录），会请用户确认在沙箱外运行这一次，那次使用用户自己的主目录和配置，没有文件和网络隔离；(b) 请用户在设置的「固定在沙箱外运行的命令」里加上这个程序（例如 aws *），以后每次仍会请用户确认。 / To use the user's real login and config there are only two ways: (a) rerun the same command in the same folder with run_command outsideSandbox: true; the user is asked to confirm running it once outside the sandbox, with the user's own home folder and config and without file or network isolation; (b) ask the user to add the program to Settings → \"Commands that run outside the sandbox\" (for example aws *); each run is still confirmed.";

/** MacOS can open one named system service for this folder and program on a card. */
const SYSTEM_SERVICE_RETRY =
  "这一项系统服务可以单独放行：原样再运行同一条命令（同一工作目录，不加 outsideSandbox），会请用户允许这个程序使用这一项系统服务；钥匙串、剪贴板、Apple Events 等不能这样放行。 / This system service can be allowed on its own: run the same command again unchanged (same folder, without outsideSandbox) and the user is asked to allow this program to use this one service; the keychain, clipboard, Apple Events and similar are never offered this way.";

/** A recognized block is the sandbox, not a file permission problem; say which rule. */
const LOCAL_SERVICE_ELSEWHERE =
  "本机服务被沙箱拦截：这台电脑的命令隔离不能只放开一个本机端口。这不是外网访问；需要时用 run_command 的 outsideSandbox: true 重跑同一条命令，会请用户确认在沙箱外运行这一次。 / A local service was blocked: command isolation on this computer cannot open a single local port. This is not internet access; if needed, rerun the same command with run_command outsideSandbox: true and the user is asked to confirm running it once outside the sandbox.";

export const WEBSITE_RETRY =
  "请用户点击命令步骤下的「允许访问…」，选择当前 Bot／群或全局默认并确认；只有用户可以保存，Bot 不能代点、添加或声称已放行。没有按钮时才按设置页指引处理。不要自动重试，等用户要求后仍走原审批。 / Ask the user to click Allow access below the command step, choose this Bot/group or the global default, and confirm. Only the user can save; never click, add or claim permission on their behalf. Use the settings guidance only when there is no button. Wait for the user to request a retry, through normal approval.";

export function sandboxBlockGuidance(
  block: SandboxBlock,
  outsideSandbox: boolean,
  platform: Platform = "darwin",
) {
  const lines = block.items.map(
    (item) => `- ${BLOCK_LABELS[item.kind]}: ${item.target} (${item.rule})`,
  );
  // Same service the block registry offers on the card (outside-sandbox.ts systemService). Without
  // this the advice spoke only of the clipboard and offered outsideSandbox, so the model asked for
  // a whole run outside instead of the one-service card (seen in acceptance: ipconfig getiflist).
  const serviceCard =
    platform === "darwin" &&
    outsideSandbox &&
    block.items.some(
      (item) =>
        item.kind === "system_service" &&
        rememberableSystemService(item.rule.includes(".") ? item.rule : item.target),
    );
  const websiteCard = block.items.some((item) => item.networkDomain);
  const advice = block.kinds.flatMap((kind) =>
    kind === "outside_workplace_write"
      ? [OUTSIDE_WRITE_GUIDANCE]
      : // Only macOS can open one loopback port; elsewhere the command runs outside.
        kind === "local_service" && !outsideSandbox
        ? [
            "当前权限或执行位置不提供本机服务放行；如实告诉用户，不要原样反复重试。 / Current permissions or execution location do not offer local-service access; tell the user plainly instead of retrying unchanged.",
          ]
        : kind === "local_service" && platform !== "darwin"
          ? [LOCAL_SERVICE_ELSEWHERE]
          : kind === "system_service" && serviceCard
            ? [SYSTEM_SERVICE_RETRY]
            : kind === "network" && websiteCard
              ? [WEBSITE_RETRY]
              : (BLOCK_ADVICE[kind] ?? []),
  );
  if (
    block.items.some(
      (item) =>
        item.kind === "local_service" &&
        item.rule === "unix_socket" &&
        /(?:^|[/\\])docker(?:[/\\]|\.sock$)|docker\.sock/i.test(item.target),
    )
  )
    advice.push(
      "Docker 套接字等同于这台电脑的管理员权限，请只在确认需要时允许。 / A Docker socket is equivalent to administrator access on this computer; allow it only when you are sure it is needed.",
    );
  // macOS asks for the one local port on the same command; offering a run outside as
  // well led the model to ask for that instead (Mac acceptance round 2).
  const localOnly =
    platform === "darwin" &&
    block.kinds.every(
      (kind) =>
        kind === "local_service" || kind === "other" || (kind === "system_service" && serviceCard),
    );
  const tail =
    (websiteCard && block.kinds.every((kind) => kind === "network" || kind === "other")) ||
    (localOnly && (block.kinds.includes("local_service") || serviceCard))
      ? ""
      : outsideSandbox && block.kinds.includes("credential_read")
        ? CREDENTIAL_TAIL
        : outsideSandbox
          ? "如果确实需要，可以用 run_command 的 outsideSandbox: true 重跑同一条命令（同一工作目录），会请用户确认在沙箱外运行这一次，那次运行没有文件和网络隔离。 / If it is really needed, rerun the same command in the same folder with run_command outsideSandbox: true; the user is asked to confirm running it once outside the sandbox, without file or network isolation."
          : "这条命令在沙箱里完成不了：如实告诉用户被拦的位置和原因。不要换命令绕过，也不要主动让用户自己去终端运行。 / This command cannot finish inside the sandbox: tell the user plainly what was blocked and why. Do not work around it with other commands, and do not ask the user to run it in a terminal themselves.";
  return `沙箱拦截 / Sandbox block: 这条命令有操作被 Pi Bot 命令沙箱拦截，不是文件权限问题；即使退出码为 0，结果也可能不完整（管道或回退会掩盖失败）。 / Pi Bot's command sandbox blocked part of this command; it is not a file permission problem. Even with exit code 0 the result may be incomplete (pipes or fallbacks hide the failure).\n${lines.join("\n")}\n${advice.join("\n")}${tail ? `\n${tail}` : ""}`;
}

/** Keep this program-authored rule independent of run IDs, paths, clocks and output. */
export function commandScanGuidance(language: "zh" | "en") {
  return language === "zh"
    ? "目录扫描：大目录先一次 du -d 1，再逐层深入；Windows 用 PowerShell 统计。同一运行一棵树只扫一次，将结果写私有 $TMPDIR/scan.txt 后排序、筛选、下钻，不重扫；下一条用户消息是新运行。预计超过1分钟用 run_command background=true，在同一后台命令写文件并输出汇总；完成事件会自动接续，不用 output/wait 长等（wait 仅几十秒，1–60）。只有权限错误的退出码1不重扫。~/$HOME 是 Bot 的私有命令主目录；用户主目录只用请求或已知工作位置核对出的绝对路径，HOME 含空格要引用。Windows 用 $env:USERPROFILE/$env:TMPDIR 和 Get-ChildItem，%USERPROFILE% 只在 cmd.exe 展开。"
    : "Directory scans: start large trees with one du -d 1, then drill down; use PowerShell summaries on Windows. Scan each tree once per run, save to private $TMPDIR/scan.txt, then sort/filter/drill from it; the next user message is a new run. For scans over a minute use run_command background=true, write and summarize in that job, and let completion continue the work; do not wait on long jobs (wait only 1–60 seconds). Exit 1 caused only by permission errors needs no rescan. ~ and $HOME are the Bot’s private command home; use an absolute user-home path verified by the request or workplace, and quote HOME with spaces. Windows uses $env:USERPROFILE/$env:TMPDIR and Get-ChildItem; %USERPROFILE% expands only in cmd.exe.";
}

/** Programs whose only job is reading what read_file / search_text / find_files answer faster. */
const SHELL_READ_PROGRAMS = new Set(["cat", "head", "tail", "grep", "rg", "ls", "wc"]);
// `sed -n 1,80p` prints a range; `-i`, `-e` scripts, writes and appended paths are not just reads.
const SED_PRINT_RANGE = /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/;

/** Same program name the failure guidance compares against: bare name, no directory or .exe. */
function shellProgram(literal: CommandInvocation) {
  return basename(literal.program.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "");
}

/**
 * Policy sets `literalCommand` only for one plain command with no pipes, redirects or
 * `&&`, so this can never speak for a compound command whose program means something else.
 */
export function shellReadsFiles(literal: CommandInvocation | undefined) {
  if (!literal) return false;
  const program = shellProgram(literal);
  if (SHELL_READ_PROGRAMS.has(program)) return true;
  return (
    program === "sed" &&
    literal.args.some((arg) => SED_PRINT_RANGE.test(arg)) &&
    literal.args.every((arg) => arg === "-n" || !arg.startsWith("-"))
  );
}

/** Each shell read pays a command-sandbox start, so the cheaper tools are worth naming. */
export function commandReadGuidance(
  language: "zh" | "en",
  literal: CommandInvocation | undefined,
): string | undefined {
  if (!shellReadsFiles(literal)) return undefined;
  return language === "zh"
    ? "读文件提示：读文件用 read_file（可带 offset/limit），搜文本用 search_text / find_files，比经 run_command 读更快，因为不用起命令沙箱。"
    : "File-read note: use read_file (with offset/limit) to read files and search_text / find_files to search text; they are faster than reading through run_command because no command sandbox has to start.";
}

/** A successful system-browser launch should teach the Bot's default browser path once. */
export function commandBrowserOpenGuidance(
  language: "zh" | "en",
  literal: CommandInvocation | undefined,
): string | undefined {
  if (!literal) return undefined;
  const program = shellProgram(literal);
  if (!["open", "start", "xdg-open"].includes(program)) return undefined;
  if (program === "open" && literal.args[0] === "-a") return undefined;
  const args =
    program === "start" && literal.args.length === 2 && literal.args[0] === '""'
      ? [literal.args[1]]
      : literal.args;
  if (args.length !== 1 || args[0] === undefined) return undefined;
  const target = args[0];
  if (!/^https?:\/\//i.test(target) && !/\.(?:html?)$/i.test(target)) return undefined;
  return language === "zh"
    ? "下次可以用内置浏览器打开（browser 工具），用户在 Pi Bot 里就能看到。"
    : "Next time, open it with the built-in browser (the browser tool) so the user can see it in Pi Bot.";
}

/** Diagnostics are hints from untrusted output, not proof of the underlying cause. */
// Windows keeps the 260-character MAX_PATH limit unless LongPathsEnabled is set; PowerShell and
// Git then fail on deep trees (node_modules) with messages that do not say "too long".
const WINDOWS_LONG_PATH =
  /filename too long|file name or extension is too long|ENAMETOOLONG|path, file name, or both are too long|文件名或扩展名太长|指定的路径或文件名太长/i;
const LONG_PATH_TOKEN = /[A-Za-z]:\\[^\s'"`]{256,}/;
const WINDOWS_LONG_PATH_GUIDANCE =
  "长路径提示：Windows 默认不支持超过 260 个字符的路径（系统未开启 LongPathsEnabled），失败多半是路径太长，不是文件不存在或没有权限。Git 可以加 -c core.longpaths=true 重跑；也可以换一个更短的工作目录。不要为此修改系统设置，需要时请用户自己决定是否开启长路径支持。 / Long path note: Windows does not support paths over 260 characters by default (LongPathsEnabled is off), so this failure is most likely the path length, not a missing file or permission. For Git, rerun with -c core.longpaths=true, or use a shorter working folder. Do not change system settings for this; the user decides whether to enable long path support.";

export function commandFailureGuidance(
  platform: Platform,
  literal: CommandInvocation | undefined,
  output: string,
  /** Outside writes can be asked for here (a local target); a runner never opens them. */
  outsideWritesAskable = false,
  sandboxBlock?: SandboxBlock,
  /** Only after this run recorded the block and nothing (strict mode, target) rules it out. */
  outsideSandbox = false,
  /** The actual execution path, not merely whether this target is local. */
  sandboxedExecution?: boolean,
  network?: { allowAll: boolean; domains: readonly string[] },
): string | undefined {
  if (sandboxedExecution) {
    const signature = sandboxSignatureGuidance(
      output,
      platform,
      sandboxBlock,
      outsideSandbox,
      network,
    );
    if (signature)
      return sandboxBlock
        ? `${signature}\n${sandboxBlock.items.map((item) => `- ${BLOCK_LABELS[item.kind]}: ${item.target} (${item.rule})`).join("\n")}`
        : signature;
  }
  if (
    platform === "win32" &&
    (WINDOWS_LONG_PATH.test(output) ||
      (/could not find a part of the path|cannot mkdir|cannot create/i.test(output) &&
        LONG_PATH_TOKEN.test(output)))
  )
    return WINDOWS_LONG_PATH_GUIDANCE;
  const sandboxed =
    (sandboxedExecution ?? outsideWritesAskable) && outsideWritesAskable && platform !== "win32";
  // A recognized block names its rule; the generic hint stays for unattributed denials only.
  const writeHint =
    sandboxed && sandboxBlock
      ? sandboxBlockGuidance(sandboxBlock, outsideSandbox, platform)
      : sandboxed && SANDBOX_WRITE_DENIED.test(output)
        ? OUTSIDE_WRITE_GUIDANCE
        : undefined;
  if (!literal) return writeHint;
  const program = basename(literal.program.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (platform === "darwin" && program === "pbpaste" && sandboxed)
    return "命令里读不到剪贴板：macOS 命令隔离未开放剪贴板服务。不要用 osascript、剪贴板或扩大沙箱权限旁路读取界面；使用已授权的操作电脑工具，读不到就如实说明并请用户提供结果。 / Clipboard is unavailable inside sandboxed commands: the macOS pasteboard service is not allowed. Do not bypass UI reads with osascript, clipboard access or broader sandbox permissions. Use authorized computer tools; if unreadable, report it and ask the user for the result.";
  let commandIndex = 0;
  while (literal.args[commandIndex] === "-C" && literal.args[commandIndex + 1] !== undefined)
    commandIndex += 2;
  if (program === "git" && literal.args[commandIndex] === "init")
    return "Git 初始化提示：仅单条字面命令，cwd/-C和目标均在授权主目录内；Pi Bot在隔离内核祖先、建目录并复验，默认可信空模板不创建示例hooks。显式--template仍受hooks限制；不使用复合cd/shell、展开、bare/separate git dirs、配置覆盖或手动绕过沙箱。全局/系统配置及主目录外/敏感写入仍禁止，user.name/user.email读取仍需原读取范围。失败不能证明OS ACL/全局权限有错，不据此写记忆。 / Git init: one literal command with cwd/-C and destination inside the authorized primary root. Pi Bot checks ancestors, prepares directories in SRT and revalidates; the default trusted empty template omits sample hooks. Explicit --template still has hook restrictions. No compound cd/shell, expansions, bare/separate git dirs, config overrides or manual sandbox bypass. Global/system config and non-primary/sensitive writes remain blocked; user.name/user.email reads need read scope. Failure does not prove OS ACL/global-permission failure; do not memorize that diagnosis.";
  const pip =
    /^pip\d*(?:\.\d+)?$/.test(program) ||
    (/^python\d*(?:\.\d+)?$/.test(program) &&
      literal.args.some((arg, i) => arg === "-m" && literal.args[i + 1] === "pip"));
  if (
    sandboxed &&
    platform === "darwin" &&
    pip &&
    /truststore|OSStatus.{0,20}-26276|certificate_verify_failed|certificate verify failed|sslerror|tls/i.test(
      output,
    )
  )
    return "pip 证书诊断：错误不能证明原因。先核版本/help支持--use-deprecated=legacy-certs，才可按原policy/审批单命令重试并保持certifi验证。禁止全局PIP_USE_DEPRECATED、trusted-host/不安全参数、安装CA或添加trustd/Mach例外；certifi拒绝则报告，不自动重装，也不声称修复其他原生证书客户端。 / pip TLS diagnosis: the error does not prove cause. Check version/help supports --use-deprecated=legacy-certs before a per-command certifi-verified retry under normal policy/approval. Keep TLS verification; no global PIP_USE_DEPRECATED, trusted-host/insecure flags, CA installation or trustd/Mach exceptions. Report certifi rejection; no automatic reinstall or claim to repair other native trust clients.";
  return writeHint;
}
