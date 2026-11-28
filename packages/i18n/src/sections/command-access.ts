export const commandAccessZh = {
  "docker.title": "本机 Docker",
  "docker.disabled": "关闭",
  "docker.risk":
    "高权限：Docker 可以挂载宿主目录、读写工作文件夹之外的文件，并使用独立于命令网站白名单的网络。默认关闭。",
  "docker.mac": "仅为本次前台命令开放所选本机套接字，每次都需审批，自动批准模式也不会跳过。",
  "docker.linux":
    "Docker 客户端通过专用通道直接执行，未隔离；不开放全部 Unix 套接字，也不执行宿主 Shell。每次都需审批。Docker Engine 使用系统默认套接字，暂不支持 rootless 自定义端点。",
  "docker.windows":
    "注意：Docker 命令未隔离，每次都需审批，自动批准模式也不会跳过；设为「不允许」时仍会拒绝。",
  "docker.lifecycle":
    "仅支持单条前台 docker 命令和字面参数。关闭权限只阻止后续访问，不会停止已有容器或删除数据卷。",
  "docker.confirm": "我了解 Docker 可能超出工作文件夹及命令网络隔离范围。",
  "docker.enable": "确认开启",
  "facts.value.docker_access":
    "Docker 可以访问工作文件夹外的宿主文件和网络；撤销授权不会停止已有容器或删除卷",
  "facts.value.docker_unisolated":
    "本次 Docker 客户端未隔离，仅通过专用通道直接执行 Docker，不执行宿主 Shell",
  "paths.importNote":
    "普通命令、后台命令、Docker 和自动检查共用命令搜索路径。仅导入路径，不导入密钥或其他环境变量，不授予目录写权限。包管理器要求的版本需事先准备好，检查时不会自动安装。",
  "paths.process": "读取应用启动路径",
  "paths.terminal": "从终端环境导入…",
  "paths.shellWarning":
    "读取将启动登录交互 Shell，在命令沙箱外执行你的 Shell 初始化文件（如 .zshrc），其中的脚本可能产生副作用。仅返回 PATH，不返回其他环境变量；5 秒超时。确认后才执行。",
  "paths.read": "确认并读取",
  "paths.loading": "正在读取命令路径…",
  "paths.error": "读取失败或超时。可手动添加工具所在目录；不会因此放宽沙箱权限。",
  "paths.sourceTerminal": "来源：终端 Shell {shell}。请检查以下目录，确认后才保存。",
  "paths.sourceProcess": "来源：应用启动环境。请检查以下目录，确认后才保存。",
  "paths.apply": "确认导入路径",
  "paths.tooMany": "合并后的路径超过 200 项，请先移除不需要的目录。",
  "ssh.title": "SSH 主机",
  "ssh.refresh": "刷新",
  "ssh.refreshLabel": "刷新 SSH 主机",
  "ssh.note":
    "只有打开的主机能被 Bot 用 ssh 执行远端命令。只记下开关和私钥文件名，不改你的 ~/.ssh/config。",
  "ssh.status.ready": "就绪",
  "ssh.status.needsKey": "需要选私钥",
  "ssh.status.unsupported": "不支持：{reason}",
  "ssh.reason.proxy": "配置里用了 ProxyCommand 或 ProxyJump",
  "ssh.reason.match": "配置里用了 Match",
  "ssh.reason.includeOutsideHome": "Include 指向主目录之外",
  "ssh.reason.includeInWorkspace":
    "Include 指向工作文件夹或 Bot 可写文件夹内，Bot 能改写的配置不能决定连哪台主机",
  "ssh.reason.other": "配置不符合支持的写法",
  "ssh.reason.strictHostKey": "StrictHostKeyChecking 只支持 yes；把 accept-new 改成 yes",
  "ssh.reason.option": "配置里的 {option} 不支持；删掉这一行后再打开这一页",
  "ssh.reason.user": "User 没写或格式不支持；写一行 User 用户名，允许一个 @（如 用户@机器）",
  "ssh.reason.identityOutsideSsh":
    "私钥不在 ~/.ssh 下；把私钥放进 ~/.ssh（权限 600），或把 IdentityFile 指到 ~/.ssh 内的文件",
  "ssh.status.willUse": "将使用 {identity}，打开开关即可",
  "ssh.identityFor": "{alias} 的私钥",
  "ssh.chooseIdentity": "选择私钥",
  "ssh.toggle": "启用 {alias}",
  "ssh.noIdentities":
    "~/.ssh 里没有权限为 600 的私钥可选；配置里写了 IdentityFile 的主机不受影响。",
  "ssh.empty": "~/.ssh/config 里还没有带名字的主机。",
  "ssh.error": "读取 SSH 配置失败。",
  "ssh.unavailable.configurationUnsupported":
    "当前 ~/.ssh/config 用了通配 Include、软链等暂不支持的写法；修好配置后重新打开这一页。",
  "ssh.unsupportedPlatform": "用 SSH 执行远端命令目前只在 macOS 上支持。",
} as const;

