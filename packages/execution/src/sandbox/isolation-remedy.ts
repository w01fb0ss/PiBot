/**
 * A Linux host can fail to isolate commands for distinct reasons, and the person
 * who has to fix a headless runner is usually reading one of: the runner's own log, the output of
 * `pibot runner status`, the refusal a tool call returns, or the Linux package's postinst.
 * The pure-data subpath is also consumed by i18n; never import Node/SRT or the execution root here.
 */
export interface IsolationRemedy {
  zh: string;
  en: string;
}

/** A host-wide namespace restriction needs a host whose policy permits isolation. */
export const linuxUserNamespaceRemedies = {
  linux_userns_disabled: {
    zh: "本机的安全策略（kernel.unprivileged_userns_clone=0）禁止创建非特权用户命名空间。请在支持非特权用户命名空间的主机上运行 Pi Bot 或执行端。",
    en: "This host's security policy (kernel.unprivileged_userns_clone=0) blocks unprivileged user namespaces. Run Pi Bot or the runner on a host that supports them.",
  },
  linux_userns_limit_zero: {
    zh: "本机的安全策略（user.max_user_namespaces=0）禁止创建用户命名空间。请在允许创建用户命名空间的主机上运行 Pi Bot 或执行端。",
    en: "This host's security policy (user.max_user_namespaces=0) blocks user namespace creation. Run Pi Bot or the runner on a host that permits user namespaces.",
  },
} as const;

/** A template only: the host escapes the local AppImage path before substitution in the dialog. */
const appImageProfile =
  'abi <abi/4.0>,\ninclude <tunables/global>\nprofile pi-bot-appimage "{appImagePath}" flags=(unconfined) {\n  userns,\n}';

export const linuxAppImageRemedy: IsolationRemedy = {
  zh: `管理员可将下方配置保存为新文件 /etc/apparmor.d/pi-bot-appimage，再运行 sudo apparmor_parser -r /etc/apparmor.d/pi-bot-appimage，然后从同一位置重新打开 Pi Bot。请勿覆盖已有文件。若文件或配置名称已被使用，请为新配置选用另外的名称，并在命令中使用新文件路径。\n\n${appImageProfile}`,
  en: `An administrator can save the profile below as a new file at /etc/apparmor.d/pi-bot-appimage, run sudo apparmor_parser -r /etc/apparmor.d/pi-bot-appimage, then reopen Pi Bot from the same location. Do not overwrite existing files. If the file or profile name is already in use, choose a unique name for the new profile and use the new file path in the command.\n\n${appImageProfile}`,
};

/** AppArmor quoted path syntax still treats glob characters specially. Never generate a wildcard. */
export function appArmorExecutable(path: string | undefined): string {
  if (!path?.startsWith("/") || path.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(path))
    return "/absolute/path/PiBot.AppImage";
  return path.replace(/[\\"*?[\]{}^]/g, (character) => `\\${character}`);
}

export const linuxIsolationRemedies = {
  ...linuxUserNamespaceRemedies,
  linux_userns_restricted: {
    zh: "沙箱探测在创建用户命名空间或设置其权限时失败。请让管理员运行 sudo journalctl -k -g 'apparmor=\"DENIED\"'，确认 AppArmor 拒绝记录中显示的程序和配置。若 /usr/bin/bwrap 已有允许 userns 的 /etc/apparmor.d/bwrap 配置但未加载，可运行 sudo apparmor_parser -r /etc/apparmor.d/bwrap。若被拒绝的是其他程序，由管理员按其实际路径检查配置。修复后重启 Pi Bot 或执行端。",
    en: "The sandbox probe failed while creating a user namespace or setting up its permissions. Ask an administrator to run sudo journalctl -k -g 'apparmor=\"DENIED\"' and check which executable and profile AppArmor names. If /usr/bin/bwrap already has a userns-enabled profile at /etc/apparmor.d/bwrap and it has yet to load, run sudo apparmor_parser -r /etc/apparmor.d/bwrap. For another executable, have the administrator review the profile attached to its exact path. Restart Pi Bot or the runner after the fix.",
  },
  linux_ripgrep_unavailable: {
    zh: "无法执行命令隔离所需的 ripgrep。请检查安装包完整性以及随包提供的 rg 是否可执行，然后重启 Pi Bot 或执行端。",
    en: "Command isolation could not find or execute ripgrep. Check the package integrity and whether its bundled rg is executable, then restart Pi Bot or the runner.",
  },
  linux_sandbox_host_unavailable: {
    zh: "命令隔离的宿主进程无法载入随包提供的资源。请重新安装 Pi Bot 或执行端，然后重启。",
    en: "The command isolation host could not load its bundled resources. Reinstall Pi Bot or the runner, then restart it.",
  },
  linux_bubblewrap_missing: {
    zh: "命令隔离在宿主进程的 PATH 中找不到 bubblewrap（bwrap）。已安装时，请检查启动环境的 PATH。未安装时，Debian/Ubuntu 可运行 sudo apt install bubblewrap，Fedora 可运行 sudo dnf install bubblewrap。修复后重启 Pi Bot 或执行端。",
    en: "The isolation host could not find bubblewrap (bwrap) on its PATH. If installed, check the launch environment's PATH. To install it, run sudo apt install bubblewrap on Debian/Ubuntu or sudo dnf install bubblewrap on Fedora. Restart Pi Bot or the runner after the fix.",
  },
  linux_socat_missing: {
    zh: "命令隔离在宿主进程的 PATH 中找不到 socat。已安装时，请检查启动环境的 PATH。未安装时，Debian/Ubuntu 可运行 sudo apt install socat，Fedora 可运行 sudo dnf install socat。修复后重启 Pi Bot 或执行端。",
    en: "The isolation host could not find socat on its PATH. If installed, check the launch environment's PATH. To install it, run sudo apt install socat on Debian/Ubuntu or sudo dnf install socat on Fedora. Restart Pi Bot or the runner after the fix.",
  },
  linux_seccomp_helper_unavailable: {
    zh: "无法执行命令隔离的 apply-seccomp 辅助程序。请确认安装包完整、辅助程序可执行，且其目录在沙箱内只读可见；可重新安装执行端后重启。不要开放整个临时目录，也不要关闭沙箱。",
    en: "The apply-seccomp isolation helper could not run. Check package integrity, executable permissions, and readonly visibility of its directory inside the sandbox; reinstall the execution device package and restart if needed. Keep the rest of the temporary directory hidden and the sandbox enabled.",
  },
  sandbox_dependencies_or_runtime_unavailable: {
    zh: "隔离探测失败。请查看 pibot runner status 中的失败阶段和报错摘要；若失败发生在沙箱内，请让管理员检查同一时间的内核拒绝日志。",
    en: "The isolation probe failed. Check pibot runner status for the failing stage and error summary. If the failure occurred inside the sandbox, ask an administrator to check the kernel audit log for denials at that time.",
  },
} satisfies Record<string, IsolationRemedy>;

/** Only Linux codes carry a concrete fix; other platforms report their state without one. */
export function linuxIsolationRemedy(reason: string | undefined): IsolationRemedy | undefined {
  const remedies: Record<string, IsolationRemedy> = linuxIsolationRemedies;
  return reason && Object.hasOwn(remedies, reason) ? remedies[reason] : undefined;
}
