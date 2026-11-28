import { listenAddress } from "./direct.ts";
import { runnerText } from "./messages.ts";
export type RunnerCommand =
  | "start"
  | "stop"
  | "status"
  | "pair"
  | "revoke"
  | "tray"
  | "install-service"
  | "uninstall-service";

export type RunnerArguments =
  | { kind: "help" }
  | { kind: "version" }
  | {
      kind: "command";
      command: RunnerCommand;
      name?: string;
      code?: string;
      listen?: string[];
      relay?: string;
      /** A proxy URL for relay connections, or "direct" to ignore every proxy setting. */
      proxy?: string;
      dataDir?: string;
      logLevel?: "info" | "warn" | "error";
      daemon?: boolean;
      json?: boolean;
    };

export function usage() {
  return [
    runnerText("用法：pibot runner <命令>", "Usage: pibot runner <command>"),
    runnerText(
      "  start / stop / status             启动、停止或查看状态",
      "  start / stop / status             Start, stop or check status",
    ),
    runnerText(
      "  pair [配对码]                      输入电脑给出的配对码",
      "  pair [code]                       Pair using the code from your computer",
    ),
    runnerText(
      "  revoke / tray                     解除配对，或打开 Mac / Windows 的菜单",
      "  revoke / tray                     Unpair or open the Mac / Windows tray",
    ),
    runnerText(
      "  install-service / uninstall-service   添加或移除 Linux 的用户服务",
      "  install-service / uninstall-service   Add or remove the Linux user service",
    ),
    "",
    runnerText("高级选项", "Advanced options"),
    "  start [--daemon] [--listen <IP:port>]",
    "  start|pair [--name <name>] [--relay <URL>] [--proxy <URL|direct>]",
    "  status [--json]",
    "  --data-dir <directory> --log-level <info|warn|error>",
    runnerText(
      "可以通过 --proxy 指定设备连接用的代理。想在忘记口令后重新配对，可用 --data-dir 选择一个新的空文件夹，再在电脑上移除旧配对。",
      "Use --proxy to choose a proxy for device connections. If you forgot the passphrase, use --data-dir to choose a fresh, empty folder and remove the old pairing on your computer.",
    ),
    "  PIBOT_DATA_DIR, PIBOT_RUNNER_RELAY, PIBOT_RUNNER_PASSPHRASE",
    "  HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, NO_PROXY",
  ].join("\n");
}

export function parseArguments(input: readonly string[]): RunnerArguments {
  const args = input[0] === "runner" ? input.slice(1) : [...input];
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  const command = args[0] as RunnerCommand;
  if (
    ![
      "start",
      "stop",
      "status",
      "pair",
      "revoke",
      "tray",
      "install-service",
      "uninstall-service",
    ].includes(command) ||
    args.length > 40
  )
    throw new TypeError("invalid_arguments");
  const result: Extract<RunnerArguments, { kind: "command" }> = { kind: "command", command };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (command === "pair" && !flag.startsWith("--") && !result.code) {
      if (flag.length > 1152) throw new TypeError("invalid_arguments");
      result.code = flag;
      continue;
    }
    if (flag !== "--listen" && seen.has(flag)) throw new TypeError("invalid_arguments");
    seen.add(flag);
    if (flag === "--daemon" && command === "start") result.daemon = true;
    else if (flag === "--json" && command === "status") result.json = true;
    else {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--") || /[\0\r\n]/.test(value))
        throw new TypeError("invalid_arguments");
      if (flag === "--data-dir") result.dataDir = value;
      else if (flag === "--log-level" && ["info", "warn", "error"].includes(value))
        result.logLevel = value as "info" | "warn" | "error";
      else if (flag === "--relay" && ["start", "pair", "tray", "install-service"].includes(command))
        result.relay = value;
      else if (
        flag === "--proxy" &&
        ["start", "pair", "tray", "install-service"].includes(command) &&
        value.length <= 2048
      )
        result.proxy = value;
      else if (
        flag === "--name" &&
        ["start", "pair", "tray", "install-service"].includes(command) &&
        value.length <= 200
      )
        result.name = value;
      else if (flag === "--listen" && ["start", "install-service"].includes(command)) {
        result.listen ??= [];
        if (result.listen.length >= 8) throw new TypeError("invalid_arguments");
        result.listen.push(listenAddress(value).address);
      } else throw new TypeError("invalid_arguments");
    }
  }
  return result;
}
