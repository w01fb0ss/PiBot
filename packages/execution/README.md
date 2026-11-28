# @pibot/execution

命令执行和安全文件/网页访问的 Node 包；只能由 brain 的统一 policy/审批入口调用。
执行服务已实现；调用前的 policy、审批、审计由 brain 统一编排。


## 接入接口

```ts
const exec = createExec({ platform, env, systemHome, tempDir, resourcesDir, redactor });
const isolation = await exec.isolationStatus();
const result = await exec.runCommand({
  command, cwd, dataDir, botHome, runId, writeRoots, network: { allowAll, domains },
  pathEntries, timeoutSec, signal, onOutput, allowUnisolated,
});
await exec.dispose();
const files = createFileTools();
await files.listDir({ path, depth, cwd, writeRoots, signal, expectedPath });
await files.readFile({ path, offset, limit, cwd, writeRoots, signal, expectedPath });
await files.writeFile({ path, content, cwd, writeRoots, signal, expectedPath });
await files.editFile({ path, old, new: replacement, replaceAll, cwd, writeRoots, signal, expectedPath });
const page = await fetchPage({ url, maxChars, allowDomain, signal });
```

- **一个 brain 共享一个 exec 和一个 files 实例**，不用模块级可变服务。命令互斥、写入/编辑互斥，冲突返回 `ExecError("busy")`；需要多 Bot 同时执行时应在上层排队。SDK 已被其他实例占用时也拒绝，不接管别人的 manager。
- `env` 是入口注入的当前宿主完整环境快照，SDK生命周期内须保持一致，`systemHome` 是宿主 home，`tempDir` 是系统临时目录；三个路径按实际宿主平台提供。`resourcesDir` 可省略（开发解析依赖），打包时指向实际 Resources。env 含非空 SRT_DEBUG、CLAUDE_CODE_TMPDIR 或 CLAUDE_TMPDIR 时拒绝创建；入口须保证真实 SDK 进程也没有这些变量，不能只从快照删掉：前者可能输出命令原文，后两者会被SDK重新写入TMPDIR且不受credentials deny限制。
- `redactor` 注入 `{ redact, stream(): {push,finish} }`，兼容 brain 的流式 redactor；stdout/stderr 各自解码及脱敏，再按到达顺序合并。完整日志与 UI 输出都不保留已登记 Key；格式匹配的能力与注入 redactor 一致，不能把有缺陷的 redactor 当成完整保护。
- `runId` 为 UUID v4；`dataDir`、`botHome` 是brain注入的canonical绝对路径；botHome必须为dataDir/bots/<botId>/home，attachments由同Bot的兄弟目录派生。旧homeDir仅作为可选兼容别名，若传入必须解析到同一botHome；`writeRoots` 必须为审批时canonical的绝对工作位置路径，执行时复核，根变成符号链接就拒绝，不能重新解析到另一目录并扩大权限；再加系统临时目录。命令 HOME 是 Bot 的同级 `command-home` 目录，工作目录仍由 `cwd` 决定；获准在沙箱外运行的命令沿用用户的 HOME。日志由宿主在 `<botHome>/../command-logs/runs/<runId>.log` 追加，同 run 多次命令用同路径，供日志索引使用。
- `isolationStatus(signal?: AbortSignal): Promise<{available,reason?}>` 会真正运行固定 `true` 探测，包含依赖/启动失败而非仅检查平台。初始化含10秒独立截止，探测5秒主动结算，不依赖close；SDK超时/取消的实例禁止继续执行，迟到完成只清理；初始化失败在底层工作和清理完成后可重试，调用方取消只结束自己的等待；reset/等待未完成SDK操作各限3秒，清理失败、包装失败或执行硬截止才需重启brain。Windows 返回 `windows_unisolated`；Linux 缺 seccomp helper 不声称完整隔离；失败 reason 不包含原始 SDK 异常或命令。
- 无隔离时必须由 brain 根据审批卡显式设置 `allowUnisolated:true`；默认拒绝。**无隔离且 network.allowAll=false 仍拒绝**，因为不能执行真实网络白名单；不静默改成默认联网。Windows 用无 profile 的 PowerShell 和 taskkill `/T /F` 终止树；用CIM快照记录PID/创建父PID/CreationDate（不读CommandLine或环境），父退出后仍按后代PID清理并复查全树；非零只有全部已知后代消失才可完成，创建时间排除PID复用的旧孤儿；不声称具备 POSIX 的温和 TERM 语义。
- sensitive-paths.ts按平台维护SSH/GPG/云/容器配置、Keychains/Cookies、五类浏览器配置、.pi等，解析宿主/实际SDK home与Bot HOME的名字及真实目标；每命令denyRead，整个dataDir仅allowRead当前botHome与attachments。工作位置不能解禁；在Linux会被write bind重新暴露的敏感写根也剔除，不能把dataDir或.ssh当writeRoot恢复读取。附件根变链接或Bot carve-out落在敏感根内则拒绝；初始固定true探测只使用宿主敏感列表。
- macOS/Linux：`/bin/bash --noprofile --norc -c`；仅 PATH/HOME/LANG/TERM/SHELL/TMPDIR，Windows另需 SystemRoot/TEMP/TMP/USERPROFILE；不取原 PATH，不取 BASH_ENV/ENV/厂商 Key。SDK初始化及每命令credentials.envVars均deny JAVA_TOOL_OPTIONS/GIT_CONFIG_COUNT，防它在包装命令中重注入宿主值；保留自身生成的Java代理参数和代理环境，TMPDIR使用SDK固定默认/tmp/claude（无上述宿主覆盖）。pathEntries 必须绝对且不能含 PATH 分隔符，Windows SystemRoot 从注入环境取得。
- 超时默认600/最多3600秒，接受停止 signal；POSIX TERM 后5秒 KILL 进程组及已跟踪的脱组后代；100ms ps 快照按 PID/启动时间跟踪，shell 的 exit 即启动清理，不等待 close。终止后7.5秒管道截止、日志收尾另限1秒；整次run在timeout+10秒、主动停止后10秒有外层硬截止（即使文件系统/SDK不结算），触发时关闭实例以阻止迟到工作，失败返回安全错误并释放资源；`dispose` 等待有界执行/初始化后reset并排空两个事件循环轮次的close回调；取消立即清掉执行计时器，未结算的内部Promise不留下600秒计时器。结果 `{exitCode:number|null,timedOut,stopped,durationMs,logPath,truncatedOutput}`；执行前失败为安全的 ExecError，不伪造退出码。
- 进程树快照是可移植的尽力清理：两次采样间完成双重 fork/脱组并重挂到 init 的进程可能无法溯源；不能把它当 OS 强隔离。若其保留管道，截止后显式失败并释放 busy，仍需实机验证极端逃逸；Linux/Windows 同样需独立验收。
- 输出100ms合并；每次待发 UI 数据限64Ki字符，完整日志不丢；磁盘背压暂停两路输入。模型结果≤30000字符，头尾各半并标实际省略数。UI 自己保留最后200行。onOutput 抛错/落盘失败会停止命令并返回失败。
- 文件操作20秒截止，`offset` 从0开始、`limit` 1–2000，返回文本≤256KiB，偏移前的长行逐块丢弃、不占返回限额；二进制只给类型/大小；list depth1–3、最多500条，不递归符号链接。结果为 `{path,entries,truncated}` / `{path,type,size,text?,truncated?}` / `{path,bytes}`。
- write/edit 上限64MiB UTF-8；edit按stat快照有界读取、拒绝随后增长，replaceAll先计数/算UTF-8字节、超限即拒绝，再构造单个限额Buffer，每4096匹配让出事件循环检查取消，不用split/join匹配数组；old/new拒绝未配对代理字符。写前复查 realpath、临时文件 `wx`/0600、fsync，再复查目录身份与范围后 rename；新文件0600，覆盖已有普通文件在写完后恢复mode & 0777，保留可执行位、不继承setuid/setgid/sticky（Windows依其chmod语义）。新建父目录；edit 拒绝空 old、未匹配或未声明 replaceAll 的多匹配（含重叠），不接受二进制文本。调用方必须先判权限，再传有效根；read/list 不在 exec 中自动授予权限。
- 文件读取与网页结果包含资料正文，**调用方必须在模型/renderer 出口脱敏**；exec 不审计、不决定记住资格、不导入 policy/store/pi/Electron。错误不向调用者传播原始文件/网络异常。
- `fetchPage` 的有效网络预算为20秒（DNS/连接/响应体），解压后≤5MiB、最多5次重定向；每跳检查全部DNS地址并固定连接，拒绝内网/本机/保留地址，原有fake-IP规则不变。`allowDomain(domain,signal,url)`得到完整URL；授权等待暂停网络计时，回调含有界准备最长720秒，brain审批记录独立600秒；原始signal可停止等待。首次审批在调用前完成，新域名可再审批，等待不重置重定向计数；仍使用同版本undici fetch+Agent，保持Host/SNI，不继承全局代理/Cookie/身份。
- 页面结果 `{url,domain,title,text,truncated,mimeType}`；maxChars默认50000、最多1000000（截断提示额外附加），只收文本 MIME，HTML 用 Readability/linkedom，失败去标签纯文本。`ExecError.code/reason` 提供安全原因（私有地址、未授权域名、类型、大小、重定向以及cancelled/timeout/dns_failed/connection_failed/tls_failed/dispatcher_incompatible/body_failed/html_failed/cleanup_failed），由调用方转为给模型的解释。
- 精确新增 `linkedom@0.18.13`、`@mozilla/readability@0.6.0`（正文抽取），`undici@8.10.2`（Node fetch DNS 固定，复用仓库已有版本）；没有升级 agent 的 peer。