export const commandAccessEn: Record<keyof typeof commandAccessZh, string> = {
  "docker.title": "Local Docker",
  "docker.disabled": "Off",
  "docker.risk":
    "High privilege: Docker can mount host folders, read and write outside the workspace, and use networks outside the command domain allowlist. Off by default.",
  "docker.mac":
    "Only the selected local socket is opened for this foreground command. Approval is required each time, even with Auto-approve.",
  "docker.linux":
    "The Docker client runs directly through a dedicated, unisolated channel, without opening all Unix sockets or executing a host shell. Approval is required each time. Docker Engine uses the system socket; rootless custom endpoints are not supported yet.",
  "docker.windows":
    "Warning: Docker commands are not isolated. Approval is required each time, even with Auto-approve; Never still denies.",
  "docker.lifecycle":
    "Only one foreground docker command with literal arguments is supported. Turning access off blocks future commands; it does not stop existing containers or remove volumes.",
  "docker.confirm":
    "I understand that Docker can exceed workspace and command network isolation boundaries.",
  "docker.enable": "Confirm and enable",
  "facts.value.docker_access":
    "Docker can access host files and networks outside the workspace; revocation does not stop containers or remove volumes",
  "facts.value.docker_unisolated":
    "This Docker client is not isolated; the dedicated channel runs Docker directly, not a host shell",
  "paths.importNote":
    "Commands, background commands, Docker and auto-checks share command search paths. Only paths are imported, not secrets or other environment variables; no write access is granted. Prepare the required package-manager version in advance; checks do not install it automatically.",
  "paths.process": "Read app launch paths",
  "paths.terminal": "Import from terminal environment…",
  "paths.shellWarning":
    "This starts a login interactive shell and executes your initialization files (such as .zshrc) outside the command sandbox. Those scripts may have side effects. Only PATH is returned, not other environment variables; the timeout is 5 seconds. Nothing executes before confirmation.",
  "paths.read": "Confirm and read",
  "paths.loading": "Reading command paths…",
  "paths.error":
    "Discovery failed or timed out. You can add tool directories manually; sandbox permissions will not be widened.",
  "paths.sourceTerminal": "Source: terminal shell {shell}. Review these directories before saving.",
  "paths.sourceProcess": "Source: app launch environment. Review these directories before saving.",
  "paths.apply": "Confirm path import",
  "paths.tooMany": "The merged list exceeds 200 paths. Remove unnecessary entries first.",
  "ssh.title": "SSH hosts",
  "ssh.refresh": "Refresh",
  "ssh.refreshLabel": "Refresh SSH hosts",
  "ssh.note":
    "Only enabled hosts can run remote commands with ssh. Only the switches and key file names are stored; ~/.ssh/config is never edited.",
  "ssh.status.ready": "Ready",
  "ssh.status.needsKey": "Needs a private key",
  "ssh.status.unsupported": "Not supported: {reason}",
  "ssh.reason.proxy": "The configuration uses ProxyCommand or ProxyJump",
  "ssh.reason.match": "The configuration uses Match",
  "ssh.reason.includeOutsideHome": "Include points outside your home folder",
  "ssh.reason.includeInWorkspace":
    "Include points into a working folder or Bot-writable folder; a configuration the Bot can rewrite must not decide which host is connected",
  "ssh.reason.other": "The configuration uses an unsupported feature",
  "ssh.reason.strictHostKey": "StrictHostKeyChecking only supports yes; change accept-new to yes",
  "ssh.reason.option":
    "The option {option} is not supported; remove that line, then reopen this page",
  "ssh.reason.user":
    "User is missing or malformed; add a User line, with one @ allowed (e.g. user@machine)",
  "ssh.reason.identityOutsideSsh":
    "The private key is outside ~/.ssh; move it into ~/.ssh with mode 600, or point IdentityFile at a file inside ~/.ssh",
  "ssh.status.willUse": "Will use {identity}; turn the switch on",
  "ssh.identityFor": "Private key for {alias}",
  "ssh.chooseIdentity": "Choose a key",
  "ssh.toggle": "Enable {alias}",
  "ssh.noIdentities":
    "No private key with mode 600 in ~/.ssh to choose; hosts whose configuration names an IdentityFile are unaffected.",
  "ssh.empty": "No named hosts in ~/.ssh/config yet.",
  "ssh.error": "Couldn't read the SSH configuration.",
  "ssh.unavailable.configurationUnsupported":
    "The current ~/.ssh/config uses unsupported forms such as wildcard Include or a symlinked config; fix the configuration, then reopen this page.",
  "ssh.unsupportedPlatform": "Running remote commands over SSH is only supported on macOS for now.",
};
