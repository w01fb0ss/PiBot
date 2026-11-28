// The run-as-me switch and start-failure reasons of local stdio MCPs.
export const connectorSandboxZh = {
  "connectors.nativeConfirmationTimedOut":
    "系统确认已超时并取消。请重新操作，并在 5 分钟内完成确认。",
  "connectors.nativeConfirmationWaiting": "请在系统对话框里确认。如果已有确认框打开，请先处理它。",
  "connectors.startFailure.reason.command_not_found_windows": "找不到这个连接需要的程序。",
  "connectors.importReason.manifest_not_found":
    "找不到插件清单、MCP 配置或可导入的技能。请选择插件的根文件夹。",
  "connectors.importReason.mcp_duplicate":
    "插件里重复声明了同名 MCP。请在来源配置中去掉重复项后重试。",
  "connectors.importReason.path_outside_plugin":
    "插件引用的文件超出了插件文件夹。请修正来源中的相对路径。",
  "connectors.importReason.file_too_large": "插件文件超过导入大小上限。请缩小文件后重试。",
  "connectors.importReason.layout_unsupported":
    "插件格式或目录结构不受支持，或来源在读取时发生了变化。请检查插件清单后重新选择。",
  "connectors.sourceDetails.before": "改动前",
  "connectors.sourceDetails.after": "改动后",
  "connectors.sourceDetails.command": "启动命令",
  "connectors.sourceDetails.arguments": "参数（展开查看）",
  "connectors.sourceDetails.envNames": "环境变量名（不显示值）",
  "connectors.sourceDetails.websites": "允许访问的网站",
  "connectors.sourceDetails.files": "插件文件",
  "connectors.sourceDetails.added": "新增",
  "connectors.sourceDetails.removed": "移除",
  "connectors.sourceDetails.truncated": "清单较长，只显示前 300 个新增和前 300 个移除的文件。",

  "connectors.audit.network": "已修改连接允许访问的网站",
  "connectors.startup.cwd": "工作目录：{cwd}",
  "connectors.startup.timeout": "启动超时：{seconds} 秒",
  "connectors.network.advanced": "高级：手动编辑允许的网站",
  "connectors.network.requestTitle": "{name} 想访问一个新网站",
  "connectors.network.requestNote": "它在沙箱里运行，只能连你允许的网站。",
  "connectors.network.allowRemember": "允许，以后不再问",
  "connectors.network.connection": "此连接",
  "connectors.network.declared": "由连接声明",
  "connectors.network.blocked": "被拦下的网站：{host}",
  "connectors.network.allow": "允许",
  "connectors.network.reset": "撤销拒绝",
  "connectors.network.unisolated": "此连接在沙箱外运行，允许的网站列表不适用。",
  "connectors.network.remote": "此远程连接使用已配置的服务器地址。",
  "connectors.network.revokeRemote": "停止访问 {host}",
  "connectors.network.revokeRemoteNote": "再次允许之前，此连接将无法访问网站或登录授权。",
  "connectors.network.revoke": "撤销网站访问",
  "connectors.network.confirmRevoke": "确认撤销",
  "connectors.network.confirmAllow": "确认允许",
  "connectors.network.remoteConsent":
    "重试连接时，Pi Bot 可以向此网站发送请求和此连接已保存的密钥。",
  "connectors.network.error": "连接访问 {host} 时被拦下。",
  "connectors.network.errorAction": "可在此连接的设置中点击「允许」。",
  "connectors.network.reason.private": "本机、局域网和云元数据地址不能访问。",
  "connectors.network.reason.ip": "只能使用网站域名。",
  "connectors.network.reason.dns": "无法确认该域名解析到公开地址。",
  "connectors.network.reason.scheme": "只支持 HTTP 和 HTTPS 网站地址。",
  "connectors.network.reason.denied": "你拒绝了这次访问请求。",
  "connectors.network.reason.unattended": "当时无人确认。",
  "connectors.network.reason.timeout": "确认已结束。",
  "connectors.network.reason.limit": "允许的网站列表已满。",
  "connectors.network.reason.rate_limit": "网站访问确认请求过多，请稍后再试。",
  "connectors.network.title": "允许访问的网站",
  "connectors.network.note":
    "每行一个网站域名，最多 64 个，不含网址前缀或路径。80 和 443 以外的端口请注明。保存后会重启连接。",
  "connectors.network.invalid": "请输入有效的网站域名，最多 64 个。80 和 443 以外的端口请注明。",
  "connectors.network.save": "保存网站设置",
  "connectors.audit.startupTimeout": "已更新连接启动等待时间",
  "connectors.audit.outsideSandboxOn": "已设置本机 MCP 在沙箱外运行（以你的身份）",
  "connectors.audit.outsideSandboxOff": "本机 MCP 已回到沙箱里运行",
  "connectors.outsideSandbox.badge": "在沙箱外运行",
  "connectors.outsideSandbox.title": "沙箱",
  "connectors.outsideSandbox.switch": "在沙箱外运行（以你的身份）",
  "connectors.outsideSandbox.note":
    "在 macOS 和 Linux 上，Pi Bot 默认阻止这条连接读取某些敏感位置的文件，例如默认的 SSH 密钥文件夹和部分浏览器的用户资料文件夹。Pi Bot 也会阻止它读取 Pi Bot 的数据文件夹，插件获准访问的文件夹除外。连接仍可能读取你的账户有权读取的其他文件，包括你的文档。Pi Bot 也会限制它能写入的位置和能访问的网站。打开此开关时，系统会先请你确认。确认后，Pi Bot 会解除上述限制，连接会以你的账户权限运行。Bot 调用这条连接的工具时仍遵循上面的确认设置，并留下记录。",
  "connectors.outsideSandbox.cancelled": "已取消，它仍在沙箱里运行。",
  "connectors.outsideSandbox.on": "正以你的身份运行，没有沙箱隔离。关掉后回到沙箱里运行。",
  "connectors.outsideSandbox.reconfirm": "这个 MCP 的配置变了，之前的确认已失效。请重新确认。",
  "connectors.outsideSandbox.suggest.ai_config_path":
    "它的命令在另一个 AI 工具的设置文件夹里（例如 ~/.codex、~/.claude），沙箱看不到那里，在沙箱里多半启动不了。如果你信任它，可以让它在沙箱外运行。",
  "connectors.outsideSandbox.suggest.sandbox_start_failed":
    "它在沙箱里没能启动。如果它需要你的钥匙串、登录或本机工具，而你信任它，可以让它在沙箱外运行。",
  "connectors.startFailure.launcher.node":
    "无法启动 Node.js（node）。这条连接用它运行 JavaScript。安装后请重试。",
  "connectors.startFailure.launcher.npx":
    "无法启动 npx。这条连接用它打开 JavaScript 程序。安装 Node.js 时请一并安装 npm，再重试。",
  "connectors.startFailure.launcher.uvx":
    "无法启动 uvx。这条连接用它打开 Python 程序。安装包含 uvx 的 uv，再重试。",
  "connectors.startFailure.launcherIssue.windows_wrapper":
    "Pi Bot 在 Windows 上无法直接打开 {program} 的命令脚本。请向连接提供方获取 Windows 可执行程序或在线连接地址，更新配置后再试。",
  "connectors.startFailure.launcherIssue.configured_path":
    "Pi Bot 无法从连接设置中保存的位置打开 {program}。如果程序已安装，请更新为它现在的位置，或向连接提供方获取更新后的配置，然后重试。",
  "connectors.startFailure.installNode": "下载 Node.js 长期支持版",
  "connectors.startFailure.installUv": "查看 uv 安装说明",
  "connectors.startFailure.alreadyInstalled": "已经装过？",
  "connectors.startFailure.setupWindows":
    "打开「权限 › 命令环境」，添加程序所在的文件夹，然后重试。",
  "connectors.startFailure.setupUnix":
    "打开「权限 › 命令环境」，添加程序所在的文件夹。如果安装在 Homebrew、~/.local/bin 或 nvm 中，可选择「从终端环境导入」，找到它的位置后再重试。",
  "connectors.startFailure.advanced": "高级",
  "connectors.startFailure.title": "没能启动的原因",
  "connectors.startFailure.reason.sandbox_start_failed":
    "Pi Bot 未能启动打开这条连接所需的系统保护。请在「设置 › 权限」检查后重试。",
  "connectors.startFailure.reason.sandbox_denied": "沙箱挡住了它需要的东西，它因此没能启动。",
  "connectors.startFailure.reason.command_not_found":
    "找不到或无法打开这条连接需要的程序。请按连接提供方的说明安装，再重试。",
  "connectors.startFailure.reason.password_prompt":
    "这个 MCP 想在终端里要密码，但这里没有终端可以输入。请在「终端」里运行一次它的登录命令，然后重启连接。",
  "connectors.startFailure.reason.login_required":
    "这个 MCP 说要先登录。请在「终端」里运行一次它的登录命令，然后重启连接。",
  "connectors.startFailure.reason.dependency_missing":
    "它启动时缺少需要的模块，或者装上的依赖版本和它不兼容（展开下面的「高级」可以查看可用的详细信息）。请在它的来源配置里改好依赖（例如给版本加上限），再重新带过来或重启连接。",
  "connectors.startFailure.reason.timeout": "它在规定时间内没有应答。",
  "connectors.startFailure.reason.exited":
    "它启动后就退出了。展开下面的「高级」可以查看可用的详细信息。",
  "connectors.startFailure.reason.protocol_error": "它在运行，但没有按 MCP 协议应答。",
  "connectors.startFailure.reason.outside_sandbox_reconfirm":
    "配置变了，需要重新确认在沙箱外运行，所以没有启动。",
  "connectors.startFailure.reason.location_refused":
    "它要从一个受保护的文件夹启动（例如 Pi Bot 自己的数据文件夹，或另一个连接的文件夹），为了你的数据安全没有启动它。如果它是导入的插件包，删除后重新导入；如果是你写的配置，把它的工作文件夹改到别处。",
  "connectors.startFailure.reason.config_invalid":
    "它保存的启动设置不能用（例如环境变量的名字不合规），所以没有启动。改好它的来源配置后重新带过来。",
  "connectors.startFailure.reason.proxy_scheme":
    "此连接需要 HTTP 或 HTTPS 代理。请在网络代理设置中选择 HTTP 或 HTTPS，再重试。",
  "connectors.startFailure.reason.unknown": "启动失败，原因不明。",
  "connectors.startFailure.loginHint":
    "这类脚本通常有单独的登录命令：把它启动命令里的 run 换成 login（或先看它的 --help），在终端里运行一次。登录信息存好后，再打开这里的连接。",
  "connectors.startFailure.exitCode": "退出码 {code}",
  "connectors.startFailure.signal": "被 {signal} 结束",
  "connectors.startFailure.timedOut": "超时",
  "connectors.startFailure.where.sandbox": "在沙箱里",
  "connectors.startFailure.where.outside": "在沙箱外",
  "connectors.startFailure.denials": "沙箱拒绝了：",
  "connectors.startFailure.denial.credential_read": "读取登录信息 {target}",
  "connectors.startFailure.denial.protected_read": "读取受保护的位置 {target}",
  "connectors.startFailure.denial.keychain": "钥匙串",
  "connectors.startFailure.denial.system_service": "系统服务 {target}",
  "connectors.startFailure.denial.network": "连接 {target}",
  "connectors.startFailure.denial.other": "{target}",
  "connectors.startFailure.stderr": "它最后的输出（已隐去密钥）",
  "connectors.startFailure.restartToSee": "重启这个连接，就能看到这次没启动的原因。",
} as const;