纯Node服务释放自己的句柄，不结束宿主进程、不关闭stdio。Electron44的utility宿主有ref的dummy_uv_handle_，本身不随普通Node工作排空而退出；scratch空utility对照和after-dispose资源基线断言用于区分宿主保活与exec泄漏，断言通过后由探针入口正常结束宿主。不将显式宿主退出当成自然退出证据。

## 摸底结论

### 版本和验证状态（2026-10-09）

- 精确依赖：`@anthropic-ai/sandbox-runtime@0.0.79`（Apache-2.0）、`@vscode/ripgrep@1.18.0`（MIT）。新增依赖分别承担规格指定的 OS 隔离和可重现的预编译 rg 来源。
- Node `26.11.1`、macOS x64：已导入 SDK、校验配置、生成 Seatbelt 包装命令；依赖检查返回 `{errors:[],warnings:[]}`。这不证明 sandbox-exec 实际能启动，也不证明 OS 写入/网络边界已通过。
- 已运行 rg，输出 `ripgrep 15.0.0 (rev 3a612f88b8)`；已验证 builder beforePack 的模块加载、资源暂存和 universal 架构明确失败。
- 早期探路中 Electron `44.7.0` utilityProcess / asar / macOS x64 写隔离和白名单后来已验证通过；新服务的 Electron/打包探针仍须单独验，arm64/Linux/Windows无实机结论。

