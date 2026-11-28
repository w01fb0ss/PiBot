import { linuxAppImageRemedy } from "@pibot/execution/isolation-remedy";

// Also used before Chromium starts: this dialog cannot rely on a renderer or saved preferences.
export const linuxStartupZh = {
  "linuxStartup.advanced": "高级",
  "linuxStartup.close": "关闭",
  "linuxStartup.apparmorDetails": linuxAppImageRemedy.zh,
  "linuxStartup.apparmorDebDetails":
    "请管理员运行 sudo apparmor_parser -r /etc/apparmor.d/pi-bot。如果配置文件缺失，请确认已安装 AppArmor，再重新安装 Pi Bot，然后重新打开。",
  "linuxStartup.flagsDetails":
    "移除关闭系统保护的启动参数（如 --no-sandbox）和 ELECTRON_DISABLE_SANDBOX 环境变量，再重新打开。",
  "linuxStartup.title": "Pi Bot 无法安全启动",
  "linuxStartup.intro": "Pi Bot 需要系统保护来限制应用进程可以访问的内容。",
  "linuxStartup.flags": "启动设置关闭了必需的系统保护。请用默认设置重新打开 Pi Bot。",
  "linuxStartup.root": "请退出管理员会话，用普通用户账号打开 Pi Bot。",
  "linuxStartup.clone": "这台电脑禁止普通用户启动 Pi Bot 所需的系统保护。请让管理员查看高级说明。",
  "linuxStartup.cloneDetails":
    "请管理员检查 kernel.unprivileged_userns_clone。当前值为 0，禁止普通用户创建 Pi Bot 用于隔离进程的用户命名空间。请按系统的安全要求处理后重新打开 Pi Bot。",
  "linuxStartup.max": "这台电脑允许创建的隔离环境数量被设为零。请让管理员查看高级说明。",
  "linuxStartup.maxDetails":
    "请管理员检查 user.max_user_namespaces。当前值为 0，系统无法创建 Pi Bot 用于隔离进程的用户命名空间。请按系统的安全要求处理后重新打开 Pi Bot。",
  "linuxStartup.apparmor":
    "这台电脑的 AppArmor 安全设置可能阻止 Pi Bot 启动。请让管理员查看高级说明。",
  "linuxStartup.useDeb":
    "如果使用 Ubuntu 24.04 或更新版本，可以从 pibot.space 下载 Pi Bot 的 .deb 安装包。它附带本应用的安全配置。",
  "linuxStartup.apparmorDeb": "Pi Bot 随安装包提供的安全配置可能未生效。请让管理员查看高级说明。",
  "linuxStartup.runtime":
    "系统保护没有启动。请在普通用户的桌面会话中重新打开 Pi Bot。如果仍然失败，请让管理员检查系统安全设置。",
} as const;

export const linuxStartupEn = {
  "linuxStartup.advanced": "Advanced",
  "linuxStartup.close": "Close",
  "linuxStartup.apparmorDetails": linuxAppImageRemedy.en,
  "linuxStartup.apparmorDebDetails":
    "Ask an administrator to run sudo apparmor_parser -r /etc/apparmor.d/pi-bot. If the profile is missing, check that AppArmor is installed, reinstall Pi Bot, and reopen it.",
  "linuxStartup.flagsDetails":
    "Remove any launch options that disable system protection (such as --no-sandbox) and the ELECTRON_DISABLE_SANDBOX environment variable, then reopen Pi Bot.",
  "linuxStartup.title": "Pi Bot cannot start safely",
  "linuxStartup.intro":
    "Pi Bot needs system protection to limit what its app processes can access.",
  "linuxStartup.flags":
    "The launch settings turn off required system protection. Reopen Pi Bot with its default launch settings.",
  "linuxStartup.root":
    "Leave the administrator session and open Pi Bot with a regular user account.",
  "linuxStartup.clone":
    "This computer prevents regular users from starting the system protection Pi Bot needs. Ask an administrator to check the advanced instructions.",
  "linuxStartup.cloneDetails":
    "Ask your administrator to check kernel.unprivileged_userns_clone. It is set to 0, which prevents regular users from creating the user namespaces Pi Bot uses to isolate its processes. Reopen Pi Bot after the administrator addresses this under your system’s security requirements.",
  "linuxStartup.max":
    "The system limit for creating isolated environments is set to zero. Ask an administrator to check the advanced instructions.",
  "linuxStartup.maxDetails":
    "Ask your administrator to check user.max_user_namespaces. It is set to 0, which prevents the system from creating the user namespaces Pi Bot uses to isolate its processes. Reopen Pi Bot after the administrator addresses this under your system’s security requirements.",
  "linuxStartup.apparmor":
    "This computer’s AppArmor security settings may be stopping Pi Bot from starting. Ask your administrator to check the advanced instructions.",
  "linuxStartup.useDeb":
    "On Ubuntu 24.04 or later, you can get the .deb installer from pibot.space. It includes the security configuration for this app.",
  "linuxStartup.apparmorDeb":
    "The security configuration supplied with Pi Bot may not be active. Ask your administrator to check the advanced instructions.",
  "linuxStartup.runtime":
    "System protection couldn’t start. Reopen Pi Bot from a regular user’s desktop session. If it still fails, ask an administrator to check the system’s security settings.",
} as const;