export const connectorSandboxEn: Record<keyof typeof connectorSandboxZh, string> = {
  "connectors.nativeConfirmationTimedOut":
    "The system confirmation timed out and was cancelled. Try again and confirm within 5 minutes.",
  "connectors.nativeConfirmationWaiting":
    "Please confirm in the system dialog. If a confirmation dialog is already open, answer it first.",
  "connectors.startFailure.reason.command_not_found_windows":
    "Pi Bot couldn’t find the program this connection needs.",
  "connectors.importReason.manifest_not_found":
    "No plugin manifest, MCP configuration or importable skill was found. Select the plugin root folder.",
  "connectors.importReason.mcp_duplicate":
    "The plugin declares the same MCP more than once. Remove the duplicate from its source configuration and try again.",
  "connectors.importReason.path_outside_plugin":
    "A referenced file is outside the plugin folder. Correct the relative path in the source.",
  "connectors.importReason.file_too_large":
    "A plugin file exceeds the import size limit. Reduce its size and try again.",
  "connectors.importReason.layout_unsupported":
    "The plugin format or folder layout is unsupported, or its source changed while being read. Check the manifest and select it again.",
  "connectors.sourceDetails.before": "Before",
  "connectors.sourceDetails.after": "After",
  "connectors.sourceDetails.command": "Command",
  "connectors.sourceDetails.arguments": "Arguments (expand to view)",
  "connectors.sourceDetails.envNames": "Environment variable names (values hidden)",
  "connectors.sourceDetails.websites": "Allowed websites",
  "connectors.sourceDetails.files": "Plugin files",
  "connectors.sourceDetails.added": "Added",
  "connectors.sourceDetails.removed": "Removed",
  "connectors.sourceDetails.truncated": "This list shows up to 300 added and 300 removed files.",

  "connectors.audit.network": "Connection allowed websites changed",
  "connectors.startup.cwd": "Working directory: {cwd}",
  "connectors.startup.timeout": "Startup timeout: {seconds} seconds",
  "connectors.network.advanced": "Advanced: manually edit allowed websites",
  "connectors.network.requestTitle": "{name} wants to reach a new website",
  "connectors.network.requestNote": "It runs in the sandbox and can only reach websites you allow.",
  "connectors.network.allowRemember": "Allow, don't ask again",
  "connectors.network.connection": "This connection",
  "connectors.network.declared": "Declared by the connection",
  "connectors.network.blocked": "Blocked website: {host}",
  "connectors.network.allow": "Allow",
  "connectors.network.reset": "Undo denial",
  "connectors.network.unisolated":
    "This connection runs outside the sandbox. An allowed websites list does not apply.",
  "connectors.network.remote": "This connection uses the configured remote server address.",
  "connectors.network.revokeRemote": "Stop access to {host}",
  "connectors.network.revokeRemoteNote":
    "This connection cannot reach the website or sign in until you allow it again.",
  "connectors.network.revoke": "Revoke website access",
  "connectors.network.confirmRevoke": "Confirm revocation",
  "connectors.network.confirmAllow": "Confirm and allow",
  "connectors.network.remoteConsent":
    "When you retry, Pi Bot can send requests and this connection’s saved keys to this website.",
  "connectors.network.error": "The connection was blocked from reaching {host}.",
  "connectors.network.errorAction":
    "Choose Allow next to the blocked website in the connection’s settings.",
  "connectors.network.reason.private":
    "Local, private network and cloud metadata addresses are blocked.",
  "connectors.network.reason.ip": "Only website hostnames are allowed.",
  "connectors.network.reason.dns": "The hostname could not be verified as publicly reachable.",
  "connectors.network.reason.scheme": "Only HTTP and HTTPS website addresses are supported.",
  "connectors.network.reason.denied": "You denied this request.",
  "connectors.network.reason.unattended": "No one was available to approve it.",
  "connectors.network.reason.timeout": "The approval window ended.",
  "connectors.network.reason.limit": "The allowed websites list is full.",
  "connectors.network.reason.rate_limit": "Too many website approval requests. Try again later.",
  "connectors.network.title": "Allowed websites",
  "connectors.network.note":
    "One website hostname per line, up to 64, without a scheme or path. Include ports other than 80 and 443. Saving restarts the connection.",
  "connectors.network.invalid":
    "Enter up to 64 valid website hosts. Include the port when it is other than 80 or 443.",
  "connectors.network.save": "Save website settings",
  "connectors.audit.startupTimeout": "Updated the connection startup wait",
  "connectors.audit.outsideSandboxOn": "Local MCP set to run outside the sandbox (as you)",
  "connectors.audit.outsideSandboxOff": "Local MCP returned to the sandbox",
  "connectors.outsideSandbox.badge": "Runs outside the sandbox",
  "connectors.outsideSandbox.title": "Sandbox",
  "connectors.outsideSandbox.switch": "Run outside the sandbox (as you)",
  "connectors.outsideSandbox.note":
    "On macOS and Linux, Pi Bot blocks the connection from reading files in certain sensitive locations by default, such as the default SSH key folder and some browser profile folders. Pi Bot also blocks reads from its own data folder, except in folders granted to the plugin. The connection may still read other files your account can read, including your documents. Pi Bot also limits where it can write files and which websites it can reach. Turning on this switch opens a system dialog. If you confirm, Pi Bot removes these limits and the connection runs with your account’s permissions. Bot tool calls still follow the confirmation setting above and are logged.",
  "connectors.outsideSandbox.cancelled": "Cancelled; it still runs in the sandbox.",
  "connectors.outsideSandbox.on":
    "Running as you, without the sandbox. Turn it off to return to the sandbox.",
  "connectors.outsideSandbox.reconfirm":
    "This MCP's configuration changed, so the earlier confirmation no longer applies. Confirm again to continue.",
  "connectors.outsideSandbox.suggest.ai_config_path":
    "Its command is inside another AI tool's settings folder (such as ~/.codex or ~/.claude), which the sandbox cannot see, so it will most likely not start in the sandbox. If you trust it, you can run it outside the sandbox.",
  "connectors.outsideSandbox.suggest.sandbox_start_failed":
    "It did not start in the sandbox. If it needs your Keychain, a login or local tools, and you trust it, you can run it outside the sandbox.",
  "connectors.startFailure.launcher.node":
    "Couldn’t start Node.js (node). This connection uses it to run JavaScript. Install it and try again.",
  "connectors.startFailure.launcher.npx":
    "Couldn’t start npx, which opens the JavaScript program for this connection. Install Node.js with npm, then try again.",
  "connectors.startFailure.launcher.uvx":
    "Couldn’t start uvx, which opens the Python program for this connection. Install uv, which includes uvx, then try again.",
  "connectors.startFailure.launcherIssue.windows_wrapper":
    "Pi Bot can’t open the command script for {program} directly on Windows. Ask the connection provider for a Windows executable or a hosted connection URL, then update the connection and retry.",
  "connectors.startFailure.launcherIssue.configured_path":
    "Pi Bot couldn’t open {program} at the location saved in this connection. If it’s installed, update the location or ask the connection provider for an updated configuration, then retry.",
  "connectors.startFailure.installNode": "Download Node.js LTS",
  "connectors.startFailure.installUv": "Open uv installation instructions",
  "connectors.startFailure.alreadyInstalled": "Already installed?",
  "connectors.startFailure.setupWindows":
    "Open Permissions → Command environment, add the program’s folder, then try again.",
  "connectors.startFailure.setupUnix":
    "Open Permissions → Command environment and add the program’s folder. For Homebrew, ~/.local/bin or nvm, you can import the terminal environment to find its location. Then try again.",
  "connectors.startFailure.advanced": "Advanced",
  "connectors.startFailure.title": "Why it did not start",
  "connectors.startFailure.reason.sandbox_start_failed":
    "Pi Bot couldn’t start the system protection needed to open this connection. Check Settings → Permissions, then retry.",
  "connectors.startFailure.reason.sandbox_denied":
    "The sandbox blocked something it needs, so it did not start.",
  "connectors.startFailure.reason.command_not_found":
    "Pi Bot couldn’t open the program this connection needs. Follow the connection provider’s installation instructions, then try again.",
  "connectors.startFailure.reason.password_prompt":
    "This connection needs you to sign in using Terminal.",
  "connectors.startFailure.reason.login_required": "This connection requires you to sign in first.",
  "connectors.startFailure.reason.dependency_missing":
    "It is missing a module it needs, or the installed dependency version is incompatible with it (expand Advanced below for available details). Fix the dependency in its source configuration, for example by capping the version, then bring it over again or restart the connection.",
  "connectors.startFailure.reason.timeout": "It did not answer in time.",
  "connectors.startFailure.reason.exited":
    "It exited right after starting. Expand Advanced below for available details.",
  "connectors.startFailure.reason.protocol_error":
    "The program started but did not respond as expected.",
  "connectors.startFailure.reason.outside_sandbox_reconfirm":
    "Its configuration changed, so running outside the sandbox needs a new confirmation; it was not started.",
  "connectors.startFailure.reason.location_refused":
    "It would start from a protected folder (such as Pi Bot's own data folder or another connection's folder), so it was not started to keep your data safe. If it is an imported plugin package, remove it and import it again; if you wrote its configuration, move its working folder elsewhere.",
  "connectors.startFailure.reason.config_invalid":
    "Its saved start settings cannot be used (for example an environment variable name is not valid), so it was not started. Fix its source configuration, then bring it over again.",
  "connectors.startFailure.reason.proxy_scheme":
    "This connection needs an HTTP or HTTPS proxy. Choose one in Network Proxy settings and retry.",
  "connectors.startFailure.reason.unknown": "It failed to start for an unknown reason.",
  "connectors.startFailure.loginHint":
    "Scripts like this usually have a separate login command: replace run with login in its start command (or check its --help first) and run it once in Terminal. Once the login is saved, turn the connection on here again.",
  "connectors.startFailure.exitCode": "Exit code {code}",
  "connectors.startFailure.signal": "Ended by {signal}",
  "connectors.startFailure.timedOut": "Timed out",
  "connectors.startFailure.where.sandbox": "In the sandbox",
  "connectors.startFailure.where.outside": "Outside the sandbox",
  "connectors.startFailure.denials": "The sandbox refused:",
  "connectors.startFailure.denial.credential_read": "Reading login data {target}",
  "connectors.startFailure.denial.protected_read": "Reading a protected location {target}",
  "connectors.startFailure.denial.keychain": "Keychain",
  "connectors.startFailure.denial.system_service": "System service {target}",
  "connectors.startFailure.denial.network": "Connecting to {target}",
  "connectors.startFailure.denial.other": "{target}",
  "connectors.startFailure.stderr": "Its last output (secrets hidden)",
  "connectors.startFailure.restartToSee": "Restart this connection to see why it did not start.",
};