### macOS 接入方式和限制

- 使用 SDK 导出的 `SandboxRuntimeConfigSchema.parse(config)`、`SandboxManager.initialize(config, askCallback?, enableLogMonitor?)`。
- `wrapWithSandbox(command, binShell?, customConfig?, signal?, {commandId,commandText}?) → Promise<string>` 返回包装命令，SDK 不替调用方管理执行、流式输出、超时或停止。
- 执行包装字符串时由 exec 使用 `/bin/bash --noprofile --norc -c` 和独立、干净的 env，明确 cwd；SDK 内部还会用指定 shell 的 `-c`，不要把用户命令拼成未转义的另一层 shell。
- `wrapWithSandboxArgv(..., cwd?, options?)` 在 mac/Linux 返回 `{argv:[shell,"-c",wrapped],env:process.env}`；**不能照抄返回的 env**，否则把 brain 的环境带给子进程。
- 写根用绝对 canonical 路径和 `{path,literal:true}`，防止文件夹名里的 `[]*?` 被解释成 glob。只设 allowWrite **不够**：SDK 自动追加 `/tmp/claude`、`/private/tmp/claude`、stdio/系统设备，以及 `~/.npm/_logs`、`~/.claude/debug`。
- exec 必须收紧默认的 home 日志便利路径（加入 denyWrite，或根据有效工作位置精确处理），不开放工作位置外的普通文件；系统临时目录按规格显式允许。源码的 denyWithinAllow 生成最终 deny 规则，可覆盖自动追加的 allow。
- 域名列表模式设置 `network.allowedDomains` 和 `strictAllowlist:true`，不接允许未知域名的 callback；Seatbelt 限制直连，只能到宿主 HTTP/SOCKS 代理，代理逐次判域名。禁止 weakerNetworkIsolation/allowAllUnixSockets 等扩大通道。
- `0.0.79` 的 allowDomains 不接受裸 `"*"`；默认联网可用 SDK 的允许 callback（返回布尔 true），列表模式不可使用它。该版 callback 对 truthy 对象也可能放行，拒绝务必返回布尔 false，不能照 GitHub main 的新对象返回示例。
- SDK 的 SandboxManager 是模块级单例；exec 需要封装生命周期和并发，initialize 一次、每次命令传独立 filesystem customConfig/commandId，不通过 process.chdir/updateConfig 切 Bot 的写根。
- `updateConfig()` 的网络列表对运行中的代理实时生效；停止子进程仍须自己实现进程组 TERM→5s KILL。每条命令收尾 cleanupAfterCommand，服务关闭 reset（代理、监听、临时资源）。
- 上述是锁定 npm 产物的源码结论；探路时 macOS x64 实测通过，exec 仍按同一配置收紧，不把历史探路当本次生产服务验收。

