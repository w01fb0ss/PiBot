export type RunnerText = { zh: string; en: string };

export const runnerLanguage = Intl.DateTimeFormat().resolvedOptions().locale.startsWith("zh")
  ? "zh"
  : "en";

export const runnerMessages = {
  invalid_arguments: {
    zh: "无法识别命令或参数。运行 pibot runner --help 查看用法。",
    en: "The command or an option was not recognized. Run pibot runner --help.",
  },
  runner_already_running: {
    zh: "执行端已经在运行。请查看任务栏或菜单栏，或运行 pibot runner status。",
    en: "Pi Bot Runner is already running. Check the tray, or run pibot runner status.",
  },
  runner_lock_invalid: {
    zh: "无法确认哪个执行端正在运行。请重启这台电脑后再试。",
    en: "Pi Bot Runner could not tell which copy is running. Restart this computer and try again.",
  },
  runner_lock_recovery_busy: {
    zh: "另一份执行端正在恢复。请稍候，再试一次。",
    en: "Another copy of Pi Bot Runner is recovering. Wait a moment, then try again.",
  },
  passphrase_required: {
    zh: "需要口令才能保护或打开配对信息。请从终端运行执行端并输入口令。",
    en: "A passphrase is needed to protect or open the pairing details. Run Pi Bot Runner in a terminal to enter it.",
  },
  passphrase_invalid: {
    zh: "这次的口令打不开配对信息。请重试。如果忘了口令，请用新的数据目录启动，再重新配对。",
    en: "This passphrase did not open the pairing details. Try again. If you forgot it, start with a fresh data folder and pair again.",
  },
  passphrase_mismatch: {
    zh: "两次输入的口令不同。请重新启动，再输入两次相同的口令。",
    en: "The two passphrases differed. Start again and enter the same passphrase twice.",
  },
  identity_corrupt: {
    zh: "无法读取本机的配对信息。请从备份恢复，或用新的数据目录启动并重新配对。",
    en: "This computer's pairing details could not be read. Restore a backup or start with a fresh data folder and pair again.",
  },
  system_credentials_failed: {
    zh: "打不开系统的安全凭据存储。请解锁电脑上的凭据存储，然后重新启动执行端。",
    en: "The system's protected credential store could not be opened. Unlock it and start Pi Bot Runner again.",
  },
  drain_incomplete: {
    zh: "有任务还没安全停止。请等任务结束后再试。",
    en: "Some work has yet to stop safely. Wait for it to finish and try again.",
  },
  cancelled: {
    zh: "操作已取消。可以重新开始。",
    en: "The operation was cancelled. You can start again.",
  },
  runner_already_paired: {
    zh: "执行端已与一台电脑配对。若要更换，请先解除配对。",
    en: "Pi Bot Runner is already paired. Unpair before switching computers.",
  },
  runner_pair_failed: {
    zh: "配对未完成。请保持电脑上的配对页面开启，再用新的配对码试一次。",
    en: "Pairing did not finish. Keep the pairing screen open on your computer and try a fresh code.",
  },
  runner_pair_unreachable: {
    zh: "执行端连不上设备所用的转发服务。请检查这台电脑能否上网，再试一次。",
    en: "Pi Bot Runner could not reach the service that links devices. Check this computer's internet connection and try again.",
  },
  invalid_relay: {
    zh: "设备连接地址无效。请输入以 wss:// 开头的地址，且不含登录信息，然后重试。",
    en: "The device connection address is invalid. Enter a wss:// address without sign-in details and try again.",
  },
  pairing_relay_mismatch: {
    zh: "配对码中的连接地址与启动时指定的地址不同。去掉 --relay 选项，再试一次。",
    en: "The pairing code uses a different connection address from the launch options. Remove --relay and try again.",
  },
  invalid_pairing: {
    zh: "执行端无法识别这个配对码。请从电脑上重新复制完整的配对码。",
    en: "Pi Bot Runner could not read this pairing code. Copy the entire code from your computer again.",
  },
  runner_start_failed: {
    zh: "没能启动执行端。请重新打开 Pi Bot 执行端。",
    en: "Pi Bot Runner could not start. Open it again.",
  },
  runner_stop_failed: {
    zh: "执行端还没有停止。请等正在运行的任务结束后，再点「退出」。",
    en: "Pi Bot Runner has yet to stop. Wait for running tasks to finish, then choose Quit again.",
  },
  runner_revoke_failed: {
    zh: "未能确认解除配对。请等正在运行的任务结束，再点「解除配对」。",
    en: "Unpairing could not be confirmed. Wait for running tasks to finish, then choose Unpair again.",
  },
  runner_login_failed: {
    zh: "没能更改登录时启动的设置。请从安装好的 Pi Bot 执行端再试一次。",
    en: "The start-at-login setting could not be changed. Try again from the installed Pi Bot Runner.",
  },
  runner_logs_failed: {
    zh: "打不开日志文件夹。请确认你已登录安装执行端的系统账户，再试一次。",
    en: "The log folder could not be opened. Sign in to the account that installed Pi Bot Runner and try again.",
  },
  runner_control_failed: {
    zh: "操作未完成。请等正在运行的任务结束后再试。",
    en: "The operation did not finish. Wait for running tasks to finish and try again.",
  },
  runner_tray_unsupported: {
    zh: "Linux 上没有执行端菜单。请运行 pibot runner --help 查看可用命令。",
    en: "The Pi Bot Runner tray is unavailable on Linux. Run pibot runner --help for available commands.",
  },
  unsafe_sandbox_environment: {
    zh: "当前的启动配置可能暴露命令内容或允许写入受保护的文件夹。请从系统菜单重新打开已安装的执行端。",
    en: "The current launch settings could expose command text or allow writes to protected folders. Reopen the installed Pi Bot Runner from the system menu.",
  },
  lifecycle_failed: {
    zh: "执行端启动或关闭未完成。请重启这台电脑后再试。",
    en: "Pi Bot Runner could not finish starting or shutting down. Restart this computer and try again.",
  },
  internal: {
    zh: "执行端遇到意外问题。请重新打开 Pi Bot 执行端。",
    en: "Pi Bot Runner ran into a problem. Open it again.",
  },
} satisfies Record<string, RunnerText>;

export type RunnerMessageCode = keyof typeof runnerMessages;

export function isRunnerMessageCode(value: unknown): value is RunnerMessageCode {
  return typeof value === "string" && Object.hasOwn(runnerMessages, value);
}

export function runnerText(zh: string, en: string) {
  return runnerLanguage === "zh" ? zh : en;
}