### Linux 缺 bubblewrap 的行为（文档/源码核对，未实机）

- `dist/sandbox/linux-sandbox-utils.js:checkLinuxDependencies()` 找不到 bwrap 时返回 errors 包含 `bubblewrap (bwrap) not installed`；显式 bwrapPath 不可执行返回 `bubblewrap (bwrap) not executable at <path>`，不偷偷回退 PATH。
- `SandboxManager.checkDependenciesAsync({command:rgPath})` 合并 rg、bwrap、socat 检查；缺 rg 为 `ripgrep (<command>) not found`，缺 socat 为 `socat not installed`。
- initialize 抛 `Sandbox dependencies not available: <errors.join(', ')>`，SDK 不自动改成无隔离执行；exec 捕获为 isolationStatus 的 unavailable/reason，并按规格展示无隔离退路，仍经 policy/审批。
- 缺 seccomp helper 是 warning `seccomp not available - unix socket access not restricted`，不能把这种降级说成完整隔离；bwrap <0.5.0 也有版本 warning。
- Linux 命令包装用 bwrap + 网络 namespace/socat；缺依赖与已安装但 user namespace/AppArmor 不允许是不同故障，后者须另做启动检查。
- `0.0.79` 的 checkDependenciesCommon 明确说明 rg 只用于 Linux glob/mandatory deny 扫描；**macOS 不再调用 rg**（Seatbelt 直接支持规则），与较旧项目文字不同，仍按要求打包 rg。

### ripgrep 来源与打包路径

- `@vscode/ripgrep@1.18.0` 是 ESM 包，精确 optionalDependencies 指向各 OS/CPU 二进制包；当前安装 `@vscode/ripgrep-darwin-x64@1.18.0/bin/rg`。
- 二进制来自 Microsoft ripgrep-prebuilt，随 npm tarball 发布；不需要 postinstall 下载，不依赖本机 Homebrew rg，保留 optionalDependencies。
- 开发模式通过 exec 包解析并 `import {rgPath} from "@vscode/ripgrep"`；packaged 模式由外层注入 `join(resourcesDir,"bin",win32?"rg.exe":"rg")`。
- `apps/desktop/scripts/package/prepare-resources.mjs` 根据 builder 的 electronPlatformName/arch 解析**目标**二进制，暂存 `out/native-resources/<arch>/bin/rg[.exe]` 并设 0755；找不到目标包时明确失败，禁止拿宿主架构二进制冒充。
- builder extraResources 把它复制到 Resources/bin；vendor/** 通过 asarUnpack 为 SRT 的 seccomp/Windows/JVM helper 保留真实文件路径，当时不因此启用 Windows sandbox。
- asarUnpack 只保证副本存在，不保证 SDK 传给外部程序的路径自动改写；exec 在 Linux/后续 Windows 接入时须使用 app.asar.unpacked 中的真实 helper 路径（如 seccomp.applyPath），另验不能执行虚拟 asar 路径。
- macOS arm64/x64 分别在相应架构环境安装 optional 包并打包；本轮只验证 x64，universal 不静默产出单架构 rg。跨平台构建先安装目标 optional 包，不能假设宿主安装含全部平台。
- 入口注入 resourcesDir，exec 使用上述路径；不增加 agent 命令绕过 exec 的通道。

参考：[SRT 官方文档](https://github.com/anthropics/sandbox-runtime)、[ripgrep 包官方说明](https://github.com/microsoft/vscode-ripgrep)；接口和行为以安装的 0.0.79/1.18.0 产物为准（上游 main 已有后续变化）。

brain 接入：FileContext 可选 expectedPath 为 policy 已批准的 canonical 目标；再次解析若变为别的目标就拒绝（即使目标仍在另一个允许根内），brain 调用始终提供。sensitiveReadBoundary 公开供工作位置关联返回 commandReadBlocked，关联不会解除命令敏感目录保护；renderer 提示仍须联调。

## 过滤代理与系统信任边界

- macOS的SRT mux仅监听IPv4，但生成localhost代理地址。`sandbox-proxy-setup.ts`在SDK安装环境后、原用户命令前执行固定Bash前缀：仅归一SDK产生的HTTP/HTTPS/ALL/GRPC/FTP/Docker代理URL末尾的已知监听主机，以及RSYNC、Cloud SDK、Git SSH代理地址。监听端口来自公开getter；不解析认证令牌、不替换用户命令或完整包装字符串，`commandText`仍为原命令，NO_PROXY目标列表不改。JVM的SDK agent读取这些代理变量，未改其参数/源码。

- `network-proxy.ts` 的 config/authorize 成对装进独立 sandbox-host；SRT 的回环绕上游和名单短路均由规范化回调覆盖，其余流量经父代理 DNS/私网检查。全网不授权本机/私网，原名单显式目标可例外；手动代理远端 DNS 的结果仍不可观测。`temp-boundary.ts` 隐藏其他运行的共享临时树，自己的临时目录与当前 host socket 只开必要读例外。缺失根身份即 `outside_workplace`；后台监听连续三次失败停止，私有终态/输出带 `listener_check_failed`。旧探针专用 sandbox 三模块已删除，生产入口为 profiles + host。
- 保SRT随机认证、域名判定、用户手动上游、敏感读写根、互斥/取消/实际drain；关闭上游仍显式可信空串、切换上游仍reset重建。真实mac createExec中HTTP/HTTPS、curl、缺失/错误认证、名单拒绝及清理已验证；不是生产7890/用户运行实例验收。
- 现代pip的macOS truststore可能因默认Mach限制报OSStatus -26276。`brain/tools.ts`的run_command静态受信说明提供按命令、按能力核对的`--use-deprecated=legacy-certs`方案：核所选pip版本/帮助，支持时可发起新命令重试，使用certifi CA校验而不关闭TLS。不得全局设置PIP_USE_DEPRECATED或给不支持参数的旧pip加旗标；参数不授予权限，重试仍走原policy/审批/exec，不自动重跑安装。真实Python3.14.5/pip26.1.1在默认Mach/文件/网络边界下PyPI版本查询已成功，无包下载/安装；其他版本需核支持能力。
- CommandResult保原exitCode/logPath/完整日志入口和有界输出。已删除首轮stdout匹配抛错及system_trust_unavailable类型/静态“不支持pip”反馈；OSStatus等stdout内容只是诊断数据，不判证书根因或改成策略拒绝，echo与实际失败结果均原样保留。[pip官方文档](https://pip.pypa.io/en/stable/topics/https-certificates/)说明legacy-certs仅退出系统证书store，certifi验证仍启用；真正不受信任/过期证书不能靠该参数绕过。
- 同一真实SRT/默认Mach下pip26.1.1参数路径：PyPI index成功（无包下载）；私有有效链成功，自签未信任链与受信任CA签发的过期链均失败并保SSL原因。有效/过期夹具只按命令--cert读取本夹具CA以分离过期原因，不安装系统CA。名单外及无/错认证查询均失败/上游CONNECT0，HTTP诊断403/407/407；打印OSStatus的exit0/7和默认truststore实际失败均保原退出码/日志/输出。没有全局PIP覆写、信任Mach或弱网络启用。
- 精确allowMachLookup=[com.apple.trustd.agent]的私有A/B能恢复系统验证，但证书AIA使trustd访问沙箱命令不能直连的端口，绕过SRT。生产不添加名单、不启weakerNetworkIsolation/Mach通配/钥匙串、不关闭TLS或装CA；pip改用受验证的certifi路径，Go及其他原生truststore客户端仍有限，不能泛化此参数或声称已全部修复。
- IPv4前缀只适用于macOS。本版Linux网络命名空间内3128/1080监听与宿主socat→localhost随机mux是另一链路，未据mac结果改写/宣称已修；需真实Linux探路。Windows无隔离且开代理仍拒执行。无依赖/迁移/SDK源码或锁版本改变。
