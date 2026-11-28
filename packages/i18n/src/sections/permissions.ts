// Translate permission settings, approvals, and policy warnings.

export const permissionsZh = {
  "permissions.serviceTrust": "证书信任评估",
  "permissions.serviceDirectory": "用户与组查询",
  "permissions.serviceNotification": "系统通知",
  "permissions.serviceKeychain": "系统钥匙串",
  "permissions.servicePasteboard": "系统剪贴板",
  "permissions.serviceUnknown": "其他系统服务",
  "permissions.serviceOther": "系统服务 {service}",
  "permissions.sandboxRemembered": "隔离环境里记住的授权",
  "permissions.sandboxRememberedSummary":
    "{count} 项 · 写入路径 {writes} · 本机服务 {local} · 系统服务 {system}",
  "permissions.sandboxRememberedSummary.one":
    "{count} 项 · 写入路径 {writes} · 本机服务 {local} · 系统服务 {system}",
  "permissions.sandboxWrites": "写入路径",
  "permissions.sandboxLocal": "本机服务",
  "permissions.sandboxSystem": "系统服务",
  "approval.sandboxRemember": "允许，这个文件夹以后不再问",
  "facts.value.system_service": "只放行这一项系统服务。",
  "policy.reason.system_service_once": "允许这个程序使用所列系统服务",

  "policy.reason.git_entry_confirmation_required":
    "这条 Git 命令会运行项目里的钩子或可执行配置（见下），需要你这次明确确认，不记住；自动批准模式、已有授权和例行任务都不能代答",
  "facts.value.git_entry_once":
    "只允许这一次运行所列入口；只固定了入口文件本身，它再调用的程序没有固定。运行前若任何入口或配置有变化，这次会被拒绝",
  "policy.reason.git_entry_include_unknown":
    "仓库的 Git 配置用了 include / includeIf，无法确认会运行哪些程序，暂不支持",
  "policy.reason.git_entry_layout_unsupported":
    "这个 Git 布局（--git-dir、core.worktree、子模块递归等）里的钩子无法逐项确认，暂不支持",
  "policy.reason.git_entry_scan_incomplete":
    "没能在限额内读完仓库的钩子和配置，无法确认会运行什么，未执行",
  "policy.reason.git_entry_compound":
    "复合命令里的 Git 会运行项目钩子或可执行配置，无法逐次确认；请单独运行这条 Git 命令",
  "policy.reason.git_entry_dynamic":
    "命令用环境变量、-c 或别名改变了仓库、配置或要运行的程序，无法确认会运行什么",
  "policy.reason.git_entry_unsupported_target":
    "这条 Git 命令会运行项目钩子或可执行配置；例行任务、后台、Docker、沙箱外运行、Windows 或无法检查的执行端下不能当场确认，未执行",
  "policy.reason.git_hooks_path_confirmation_required":
    "这次修改项目 Git hooksPath 目录需要你明确确认，不能记住；不会执行或授权任何 hook",
  "facts.value.git_hooks_path_setter":
    "仅修改项目 core.hooksPath，不读取钩子正文、不执行钩子，也不授予后续 Git 入口运行许可",
  "policy.reason.git_inline_execution_unsupported":
    "这条 Git 命令可能调用显式覆盖的可执行配置，暂不支持逐次受控执行；普通权限、自动批准模式或已有授权不能代替，不会运行",

  "policy.reason.git_hook_confirmation_required":
    "单次运行所示 pre-commit 原生程序钩子，需要你明确确认，不记住授权",
  "policy.reason.git_hook_unsupported":
    "这个 Git 钩子、脚本形态或执行端暂不支持受控运行，不会改用原始命令执行",
  "policy.reason.git_hook_unverified": "Git 钩子、程序或工作范围与准备版本不一致，未运行",
  "facts.value.git_hook_literal_exec":
    "仅执行默认 pre-commit 钩子的固定系统原生程序及所示字面参数；不含 Node/脚本、联网、凭据或配置修改。仅这次，不记住",
  "policy.reason.host_ssh_not_enabled": "这个 SSH 主机没有打开：设置 → 权限 → 高级 → SSH 主机",
  "policy.reason.host_ssh_identity_required":
    "这个主机还没选私钥，请在 设置 → 权限 → 高级 → SSH 主机 里选",
  "policy.reason.host_ssh_unsupported":
    "暂不支持这个 SSH 形式、配置或执行端；不会开放整个 .ssh 或改用普通命令执行",
  "policy.reason.ssh_config_private": "~/.ssh 是凭据目录，不能读；连接主机请用 ssh 别名 '命令'",
  "policy.reason.host_ssh_unsupported_syntax":
    "这个 SSH 写法暂不支持：只支持 ssh 别名 '远端命令'，加少数安全选项",
  "policy.reason.host_ssh_unsupported_target": "宿主 SSH 目前只支持 macOS 本机的普通聊天",
  "policy.reason.host_ssh_configuration_unavailable": "在 ~/.ssh/config 里找不到这个别名",
  "policy.reason.host_ssh_unsupported_configuration":
    "这个主机的 SSH 配置用了暂不支持的功能，不会删掉后再连接",
  "policy.reason.host_ssh_config_strict_host_key":
    "这个主机把 StrictHostKeyChecking 写成了 yes 以外的值（如 accept-new）；改回 yes 后再试",
  "policy.reason.host_ssh_config_option":
    "这个主机的 SSH 配置里有 Pi Bot 不支持的选项；具体哪一行看 设置 → 权限 → 高级 → SSH 主机",
  "policy.reason.host_ssh_config_user":
    "这个主机没写可用的 User（允许一个 @，如 用户@机器）；补上后再试",
  "policy.reason.host_ssh_config_identity_outside_ssh":
    "这个主机的私钥在 ~/.ssh 之外；把私钥放进 ~/.ssh（权限 600）或改 IdentityFile 后再试",
  "policy.reason.host_ssh_unverified": "SSH 命令、配置或文件版本不匹配，未授予访问权限",
  "facts.value.host_ssh_static_identity":
    "只复用静态别名和一把密钥；不执行用户代理命令或系统配置，不返回 SSH 本地诊断和远端 stderr",
  "policy.reason.git_configuration_confirmation_required":
    "这次受控 Git 配置修改需要你明确确认，不能记住授权",
  "policy.reason.git_configuration_unsupported":
    "这个 Git 配置操作或执行端暂不支持受控修改，不会改用原始命令执行",
  "policy.reason.git_configuration_unverified":
    "Git 配置操作、目标或准备版本不匹配，未授予修改权限",
  "policy.reason.git_configuration_project_setter":
    "仅通过受控操作修改当前项目的一个普通 Git 配置键",
  "policy.reason.git_configuration_global_setter":
    "仅通过受控操作修改当前用户的一项 Git 姓名或邮箱设置",
  "facts.value.git_configuration_project_setter":
    "只改所示项目配置的一个普通键，不授予整份配置或目录的写权限；值不显示",
  "facts.value.git_configuration_global_setter":
    "只改所示用户配置的姓名或邮箱，必须每次确认；不授予目录权限，值不显示",
  "policy.reason.git_configuration_sensitive_project_setter":
    "仅修改当前项目一个可执行 Git 配置键，不会运行其中的程序；以后使用该入口仍须单独确认",
  "facts.value.git_configuration_sensitive_project_setter":
    "只修改所示项目配置的一个可执行键（helper / filter / sshCommand），仅这次、不记住；本次不运行该程序，以后使用仍须另行确认。值不显示，不授予整份配置或目录权限",
  "policy.reason.task_web_read": "你已在本群任务内允许读取公开网页",
  "approval.allowTaskWeb": "本任务内允许读取公开网页",
  "approval.taskWebsiteHint":
    "本群任务或计划的所有成员、重试和改派共用，仅查看公开网页；不含 Bot 浏览器、登录、表单或内网。任务结束、取消、计划完成或重启后失效。",
  "policy.reason.conversation_web_read": "你已在本对话内允许读取这个网站的公开网页",
  "approval.allowConversation": "本对话内允许这个网站",
  "approval.conversationWebsiteHint":
    "仅查看 {domain} 及其子域名的公开网页；不含浏览器、登录、表单或内网。此授权仅本 Bot、本对话有效，重启后失效。",
  "permissions.singleRootScope": "仅在文件夹 {root} 内",
  "permissions.topicGrantScope": "话题 {topic} · 当前可写文件夹：{roots}（随话题变更）",
  "permissions.topicGrantUnavailable": "工作文件夹不可用，执行前重新校验",
  "permissions.topicGrantNoRoots": "没有可写文件夹",
  "permissions.yoloUnisolated": "Windows 上自动批准模式直接运行命令",
  "permissions.yoloWindowsConsentedAt":
    "已同意（{date}）。所有开启自动批准模式的对话都可按权限直接运行普通 Windows 命令。撤回后，这些对话里的普通命令会恢复逐次确认。",
  "permissions.yoloWindowsConsented":
    "已同意。所有开启自动批准模式的对话都可按权限直接运行普通 Windows 命令。撤回后，这些对话里的普通命令会恢复逐次确认。",
  "permissions.yoloWindowsNotConsented": "尚未同意。开启自动批准模式时可以确认。",
  "permissions.yoloWindowsWithdraw": "撤回",
  "permissions.yoloWindowsWithdrawFailed": "未能撤回同意，请重试。",
  "permissions.strictSandbox": "严格安全隔离",
  "permissions.strictSandboxNote":
    "打开后，命令被安全隔离拦下时只说明原因，不提供「直接运行一次（不受安全隔离限制）」，下面的清单也不生效。",
  "permissions.sandboxAutoOutside": "旧版自动保存 · 已停用",
  "permissions.sandboxUserOutside": "有效授权 · 你已允许",
  "permissions.sandboxUserOutsidePaused": "严格安全隔离已开启 · 你保存的授权暂不生效",
  "permissions.sandboxRememberedOutside": "已记住的直接运行授权",
  "permissions.sandboxAutoDelete": "删除",
  "permissions.sandboxOutsideCommands": "固定直接运行的命令（不经安全隔离）",
  "permissions.sandboxOutsideCommandsNote":
    "每行一条：程序名加固定参数，末尾可加 *（例如 git *）。复合命令每一段都匹配才算。含重定向、cd 或变量展开的不匹配。手工条目每次仍需确认。已记住的授权仅限所列文件夹，在私聊中按普通权限运行。直接运行没有文件和网络隔离保护。",
  "permissions.sandboxOutsidePlaceholder": "例如：git *（每行一条）",
  "permissions.sandboxOutsideCommandsStrict": "严格安全隔离已打开，清单暂不生效。",
  "permissions.sandboxOutsideCommandsInvalid":
    "格式不对：每行一条，程序名加参数，* 只能放在最后，最多 32 条。",
  "permissions.unisolated": "直接运行（无隔离保护）",
  "permissions.note.run_command.windows":
    "Windows 无法隔离限制命令范围，命令会以你的身份直接运行。权限允许时，查看文件列表、读取文件等支持的只读操作可直接运行。",
  "permissions.info.run_command.windows":
    "设为「不允许」时命令不会运行。权限允许时，查看文件列表、读取文件等支持的只读操作可直接运行；其他命令会逐次向你确认，除非这个对话开启了自动批准模式且你同意直接运行。",
  "permissions.windowsAlwaysUnavailable":
    "Windows 无法隔离限制命令范围，不能设为「总是允许」；如需自动批准，请在对话里单独开启自动批准模式",
  "permissions.connectionsAndSending": "连接与发送",
  "permissions.confirmEverySend": "这个 Bot 每次对外发送都要你确认",
  "approval.connection": "插件",
  "approval.connectedTool": "本次操作",
  "approval.connectionId": "连接 ID",
  "approval.toolId": "工具 ID",
  "approval.connectorDetails": "连接与工具详情",
  "approval.connectorHint.once": "仅允许本次只读调用，下次使用时再询问。",
  "approval.connectorHint.bot": "允许这个 Bot 使用此连接；工具权限与对外发送确认仍然生效。",
  "approval.connectorHint.all": "允许所有 Bot 使用此连接；工具权限与对外发送确认仍然生效。",
  "approval.connectorAccess": "使用此连接的范围",
  "approval.connectorOnce": "只这一次",
  "approval.connectorBot": "总是允许这个 Bot 使用",
  "approval.connectorAll": "所有 Bot 都可以用",
  "approval.connectorAllow": "允许",

  "log.output": "命令输出",
  "log.search": "搜索输出",
  "log.matches": "第 {current} / 共 {total} 个",
  "log.previous": "上一个",
  "log.next": "下一个",
  "log.wrap": "自动换行",
  "log.copy": "复制全部",
  "log.reveal.mac": "在访达中显示",
  "log.reveal.win": "在资源管理器中显示",
  "log.reveal.linux": "在文件管理器中显示",
  "log.close": "关闭",
  "log.truncated": "只显示前 5 MB",
  "log.empty": "这条命令没有输出",
  "log.missing": "这条命令没有留下输出日志",
  "log.error": "无法读取输出日志。",
  "log.actionError": "操作失败，请重试。",
  "log.unsupported": "此平台不支持在文件管理器中显示。",
  "log.more": "加载更多",

  "permissions.adjust": "调整权限",
  "permissions.scope": "权限范围",
  "permissions.allBots": "全部 Bot",
  "permissions.followGlobal": "跟随全局",
  "permissions.ceiling": "全局默认：{level}；Bot 可独立设置。",
  "permissions.custom": "独立设置",
  "tool.read_messages": "查询聊天历史",
  "audit.messages.read": "已查询 {messages} 条消息、{conversations} 个会话",
  "audit.messages.count": "消息 / 会话数",
  "permissions.limited": "仍受工作文件夹与系统边界限制",
  "permissions.effective": "当前生效：{level}",
  "permissions.globalNetwork": "全局联网设置只是默认，Bot 可独立设置网站范围。",
  "permissions.domainOutsideGlobal": "请输入有效的网站域名。",
  "permissions.domainLimited": "网站范围：{domain}",
  "tool.historyOutputNote": "历史预览：本轮运行前 32 KB 中最多 200 行，可打开完整输出。",
  "tool.outputNote": "仅保留最后 200 行，超长文本会截断。",
  "permissions.note.computer": "每个任务先弹授权卡。系统授权、不能操作的应用在「操作电脑」页。",
  "permissions.note.read_ai_config":
    "每次单独批准，内容先脱敏；自动批准模式仅放行这一次，不记住授权",
  "permissions.note.read_messages":
    "默认允许。可读取自己的话题和所在群的获准记录；搜索限本 Bot 的私聊或当前群。",
  "permissions.note.send_out": "经连接发消息、新建或修改内容；以你的身份发送时，每次都需要你确认",
  "permissions.note.agent_delegation":
    "把一项工作交给你添加的外部 Agent（如 Codex），它用自己的账号在这个话题的文件夹里做；工作内容会发给那个 Agent 和它的模型服务商。",
  "settings.permissions": "权限",
  "sidebar.waiting": "等你处理",
  "sidebar.waitingFor": "等你处理：{title}",
  "approval.label": "操作审批",
  "approval.danger": "危险操作：请仔细检查，每次都需要你的允许。",
  "approval.dangerReview": "危险操作，请仔细检查。",
  "approval.deny": "拒绝",
  "approval.allowOnce": "本次允许",
  "approval.allowAlways": "一直允许",
  "approval.alwaysHint": "「一直允许」：{scope}；可在这个 Bot 资料面板的「权限」里撤销",
  "approval.sandboxRememberHint":
    "「一直允许」：{scope}。可在「设置 › 权限 › 隔离环境里记住的授权」撤销。",
  "approval.routineRememberHint": "{scope}。可在「例行任务」中编辑这项任务，移除授权并保存。",
  "approval.revokeServiceHint": "前往设置撤销服务授权",
  "approval.systemServiceDetails": "查看系统服务标识",
  "approval.rememberPrograms":
    "以后在整个工作文件夹（含所有子文件夹）运行同一组程序 {programs} 不再询问",
  "approval.rememberWeb": "以后访问 {scope} 不再询问（不含子域名）",
  // Remembered form submissions in the Bot browser, per site.
  "approval.rememberSubmit": "以后在 {scope}（含子域名）提交表单不再询问",
  "permissions.submitScope": "提交表单 · {site}",
  // "always allow" on a web_fetch card remembers reading public pages for this Bot.
  "approval.rememberWebRead":
    "以后这个 Bot 读取公开网页不再询问（仅查看公开网页；Bot 浏览器、登录、提交表单仍会问，内网地址仍拒绝）",
  "permissions.webReadScope": "读取公开网页",
  // Owner decision 2026-10-23: "don't ask again" on a paid image card, per Bot + exact model.
  "approval.rememberPaidImage": "这个 Bot 用这个模型不再问（{model}）",
  "permissions.paidImageScope": "付费生成图片 · {model}",
  "approval.rememberWrite": "以后写入整个工作文件夹（含所有子文件夹）不再询问",
  "approval.groupWriteHint":
    "当前群的写文件设置需要确认。选择记住这个工作文件夹的写入授权后，本群成员写入同一文件夹无需每步确认；文件夹外写入仍逐次询问。",
  "approval.rememberFolder": "以后对这个文件夹的同类操作不再询问",
  "approval.chatCountdown": "剩余 {time} · 到时未处理将暂停，等待你确认",
  "approval.countdown": "剩余 {time} · 到时未处理将过期",
  "approval.paused": "已暂停，等你决定",
  "approval.awaitingExpiry": "正在确认处理结果…",
  // Maintainers 2026-11-01: the token card names the command, the tokens and the folder in rows.
  "approval.row.command": "命令",
  "approval.row.tokens": "令牌",
  "approval.row.cwd": "位置",
  "approval.tokensHidden": "{names}（不会显示值）",
  "approval.tokenInjection": "卡片隐藏令牌的值。批准后，程序运行时会通过环境变量收到令牌的原值。",
  "approval.allowTokenAlways": "以后都允许这个令牌",
  "approval.allowTokensAlways": "以后都允许这些令牌",
  "approval.allowFuture": "以后都允许",
  "approval.whyAsk": "为什么要问",
  "approval.connectorTitle": "{bot}想用 {name} 读取：{tool}",
  "approval.secretChanged": "密钥已在别处更新，需要重新确认。请刷新待审批请求。",
  "approval.error": "未能确认处理结果，请刷新后重试。",
  "approval.loadError": "无法加载待审批操作。",
  "approval.pending": "等待你处理",
  "approval.allowed": "你允许了",
  "approval.denied": "你拒绝了",
  "approval.auto_denied": "已自动拒绝",
  "approval.cancelled": "已停止，审批取消",
  "approval.expired": "审批已过期",
  "approval.superseded": "这一步已经过时：之后对话里有了新进展。需要的话让 Bot 重新做这一步。",
  "approval.revokeHint": "可在设置里撤销",
  "facts.program": "程序",
  "facts.read": "读取",
  "facts.write": "写入",
  "facts.library": "知识库",
  "facts.note": "笔记",
  "facts.diff": "差异",
  "facts.memoryUser": "用户记忆",
  "facts.memoryBot": "Bot 记忆",
  "facts.memoryGroup": "群共享记忆",
  "facts.memoryProject": "项目记忆",
  "facts.memoryChange": "记忆修改",
  "facts.memoryRemove": "要删除的记忆",
  "facts.memoryNote": "记忆内容",
  "facts.value.memoryUser": "所有 Bot 共用",
  "approval.showDiff": "展开差异",
  "facts.network": "联网",
  "facts.cwd": "当前目录",
  "facts.warning": "提示",
  "facts.value.network_target_unknown": "联网目标未知",
  "facts.value.readonly": "只读操作",
  "facts.value.topic_writable_scope":
    "选择「以后允许」会覆盖本话题当前的所有可写文件夹，不适用于其他话题；移除文件夹后不再覆盖。",
  "facts.value.incomplete_analysis": "无法完全确定会做什么，不能记住授权",
  "facts.value.windows_unisolated":
    "Windows 没有命令沙箱。此命令将以你的账户运行，可以读写你有权访问的文件，也可以使用你的网络。",
  "facts.value.local_service":
    "这次会额外开放这一个本机服务地址；其他未授权的本机服务仍受安全隔离限制，已有网络与本机服务授权保持不变。",
  "facts.value.outside_sandbox_login":
    "这个程序需要读取你本机的登录凭据或配置（如 aws、gh、kubectl、ssh），在安全隔离里无法运行，因此请你批准直接运行（不受安全隔离限制）",
  "facts.value.outside_sandbox":
    "命令会以你的身份直接运行，可以读写你能访问的文件并联网。安全隔离不会限制文件和网络访问。",
  "approval.directRunRemember": "直接运行并记住",
  "approval.manageDirectRun": "管理已保存的直接运行授权",
  "approval.directRunLegacy":
    "这台电脑上的旧版 Pi Bot 可能自动记住本次直接运行的权限。更新电脑上的 Pi Bot 后，你可以单独选择是否记住。",
  "approval.directRunRememberHint":
    "这次运行结束后，任何 Bot 在私聊中从「{folder}」文件夹运行以「{program}」开头的匹配命令，都可按普通权限跳过安全隔离。后续命令可以使用不同参数，也能访问该文件夹以外的文件和网络。可在「设置 › 权限 › 高级」删除。",
  "facts.value.acp_editor_terminal_unisolated":
    "命令将由编辑器终端直接执行；Pi Bot 无法证明编辑器提供了系统隔离",
  "facts.value.editor_session_rememberable":
    "「本次会话都允许」只在这次编辑器连接期间有效，断开即失效。每次仍检查是否在会话的工作文件夹内。只读命令可用同一程序和选项读取不同文件或搜索不同内容，也可更改选项的值。切换目录可选会话内的其他文件夹。修改文件的命令必须使用完全相同的参数。",
  "facts.value.outside_delete": "将删除工作文件夹以外的文件",
  "facts.value.protected_command_path": "涉及本次可写工作文件夹以外的受保护数据",
  "facts.value.outside_workplace_write":
    "将写入工作文件夹以外的路径：只能允许这一次，只放开上面列出的路径，下次还会再问",
  "approval.outsideWriteFolderHint":
    "要在这里继续工作，可以通过系统选择框为本话题添加可写文件夹。添加成功后原请求作废，Bot 会重试。也可在话题的文件夹菜单中添加。",
  "approval.addWritableFolder": "把这个文件夹加为可写文件夹",
  "facts.value.outside_permissions": "将修改工作文件夹以外的文件权限",
  "facts.value.remove_workplace_root": "将删除整个工作文件夹",
  "facts.value.system_settings": "可能修改系统设置",
  "facts.value.force_push": "将强制推送 Git 历史",
  "facts.value.hard_remote_reset": "将丢弃本地修改并重置 Git 历史",
  "facts.value.shutdown": "将关闭或重启电脑",
  "facts.value.kill_init": "将终止系统关键进程",
  "facts.value.killall_without_target": "将批量终止进程",
  "facts.value.download_and_execute": "将下载并执行外部代码",
  "facts.value.readableConversations": "此 Bot 可访问的话题与群聊",
  "facts.value.scriptByContent": "按内容核对过的脚本（内容改了会再问）",
  "facts.value.currentChatHistory": "此 Bot 的私聊或当前群的过往话题",
  "facts.value.unknownWarning": "无法完全确定此操作的影响，请仔细检查",
  "commandProtection.title": "运行命令所需的系统保护",
  "commandProtection.blocked": "系统保护恢复前，需要它的 Bot 命令不会在这台电脑上运行。",
  "commandProtection.ready": "系统保护已就绪。可以让 Bot 重试。",
  "commandProtection.checkFailed": "无法确认系统保护是否就绪。请再检查一次。",
  "commandProtection.installNote":
    "Pi Bot 会用系统的软件安装工具装到这台电脑上。系统可能要求管理员确认。",
  "commandProtection.manualNote": "无法从这里安装，请让管理员安装所需组件，然后再检查。",
  "commandProtection.outcome.installed": "安装完成。等几秒后再检查系统保护。",
  "commandProtection.outcome.denied": "系统没有批准安装。请重试，或复制命令请管理员安装。",
  "commandProtection.outcome.failed": "系统安装工具未能完成安装。请重试，或复制命令请管理员安装。",
  "commandProtection.outcome.busy": "已有一个安装在进行，请稍等再检查。",
  "commandProtection.advanced": "高级",
  "commandProtection.apparmor":
    "请管理员检查 AppArmor 的拒绝记录，确认受影响的程序和配置。仅当系统已经有允许 bwrap 使用用户命名空间的配置、但尚未加载时，请管理员用下方命令加载。",
  "commandProtection.copy": "复制命令",
  "commandProtection.copied": "已复制",
  "commandProtection.recheck": "重新检测",
  "commandProtection.install": "安装 {dependency}",
  "isolation.warning": "命令在执行设备上不隔离运行。",
  "isolation.deviceBlocked": "在「{name}」恢复系统保护前，需要它的 Bot 命令不会在这台设备上运行。",
  "isolation.deviceInstall": "请让管理员在「{name}」上安装 {dependency}。",
  "isolation.reason.windows_unisolated":
    "Windows 上的命令以你的权限运行。权限允许时，受支持的只读命令可直接运行。其他获准执行的命令需要你确认，除非你在这个对话中开启自动批准，并同意在没有系统保护的情况下运行。",
  "isolation.warning.device": "这台设备当前无法隔离命令。",
  "isolation.warning.device.blocked": "这台设备当前无法隔离命令。需要隔离的普通命令会被拦下。",
  "isolation.reason.windows_unisolated_consented":
    "Windows 上没有命令沙箱。经权限检查的只读命令可以直接运行。你已同意无隔离运行，开启 YOLO 的对话里普通命令可以直接运行。危险或无法解析的命令仍会询问。",
  "isolation.reason.acp_editor_terminal_unisolated":
    "命令由编辑器终端直接执行；Pi Bot 无法证明编辑器提供了系统隔离。",
  "isolation.reason.platform_unsupported": "这个系统不支持命令隔离。",
  "isolation.reason.sandbox_dependencies_or_runtime_unavailable": "隔离组件缺失或无法启动。",
  "isolation.reason.linux_bubblewrap_missing":
    "缺少 bubblewrap。Pi Bot 需要它来限制命令可以访问的文件。",
  "isolation.reason.linux_socat_missing":
    "缺少 socat。Pi Bot 需要它来按你的联网设置处理命令的网络访问。",
  "isolation.reason.linux_userns_disabled":
    "这台电脑关闭了命令所需的系统功能。请在支持该功能的电脑上运行 Pi Bot。",
  "isolation.reason.linux_ripgrep_unavailable":
    "Pi Bot 找不到运行命令所需的随附组件。请重新安装并打开 Pi Bot。",
  "isolation.reason.linux_sandbox_host_unavailable":
    "命令保护组件没能启动。请重新安装并打开 Pi Bot。",
  "isolation.reason.linux_userns_limit_zero":
    "这台电脑关闭了命令所需的系统功能。请在支持该功能的电脑上运行 Pi Bot。",
  "isolation.reason.linux_seccomp_helper_unavailable":
    "Pi Bot 无法启动限制命令权限的组件。请重新安装并打开 Pi Bot。",
  "isolation.reason.linux_userns_restricted":
    "系统未能建立运行命令所需的保护。请让管理员检查这台电脑的 AppArmor 设置。",
  "isolation.reason.isolation_check_unfinished":
    "沙箱自检还没完成（电脑较忙），运行命令时会重新检查。",
  "isolation.available": "已开启",
  "isolation.unavailable": "不可用",
  "workplaces.title": "工作文件夹",
  "workplaces.headerLabel": "工作文件夹",
  "workplaces.header": "工作文件夹 {name}，点击打开工作文件夹面板",
  "workplaces.unavailable": "无法加载",
  "workplaces.folderMissing": "文件夹已不存在",
  "workplaces.runnerOffline": "执行端离线",
  "workplaces.folderMissingHint":
    "这个话题的文件夹已不存在或被移走。请在上方改选文件夹，或改用 Bot 自己的文件夹。",
  "workplaces.home": "Bot 自己的文件夹",
  "workplaces.note": "Bot 只能在这些文件夹里写文件。",
  "workplaces.current": "当前文件夹",
  "workplaces.setCurrent": "设为当前",
  "workplaces.add": "添加文件夹",
  "workplaces.remove": "移除",
  "workplaces.removeNamed": "移除 {name}",
  "workplaces.close": "关闭工作文件夹",
  "workplaces.permissions": "在设置里调整权限 →",
  "workplaces.error": "无法更新工作文件夹，请重试。",
  "permissions.note": "这是所有 Bot 的默认权限，每个 Bot 可以在自己资料里的「权限」单独改。",
  "permissions.error": "无法加载或保存权限，请重试。",
  "permissions.operations": "本机操作",
  "permissions.category.run_command": "运行命令",
  "permissions.category.computer": "操作电脑",
  "permissions.category.connector": "使用插件",
  "permissions.note.connector":
    "调用对该 Bot 可见的已启用工具；只读工具按权限调用，写入经过发送草稿。",
  "permissions.category.read_file": "读文件",
  "permissions.category.list_dir": "列目录",
  "permissions.category.write_file": "写文件",
  "permissions.category.memory": "记忆",
  "permissions.category.read_ai_config": "读其他 AI 工具的配置",
  "permissions.category.read_messages": "读聊天消息",
  "permissions.category.send_out": "对外发送",
  "permissions.category.agent_delegation": "交给外部 Agent",
  "permissions.category.web": "访问网站",
  "permissions.note.run_command":
    "工作文件夹内已知只读命令直接运行；总是允许时，安全隔离内的命令也直接运行。文件夹外写入、常用软件源以外联网、安装与后台启动仍需确认，受保护位置仍拒绝",
  "permissions.note.read_file":
    "工作文件夹以外的文件会先问你；允许一次后，同一文件夹在这次回复里不再问",
  "permissions.note.list_dir": "看文件夹里有什么、找文件、搜索文件内容",
  "permissions.note.write_file":
    "工作文件夹内按这里的设置写入；文件夹外的写入逐次确认，受保护位置仍拒绝。执行端不允许文件夹外写入；可用的文件检查点可在改动页恢复",
  "permissions.note.web":
    "访问和读取公开网页默认允许。设为「询问」会按权限提示。每个网站首次自动登录或提交表单仍会问你。",
  "permissions.level.never": "不允许",
  "permissions.level.ask": "询问",
  "permissions.level.always": "总是允许",
  "permissions.grants": "已一直允许的",
  "permissions.revoke": "撤销",
  "permissions.noGrants": "没有已记住的授权。需要授权时会按权限设置询问。",
  "permissions.grantsError": "无法加载或撤销授权，请重试。",
  "permissions.loadMore": "加载更多",
  "permissions.network": "联网",
  "permissions.allowNetwork": "扩大联网范围",
  "permissions.webNetworkOn":
    "读取公开网页、使用 Bot 浏览器和连接已配置的图片和视频服务时，不再受网站名单限制。各项权限仍然生效。",
  "permissions.webNetworkOff":
    "开启后，读取公开网页、使用 Bot 浏览器和连接已配置的图片和视频服务时可访问名单外的站点。各项权限仍然生效。",
  "permissions.networkOn":
    "这台电脑上，经确认或自动批准的隔离命令可访问公开网站。按「总是允许」自动运行的隔离命令只可访问名单内的网站和常用软件下载来源。",
  "permissions.networkOff": "这台电脑上，普通隔离命令只能访问名单内的公开网站。",
  "permissions.networkOnWindows":
    "这台 Windows 电脑可以按权限运行普通命令。命令以你的身份直接运行，可以联网，网站名单无法限制它。",
  "permissions.networkOffWindows":
    "这台 Windows 电脑上的普通命令会被拦下。Bot 仍可使用有权限的文件工具。",
  "permissions.networkOnUnknown":
    "经确认或自动批准的隔离命令可访问公开网站，符合权限的 Windows 普通命令可以直接联网。",
  "permissions.networkOffUnknown":
    "普通隔离命令只能访问名单内的公开网站。Windows 普通命令会被拦下。",
  "permissions.networkDetails": "查看联网细则",
  "permissions.networkHideDetails": "收起联网细则",
  "permissions.networkExceptions":
    "配对执行设备上的受限自动命令只能访问常用软件下载来源（如 npm 和 PyPI）。开关打开时会自动加入这些来源，关闭时只允许名单中已有的来源。另行获准跳过安全隔离的命令可以直接联网，网站名单无法限制它。访问本机和局域网服务另有权限。",
  "permissions.commandDomainsNote":
    "为这台 Mac 或 Linux 电脑上的隔离命令添加网站，如 feishu.cn 或 github.com。编辑名单不会改变联网开关。",
  "permissions.commandDomainsNoteOff":
    "关闭扩大联网范围时，这台 Mac 或 Linux 电脑上的普通隔离命令只能访问名单内的公开网站，常用软件源也需加到名单。",
  "permissions.noExplicitDomains": "还没有添加网站。",
  "permissions.noDomains": "名单里还没有网站。",
  "permissions.domain": "网站域名（如 feishu.cn）",
  "permissions.addDomain": "添加网站",
  "permissions.domainInvalid":
    "请只填主域名，例如 feishu.cn 或 api.github.com，不要带 https://、端口或路径（最多 200 项）。",
  "permissions.removeDomain": "移除网站 {domain}",
  "permissions.paths": "命令搜索路径",
  "permissions.pathsNote": "可选：在默认 PATH 之外添加目录，每行一个绝对路径。",
  "permissions.pathsInvalid": "请输入不含控制字符的绝对路径，最多 200 项。",
  "permissions.viewAudit": "查看操作记录 →",
  "permissions.back": "← 返回权限",
  "audit.title": "操作记录",
  "audit.note": "审批与执行的事实记录，保留 90 天，不含命令输出或文件内容。",
  "audit.bot": "Bot",
  "audit.kind": "类型",
  "audit.allBots": "全部 Bot",
  "audit.allKinds": "全部类型",
  "audit.botsError": "无法加载 Bot 名单，暂用 ID 显示。",
  "audit.error": "无法加载操作记录，请重试。",
  "audit.empty": "还没有操作记录。",
  "audit.details": "查看事实详情",
  "audit.kind.approval.requested": "请求审批",
  "audit.kind.approval.paused": "到期暂停",
  "audit.kind.approval.resolved": "审批处理",
  "audit.kind.exec.started": "开始执行",
  "audit.kind.exec.finished": "执行结束",
  "audit.kind.file.written": "写入文件",
  "audit.kind.grant.created": "记住授权",
  "audit.kind.grant.revoked": "撤销授权",
  "audit.kind.policy.denied": "策略拒绝",
  "audit.summary.approval.requested": "等待你确认此操作。",
  "audit.summary.approval.paused": "审批到期，运行已暂停，等待你的决定。",
  "audit.summary.approval.resolved": "审批已处理。",
  "audit.summary.exec.started": "命令开始执行。",
  "audit.summary.exec.finished": "命令执行结束。",
  "audit.summary.file.written": "文件已写入。",
  "audit.summary.grant.created": "已记住授权，可在权限设置中撤销。",
  "audit.summary.grant.revoked": "已撤销记住的授权。",
  "audit.summary.policy.denied": "工具已被拦截。",
  "audit.summary.stopped": "命令已停止。",
  "audit.summary.timedOut": "命令执行超时。",
  "tool.run_command": "运行命令",
  "tool.read_file": "读文件",
  "tool.send_file": "发文件",
  "tool.reveal_in_folder": "在文件夹中显示",
  "tool.local_network": "查看本机网络",
  "tool.write_file": "写文件",
  "tool.edit_file": "改文件",
  "tool.list_dir": "列目录",
  "tool.find_files": "找文件",
  "tool.search_text": "搜索内容",
  "tool.web_fetch": "读网页",
  "tool.execution_targets": "查看执行端",
  "tool.workplace_use_runner": "提议换到执行端文件夹",
  "tool.delegate_to_agent": "交给外部 Agent",
  "tool.phone_media": "读取手机照片",
  "tool.phone_media_get": "查看手机照片",
  "tool.phone_sms_code": "接收短信验证码",
  "tool.phone_calls": "读取通话记录",
  "tool.phone_notifications": "读取手机通知",
  "tool.tool_discover": "查找工具",
  "tool.group_plan": "制定计划",
  "tool.todo_pause": "暂停任务清单",
  "tool.unknown": "使用工具",
  "tool.step": "{action}{target} · 第 {step} 步",
  "tool.sandboxBlocked": "安全隔离拦下了：{kind}{target}{program}（{rule}）",
  "tool.sandboxBlockedNoRule": "安全隔离拦下了：{kind}{target}{program}",
  "tool.sandboxRule.proxy_denied": "网络代理拒绝了连接",
  "tool.sandboxRule.proxy_not_allowed": "网站不在允许名单内",
  "tool.sandboxRule.loopback_proxy": "本机服务未开放",
  "tool.sandboxRule.loopback_socket": "本机服务端口未开放",
  "tool.sandboxRule.loopback_bind": "不允许监听本机端口",
  "tool.sandboxRule.loopback_namespace": "隔离网络内无法访问本机服务",
  "tool.sandboxRule.local_bind": "不允许监听网络端口",
  "tool.sandboxRule.socket": "不允许直接连接网络",
  "tool.sandboxRule.unix_socket": "安全隔离不允许这个连接",
  "tool.sandboxRule.mach_lookup": "系统服务未开放",
  "tool.sandboxRule.keychain": "不允许访问系统钥匙串",
  "tool.sandboxRule.pasteboard": "不允许访问系统剪贴板",
  "tool.sandboxRule.dev_write": "不允许写入系统设备",
  "tool.sandboxRule.credential_store": "受保护的凭据目录不可读取",
  "tool.sandboxRule.bot_home": "受保护的凭据目录不可读取",
  "tool.sandboxRule.deny_read": "受保护的文件不可读取",
  "tool.sandboxRule.write_root": "超出当前工作文件夹范围",
  "tool.sandboxRule.explicit_deny": "受保护的位置不可修改",
  "tool.sandboxRule.file_write": "不允许写入该位置",
  "tool.sandboxRule.git_metadata": "受保护的 Git 配置不可修改",
  "tool.sandboxRule.git_hooks": "受保护的 Git 钩子不可修改",
  "tool.sandboxRule.git_config": "受保护的 Git 配置不可修改",
  "tool.networkSettingsBlocked": "联网设置拦下了：{target} 不在允许的网站名单里，命令未运行",
  "tool.sandboxLocalBlocked": "安全隔离拦下了命令{program}与{service}的连接。",
  "tool.sandboxLocalListeningBlocked": "安全隔离拦下了命令{program}在{service}等待连接。",
  "tool.sandboxLocalService": "本机服务",
  "tool.sandboxLocalServiceDocker": "本机 Docker 服务",
  "tool.sandboxConnectionDetails": "高级 · 连接详情",
  "tool.sandboxSeeApproval": "查看审批 ↓",
  "tool.sandboxSeePermissions": "查看权限设置",
  "tool.website.add": "允许访问 {domain}…",
  "tool.website.saved": "{domain} 已加入，可重试 · 查看范围",
  "tool.website.title": "加入允许的网站",
  "tool.website.domain": "允许网站：{domain}（网页访问沿用现有规则，也包括其子域名）",
  "tool.website.scope": "生效范围",
  "tool.website.bot": "这个 Bot",
  "tool.website.group": "这个群",
  "tool.website.global": "全局默认",
  "tool.website.botHelp":
    "只加入发起这次命令的 Bot 的允许网站，其他 Bot 和群不变。可在这个 Bot 的权限设置中移除。",
  "tool.website.groupHelp":
    "只加入发起这次命令的群的允许网站，该群成员执行群任务时使用；不会修改成员的私聊权限。可在群权限设置中移除。",
  "tool.website.globalHelp":
    "加入全局默认允许网站，跟随默认网络配置的 Bot 和群都能使用；已有独立网络配置的 Bot 和群不会被覆盖。可在设置 → 权限 → 联网中移除。",
  "tool.website.noRetry":
    "仅保存网站权限，联网开关和其他授权保持原设置。保存后请重试命令；不会自动执行。私网和本机服务仍按原规则授权。",
  "tool.website.confirm": "加入允许的网站",
  "tool.website.retryBotScope":
    "此网站会一直保留在这个 Bot 的允许列表中，直到你在它的权限设置中移除。",
  "tool.website.retryGroupScope":
    "此网站会一直保留在这个群的允许列表中，直到你在群权限设置中移除。",
  "tool.website.retrySkip": "保持阻止",
  "tool.website.retryConfirm": "允许此网站并重试",
  "tool.website.retryHelp": "Pi Bot 会重新检查权限，再用同一条命令继续。",
  "tool.website.retryRan":
    "刚才的命令可能已经执行了一部分。确认后，Pi Bot 会重新检查权限，再从头执行这条命令。",
  "tool.website.retryStarted": "已允许 {domain}，正在重试",
  "tool.website.retryExpired": "这次重试已过期。你仍可加入网站，然后在聊天中重新发起。",

  "tool.website.full":
    "这个范围的允许网站已满（200 项）。请先在权限设置中移除不需要的网站，再重试。",
  "tool.website.unavailable": "这条拦截记录或所属 Bot／群已不可用。请回到当前对话重新发起操作。",
  "tool.sandboxKind.outside_workplace_write": "工作文件夹外写入",
  "tool.sandboxKind.protected_name": "受保护的位置",
  "tool.sandboxKind.git_resource": "Git 资源",
  "tool.sandboxKind.network": "联网",
  "tool.sandboxKind.local_service": "本机服务",
  "tool.sandboxKind.system_service": "系统服务",
  "tool.sandboxKind.protected_path": "受保护的位置",
  "tool.sandboxKind.credential_read": "凭据读取",
  "tool.sandboxKind.protected_read": "受保护的读取",
  "tool.sandboxKind.other": "安全限制",
  "tool.executing": "正在{action}{target}",
  "tool.active.command": "正在运行{target}",
  "tool.active.read": "正在读{target}",
  "tool.active.write": "正在写{target}",
  "tool.active.edit": "正在修改{target}",
  "tool.active.search": "正在搜索{target}",
  "tool.active.webpage": "正在看网页{target}",
  "tool.group.summary": "执行了 {count} 步 · {types}",
  "tool.group.summaryOne": "执行了 {count} 步 · {types}",
  "tool.group.progress": "已完成 {count} 步",
  "tool.group.count": "{tool} {count} 次",
  "tool.group.separator": "、",
  "tool.status.pending": "等待审批",
  "tool.status.running": "运行中",
  "tool.status.waitingFolder": "等 {bot} 改完",
  "tool.status.waitingFolderUnknown": "等另一个 Bot 改完",
  "tool.status.waitingReviewFolder": "等待{bot}释放工作区后开始审查",
  "tool.status.waitingReviewFolderUnknown": "等待其他 Bot 释放工作区后开始审查",
  "tool.status.done": "已完成",
  "tool.status.error": "失败",
  "tool.status.blocked": "已被程序拦截",
  "tool.status.userDenied": "已拒绝",
  "tool.status.aborted": "已停止",
  "tool.exit": "退出码 {code}",
  "tool.duration": "耗时 {seconds} 秒",
  "tool.openLog": "打开完整输出",
  "tool.openFile": "打开写入文件",
  "tool.openError": "无法打开文件或输出，请检查操作记录与本地文件。",
  "tool.noOutput": "暂无输出。",
  "tool.searchHistoryReference": "聊天片段仅供参考。",
  "tool.searchHistoryPending": "历史记录仍在建立索引，结果可能不全。",
  "tool.searchHistoryOpen": "打开原话题",
  "tool.searchHistoryEmpty": "没有匹配的聊天片段。",
} as const;

export const permissionsEn: { [K in keyof typeof permissionsZh]: string } = {
  "permissions.serviceTrust": "Certificate trust evaluation",
  "permissions.serviceDirectory": "User and group lookup",
  "permissions.serviceNotification": "System notifications",
  "permissions.serviceKeychain": "System keychain",
  "permissions.servicePasteboard": "System clipboard",
  "permissions.serviceUnknown": "Other system service",
  "permissions.serviceOther": "System service {service}",
  "permissions.sandboxRemembered": "Remembered isolation permissions",
  "permissions.sandboxRememberedSummary":
    "{count} items · Write paths {writes} · Local services {local} · System services {system}",
  "permissions.sandboxRememberedSummary.one":
    "{count} item · Write paths {writes} · Local services {local} · System services {system}",
  "permissions.sandboxWrites": "Write paths",
  "permissions.sandboxLocal": "Local services",
  "permissions.sandboxSystem": "System services",
  "approval.sandboxRemember": "Allow and don't ask again in this folder",
  "facts.value.system_service": "Only this system service is allowed.",
  "policy.reason.system_service_once": "Allow this program to use the listed system service",

  "policy.reason.git_entry_confirmation_required":
    "This Git command would run project hooks or executable configuration (listed below). Confirm it explicitly this time; it is not remembered, and Auto-approve, existing grants and routines cannot answer it",
  "facts.value.git_entry_once":
    "Allows the listed entries to run this one time. Only the entry files are pinned, not the programs they call. If any entry or config changes before launch, the run is refused",
  "policy.reason.git_entry_include_unknown":
    "The repository's Git config uses include / includeIf, so which programs would run cannot be confirmed; unsupported",
  "policy.reason.git_entry_layout_unsupported":
    "Hooks in this Git layout (--git-dir, core.worktree, submodule recursion and similar) cannot be confirmed one by one; unsupported",
  "policy.reason.git_entry_scan_incomplete":
    "Could not read the repository's hooks and config within limits, so what would run is unknown; not run",
  "policy.reason.git_entry_compound":
    "Git inside this compound command would run project hooks or executable configuration, which cannot be confirmed there; run that Git command on its own",
  "policy.reason.git_entry_dynamic":
    "The command changes the repository, configuration or a program to run through environment variables, -c or an alias, so what would run cannot be confirmed",
  "policy.reason.git_entry_unsupported_target":
    "This Git command would run project hooks or executable configuration, which cannot be confirmed in routines, background, Docker, outside-sandbox runs, on Windows or on a device that cannot check them; not run",
  "policy.reason.git_hooks_path_confirmation_required":
    "Confirm this one project Git hooksPath change. It cannot be remembered and does not run or authorize any hook.",
  "facts.value.git_hooks_path_setter":
    "Only change project core.hooksPath. Do not read hook contents, run hooks, or authorize later Git execution.",
  "policy.reason.git_inline_execution_unsupported":
    "This Git command may invoke an explicit executable configuration override. Controlled per-use execution is unsupported; ordinary permissions, Auto-approve or existing grants cannot authorize it. Not executed.",
  "policy.reason.git_hook_confirmation_required":
    "Running this pre-commit native-program hook requires explicit confirmation for this call; permission is not remembered",
  "policy.reason.git_hook_unsupported":
    "This Git hook, script shape or execution target does not support controlled execution; the raw command will not run instead",
  "policy.reason.git_hook_unverified":
    "The Git hook, program or workspace differs from the prepared version; nothing ran",
  "facts.value.git_hook_literal_exec":
    "Run only the default pre-commit hook's fixed system native program and shown literal arguments. No Node/scripts, network, credentials or config changes. This call only; not remembered",
  "policy.reason.host_ssh_not_enabled":
    "This SSH host is not enabled: Settings → Permissions → Advanced → SSH hosts",
  "policy.reason.host_ssh_identity_required":
    "No private key is chosen for this host yet; choose one in Settings → Permissions → Advanced → SSH hosts",
  "policy.reason.host_ssh_unsupported":
    "This SSH form, configuration, or execution target is unsupported. The entire .ssh directory will not be opened, and no generic command fallback will run.",
  "policy.reason.ssh_config_private":
    "~/.ssh is a credential folder and cannot be read; connect with ssh ALIAS 'COMMAND'",
  "policy.reason.host_ssh_unsupported_syntax":
    "This SSH form is not supported: only ssh ALIAS 'REMOTE_COMMAND' with a few safe options",
  "policy.reason.host_ssh_unsupported_target":
    "Host SSH currently works only in ordinary macOS chats on this computer",
  "policy.reason.host_ssh_configuration_unavailable": "This alias is not in ~/.ssh/config",
  "policy.reason.host_ssh_unsupported_configuration":
    "This host's SSH configuration uses an unsupported feature; Pi Bot will not drop it to connect",
  "policy.reason.host_ssh_config_strict_host_key":
    "This host sets StrictHostKeyChecking to something other than yes (such as accept-new); change it to yes and retry",
  "policy.reason.host_ssh_config_option":
    "This host's SSH configuration uses an option Pi Bot does not support; see Settings → Permissions → Advanced → SSH hosts for the exact line",
  "policy.reason.host_ssh_config_user":
    "This host has no usable User (one @ is allowed, e.g. user@machine); add it and retry",
  "policy.reason.host_ssh_config_identity_outside_ssh":
    "This host's private key is outside ~/.ssh; move it into ~/.ssh with mode 600 or change IdentityFile, then retry",
  "policy.reason.host_ssh_unverified":
    "The SSH command, configuration, or file version no longer matches. Access was not granted.",
  "facts.value.host_ssh_static_identity":
    "Uses a static alias and one identity only; does not run user proxy commands or system configuration. Local SSH diagnostics and remote stderr are suppressed.",
  "policy.reason.git_configuration_confirmation_required":
    "This controlled Git configuration change needs your explicit confirmation each time; permission cannot be remembered",
  "policy.reason.git_configuration_unsupported":
    "This Git configuration operation or execution target does not support controlled changes; the raw command will not run instead",
  "policy.reason.git_configuration_unverified":
    "The Git operation, target or prepared version did not match; no write permission was granted",
  "policy.reason.git_configuration_project_setter":
    "Change one ordinary Git configuration key in the current project through a controlled operation",
  "policy.reason.git_configuration_global_setter":
    "Change only the current user's Git name or email through a controlled operation",
  "facts.value.git_configuration_project_setter":
    "Change one ordinary key in the shown project config; no whole-file or directory permission. The value is omitted",
  "facts.value.git_configuration_global_setter":
    "Change only name or email in the shown user config, with confirmation each time. No directory permission; the value is omitted",
  "policy.reason.git_configuration_sensitive_project_setter":
    "Change one executable Git configuration key in this project without running it; using that entry later needs a separate confirmation",
  "facts.value.git_configuration_sensitive_project_setter":
    "Change one executable key (helper / filter / sshCommand) in the shown project config, this time only and not remembered. The program is not run now; using it later needs its own confirmation. The value is omitted; no whole-file or directory permission",
  "policy.reason.task_web_read": "You allowed public web reads for this group task",
  "approval.allowTaskWeb": "Allow public web reads for this task",
  "approval.taskWebsiteHint":
    "Shared by this group task or plan's members, retries and reassignments; reading public web pages only. Excludes the Bot browser, logins, forms and private addresses. Expires on task end, cancellation, plan completion or restart.",
  "policy.reason.conversation_web_read":
    "You allowed public web reads from this website in this conversation",
  "approval.allowConversation": "Allow this website in this conversation",
  "approval.conversationWebsiteHint":
    "Reading public web pages on {domain} and its subdomains only; excludes browser, login, forms and private networks. Only this Bot and conversation; expires on restart.",
  "permissions.singleRootScope": "Only in folder {root}",
  "permissions.topicGrantScope":
    "Topic {topic} · Current writable folders: {roots} (follows topic changes)",
  "permissions.topicGrantUnavailable": "Working folders unavailable; rechecked before execution",
  "permissions.topicGrantNoRoots": "No writable folders",
  "permissions.yoloUnisolated": "Auto-approve runs commands directly on Windows",
  "permissions.yoloWindowsConsentedAt":
    "Consented on {date}. Eligible ordinary Windows commands can run directly in every conversation with Auto-approve on. Withdrawing restores individual approval for those commands in all of those conversations.",
  "permissions.yoloWindowsConsented":
    "Consented. Eligible ordinary Windows commands can run directly in every conversation with Auto-approve on. Withdrawing restores individual approval for those commands in all of those conversations.",
  "permissions.yoloWindowsNotConsented":
    "Consent not given. You can confirm when turning on Auto-approve.",
  "permissions.yoloWindowsWithdraw": "Withdraw",
  "permissions.yoloWindowsWithdrawFailed": "Couldn't withdraw consent. Try again.",
  "permissions.strictSandbox": "Strict isolation",
  "permissions.strictSandboxNote":
    "When on, a command blocked by safety isolation only explains why; running it once outside isolation is not offered, and the list below is ignored.",
  "permissions.sandboxAutoOutside": "Saved automatically by an older version · inactive",
  "permissions.sandboxUserOutside": "Active permission · allowed by you",
  "permissions.sandboxUserOutsidePaused": "Strict isolation is on · your permission is paused",
  "permissions.sandboxRememberedOutside": "Remembered direct-run permission",
  "permissions.sandboxAutoDelete": "Delete",
  "permissions.sandboxOutsideCommands": "Commands that run directly (outside isolation)",
  "permissions.sandboxOutsideCommandsNote":
    "Use one entry per line with the program and any fixed arguments, optionally ending in * (for example git *). Every part of a compound command must match. Commands with redirects, cd or variable expansion do not match. Manual entries require confirmation each time. Remembered permissions apply only in the listed folder and follow ordinary permissions in direct chats. Direct runs have no file or network isolation.",
  "permissions.sandboxOutsidePlaceholder": "e.g. git * (one per line)",
  "permissions.sandboxOutsideCommandsStrict":
    "Strict isolation is on, so the list is not in effect.",
  "permissions.sandboxOutsideCommandsInvalid":
    "Invalid entry: one per line, a program and its arguments, * only at the end, at most 32 entries.",
  "permissions.unisolated": "Runs directly (unisolated)",
  "permissions.note.run_command.windows":
    "Windows cannot isolate commands, so they run directly as you. Supported read-only actions (such as listing or reading files) run directly when permissions allow.",
  "permissions.info.run_command.windows":
    "Don't allow blocks commands. Supported read-only actions run directly when permissions allow. Other commands ask each time unless Auto-approve is on in the conversation and you consented to direct execution.",
  "permissions.windowsAlwaysUnavailable":
    "Windows cannot isolate commands, so Run commands cannot be set to Always; turn on Auto-approve in a conversation separately",
  "permissions.connectionsAndSending": "Connections and sending",
  "permissions.confirmEverySend": "This Bot asks you before every send",
  "approval.connection": "Connected app",
  "approval.connectedTool": "This operation",
  "approval.connectionId": "Connection ID",
  "approval.toolId": "Tool ID",
  "approval.connectorDetails": "Connection and tool details",
  "approval.connectorHint.once": "Allow this read-only call only. Ask again next time.",
  "approval.connectorHint.bot":
    "Allow this Bot to use the connection. Tool permissions and outgoing confirmations still apply.",
  "approval.connectorHint.all":
    "Allow all Bots to use the connection. Tool permissions and outgoing confirmations still apply.",
  "approval.connectorAccess": "Access to this connection",
  "approval.connectorOnce": "Only this time",
  "approval.connectorBot": "Always allow this Bot",
  "approval.connectorAll": "Allow all Bots",
  "approval.connectorAllow": "Allow",

  "log.output": "Command output",
  "log.search": "Search output",
  "log.matches": "{current} of {total} matches",
  "log.previous": "Previous",
  "log.next": "Next",
  "log.wrap": "Wrap lines",
  "log.copy": "Copy all",
  "log.reveal.mac": "Show in Finder",
  "log.reveal.win": "Show in Explorer",
  "log.reveal.linux": "Show in file manager",
  "log.close": "Close",
  "log.truncated": "Showing only the first 5 MB",
  "log.empty": "This command produced no output",
  "log.missing": "This command left no output log",
  "log.error": "Unable to read the output log.",
  "log.actionError": "Action failed. Please retry.",
  "log.unsupported": "Revealing files is unsupported on this platform.",
  "log.more": "Load more",
  "permissions.adjust": "Adjust permissions",
  "permissions.scope": "Permission scope",
  "permissions.allBots": "All bots",
  "permissions.followGlobal": "Follow global settings",
  "permissions.ceiling": "Global default: {level}; this Bot can choose independently.",
  "permissions.custom": "Independent setting",
  "tool.read_messages": "Query chat history",
  "audit.messages.read": "Read {messages} messages and {conversations} conversations",
  "audit.messages.count": "Messages / conversations",
  "permissions.limited": "Working folder and system boundaries still apply",
  "permissions.effective": "Effective level: {level}",
  "permissions.globalNetwork":
    "Global network settings are defaults; this Bot can choose its own website scope.",
  "permissions.domainOutsideGlobal": "Enter a valid website domain.",
  "permissions.domainLimited": "Website scope: {domain}",
  "tool.historyOutputNote":
    "History preview: up to 200 lines from the first 32 KB of this run. Open full output for more.",
  "tool.outputNote": "Only the last 200 lines are kept; very long text is truncated.",
  "permissions.note.computer":
    "Each task asks first with a grant card. System permissions and blocked apps are on the Computer use page.",
  "permissions.note.read_ai_config":
    "Approve each read; sensitive values are removed first. Auto-approve allows once without remembering.",
  "permissions.note.read_messages":
    "Allowed by default. Read its own topics and permitted group history; search only this Bot’s private chats or the current group.",
  "permissions.note.send_out":
    "Messages and changes made through connections. Sending as you requires your confirmation every time.",
  "permissions.note.agent_delegation":
    "Hand a piece of work to an external agent you added (such as Codex); it works in this topic's folder with its own account. The work is sent to that agent and its model provider.",
  "settings.permissions": "Permissions",
  "sidebar.waiting": "Needs your attention",
  "sidebar.waitingFor": "Waiting for you: {title}",
  "approval.label": "Operation approval",
  "approval.danger": "Dangerous operation: review carefully. Permission is required every time.",
  "approval.dangerReview": "Dangerous operation. Review carefully.",
  "approval.deny": "Deny",
  "approval.allowOnce": "Allow this time",
  "approval.allowAlways": "Always allow",
  "approval.alwaysHint":
    "“Always allow”: {scope}. You can revoke it on this Bot’s Permissions tab.",
  "approval.sandboxRememberHint":
    "Always allow: {scope}. Revoke under Settings › Permissions › Remembered isolation permissions.",
  "approval.routineRememberHint":
    "{scope}. To revoke, edit this routine in Routines, remove the permission and save.",
  "approval.revokeServiceHint": "Revoke service access in Settings",
  "approval.systemServiceDetails": "Show system service identifier",
  "approval.rememberPrograms":
    "Don’t ask again for the same programs ({programs}) in the working folders, including all subfolders",
  "approval.rememberWeb": "Don’t ask again for {scope} (subdomains excluded)",
  "approval.rememberSubmit":
    "Don’t ask again before submitting forms on {scope} (subdomains included)",
  "permissions.submitScope": "Submit forms · {site}",
  "approval.rememberWebRead":
    "Don’t ask again when this Bot reads public web pages (read-only fetch; the Bot browser, logins and form submissions still ask, private addresses stay blocked)",
  "permissions.webReadScope": "Read public web pages",
  "approval.rememberPaidImage": "Don’t ask again for this Bot with this model ({model})",
  "permissions.paidImageScope": "Paid image generation · {model}",
  "approval.rememberWrite":
    "Don’t ask again for writes in the working folders, including all subfolders",
  "approval.groupWriteHint":
    "This group's file-write setting requires approval. Remembering write access to these working folders covers the group's members, so later steps in the same location do not ask again. Writes outside these working folders still require approval each time.",
  "approval.rememberFolder": "Don’t ask again for this kind of operation in this folder",
  "approval.chatCountdown": "{time} remaining · Pauses for your decision when time runs out",
  "approval.countdown": "{time} remaining · Expires if unanswered",
  "approval.paused": "Paused — waiting for you",
  "approval.awaitingExpiry": "Confirming the result…",
  "approval.row.command": "Command",
  "approval.row.tokens": "Tokens",
  "approval.row.cwd": "Folder",
  "approval.tokensHidden": "{names} (value never shown)",
  "approval.tokenInjection":
    "The card hides the token value. Once approved, the program receives the original value in an environment variable when it runs.",
  "approval.allowTokenAlways": "Always allow this token",
  "approval.allowTokensAlways": "Always allow these tokens",
  "approval.allowFuture": "Always allow",
  "approval.whyAsk": "Why am I asked?",
  "approval.connectorTitle": "{bot} wants to use {name} to read: {tool}",
  "approval.secretChanged":
    "Secrets changed elsewhere and need confirmation again. Refresh pending approvals.",
  "approval.error": "Couldn’t confirm the decision. Refresh and try again.",
  "approval.loadError": "Couldn’t load pending approvals.",
  "approval.pending": "Waiting for your decision",
  "approval.allowed": "You allowed this",
  "approval.denied": "You denied this",
  "approval.auto_denied": "Automatically denied",
  "approval.cancelled": "Stopped; approval cancelled",
  "approval.expired": "Approval expired",
  "approval.superseded":
    "This step is out of date: the conversation has moved on since. Ask the Bot to do it again if you still need it.",
  "approval.revokeHint": "Revoke in Settings",
  "facts.program": "Programs",
  "facts.read": "Reads",
  "facts.write": "Writes",
  "facts.library": "Library",
  "facts.note": "Note",
  "facts.diff": "Diff",
  "facts.memoryUser": "User memory",
  "facts.memoryBot": "Bot memory",
  "facts.memoryGroup": "Shared group memory",
  "facts.memoryProject": "Project memory",
  "facts.memoryChange": "Memory change",
  "facts.memoryRemove": "Memory to delete",
  "facts.memoryNote": "Memory text",
  "facts.value.memoryUser": "Shared by all Bots",
  "approval.showDiff": "Show diff",
  "facts.network": "Network",
  "facts.cwd": "Working directory",
  "facts.warning": "Notice",
  "facts.value.network_target_unknown": "Network target unknown",
  "facts.value.readonly": "Read-only operation",
  "facts.value.topic_writable_scope":
    "Remembering covers this topic’s current writable folders only, not other topics; removing a folder removes it from that scope.",
  "facts.value.incomplete_analysis":
    "The operation cannot be fully determined; permission cannot be remembered",
  "facts.value.windows_unisolated":
    "Windows has no command sandbox. This command runs under your account. It can read and write files you can access and use your network.",
  "facts.value.local_service":
    "Additionally opens this local service address; other unauthorized local services stay blocked by safety isolation, and existing network or local-service permissions remain unchanged.",
  "facts.value.outside_sandbox_login":
    "This program needs your own login or configuration (aws, gh, kubectl, ssh credentials and the like) and cannot work inside safety isolation, so it asks to run directly outside isolation",
  "facts.value.outside_sandbox":
    "The command runs directly with your permissions. It can read and write files you can access and use the network, without file or network isolation.",
  "approval.directRunRemember": "Run and remember",
  "approval.manageDirectRun": "Manage saved direct-run permissions",
  "approval.directRunLegacy":
    "The older Pi Bot on this computer may automatically remember this direct-run permission. Update Pi Bot on the computer to choose whether to remember it.",
  "approval.directRunRememberHint":
    "After this run finishes, any Bot in a direct chat can run matching commands starting with “{program}” from “{folder}” under ordinary permissions, without a separate prompt to skip isolation. Future commands can use different arguments and can access files outside the folder and the network. Remove this permission in Settings › Permissions › Advanced.",
  "facts.value.acp_editor_terminal_unisolated":
    "The command runs directly in the editor terminal; Pi Bot cannot verify system isolation there",
  "facts.value.editor_session_rememberable":
    "“Allow for this session” ends when the editor disconnects. Each command is still checked against the session’s working folders. Read-only commands with the same program and options may use different files, search terms or option values. Folder changes can select a different folder within the session. Commands that change files must use the exact same arguments.",
  "facts.value.outside_delete": "Deletes files outside the working folders",
  "facts.value.protected_command_path":
    "References protected data outside this run's writable folders",
  "facts.value.outside_workplace_write":
    "Writes outside the working folders: allowed for this call only, just the paths listed above; it asks again next time",
  "approval.outsideWriteFolderHint":
    "Use the system picker to add a writable folder to this topic. Adding it invalidates this request so the Bot can retry. You can also add folders from the topic’s folder menu.",
  "approval.addWritableFolder": "Add this folder as writable",
  "facts.value.outside_permissions": "Changes file permissions outside the working folders",
  "facts.value.remove_workplace_root": "Deletes an entire working folder",
  "facts.value.system_settings": "May change system settings",
  "facts.value.force_push": "Force-pushes Git history",
  "facts.value.hard_remote_reset": "Discards local changes and resets Git history",
  "facts.value.shutdown": "Shuts down or restarts the computer",
  "facts.value.kill_init": "Terminates a critical system process",
  "facts.value.killall_without_target": "Terminates multiple processes",
  "facts.value.download_and_execute": "Downloads and executes external code",
  "facts.value.readableConversations": "Conversations and groups accessible to this Bot",
  "facts.value.scriptByContent": "A script checked by its content (asks again if it changes)",
  "facts.value.currentChatHistory":
    "Past topics in this Bot’s private chats or in the current group",
  "facts.value.unknownWarning": "The impact cannot be fully determined; review carefully",
  "commandProtection.title": "System protection for commands",
  "commandProtection.blocked":
    "Bot commands that require system protection are blocked on this computer until it’s restored.",
  "commandProtection.ready": "System protection is ready. You can ask your Bot to try again.",
  "commandProtection.checkFailed":
    "Pi Bot couldn’t check whether system protection is ready. Check again.",
  "commandProtection.installNote":
    "Pi Bot will install this on the computer using the system’s software installer. Your system may ask an administrator to confirm.",
  "commandProtection.manualNote":
    "Ask your administrator to install the required software, then check again.",
  "commandProtection.outcome.installed":
    "Installation finished. Wait a few seconds, then check system protection again.",
  "commandProtection.outcome.denied":
    "The system didn’t approve the install. Try again or copy the command for your administrator.",
  "commandProtection.outcome.failed":
    "The system installer couldn’t finish. Try again or copy the command for your administrator.",
  "commandProtection.outcome.busy":
    "An installation is already in progress. Wait a moment, then check again.",
  "commandProtection.advanced": "Advanced",
  "commandProtection.apparmor":
    "Ask your administrator to check the AppArmor denial log for the affected executable and profile. If a bwrap profile that allows user namespaces is already installed but has yet to load, your administrator can use the command below.",
  "commandProtection.copy": "Copy command",
  "commandProtection.copied": "Copied",
  "commandProtection.recheck": "Check again",
  "commandProtection.install": "Install {dependency}",
  "isolation.warning": "Commands run without isolation on the execution device.",
  "isolation.deviceBlocked":
    "Commands that need system protection are blocked on {name} until it is working there.",
  "isolation.deviceInstall": "Ask an administrator to install {dependency} on {name}.",
  "isolation.reason.windows_unisolated":
    "Windows commands run with your permissions. Supported read-only commands can run directly when permissions allow. Other permitted commands require confirmation unless you enable automatic approvals in that conversation and agree to run without system protection.",
  "isolation.warning.device": "Command isolation is currently unavailable on this device.",
  "isolation.warning.device.blocked":
    "Command isolation is currently unavailable on this device. Ordinary commands that require it are blocked.",
  "isolation.reason.windows_unisolated_consented":
    "Windows has no command sandbox. Supported read-only commands run when permissions allow. You’ve consented to unisolated execution, so ordinary commands run in chats with YOLO on. Dangerous commands and commands Pi can’t parse still ask.",
  "isolation.reason.acp_editor_terminal_unisolated":
    "The command runs directly in the editor terminal; Pi Bot cannot verify system isolation there.",
  "isolation.reason.platform_unsupported": "This system doesn't support command isolation.",
  "isolation.reason.sandbox_dependencies_or_runtime_unavailable":
    "The isolation components are missing or failed to start.",
  "isolation.reason.linux_bubblewrap_missing":
    "Pi Bot needs bubblewrap to limit which files commands can access.",
  "isolation.reason.linux_socat_missing":
    "Pi Bot needs socat to route command traffic according to your network settings.",
  "isolation.reason.linux_userns_disabled":
    "This computer has disabled a system feature required for command protection. Run Pi Bot on a computer that supports it.",
  "isolation.reason.linux_ripgrep_unavailable":
    "Pi Bot couldn’t find a bundled component needed to run commands. Reinstall and reopen Pi Bot.",
  "isolation.reason.linux_sandbox_host_unavailable":
    "A command protection component couldn’t start. Reinstall and reopen Pi Bot.",
  "isolation.reason.linux_userns_limit_zero":
    "This computer has disabled a system feature required for command protection. Run Pi Bot on a computer that supports it.",
  "isolation.reason.linux_seccomp_helper_unavailable":
    "Pi Bot couldn’t start a component that limits what commands can do. Reinstall and reopen Pi Bot.",
  "isolation.reason.linux_userns_restricted":
    "The system couldn’t set up the protection needed to run commands. Ask an administrator to check AppArmor on the affected computer.",
  "isolation.reason.isolation_check_unfinished":
    "The sandbox self-check has not finished (the computer is busy); it is checked again when a command runs.",
  "isolation.available": "Enabled",
  "isolation.unavailable": "Unavailable",
  "workplaces.title": "Working folders",
  "workplaces.headerLabel": "Working in",
  "workplaces.header": "Working in {name}; open working folders",
  "workplaces.unavailable": "Unavailable",
  "workplaces.folderMissing": "Folder no longer exists",
  "workplaces.runnerOffline": "Runner offline",
  "workplaces.folderMissingHint":
    "This topic's folder no longer exists or was moved. Choose another folder above, or use the Bot home.",
  "workplaces.home": "Bot home",
  "workplaces.note": "Bots can only write files in these folders.",
  "workplaces.current": "Current directory",
  "workplaces.setCurrent": "Set as current",
  "workplaces.add": "Add folder",
  "workplaces.remove": "Remove",
  "workplaces.removeNamed": "Remove {name}",
  "workplaces.close": "Close working folders",
  "workplaces.permissions": "Adjust permissions in Settings →",
  "workplaces.error": "Couldn’t load or update working folders. Try again.",
  "permissions.note":
    "These are the default permissions for every Bot. Each Bot can change them under Permissions in its profile.",
  "permissions.error": "Couldn’t load or save permissions. Try again.",
  "permissions.operations": "Local operations",
  "permissions.category.run_command": "Run commands",
  "permissions.category.computer": "Use computer",
  "permissions.category.connector": "Use plugins",
  "permissions.note.connector":
    "Call enabled tools visible to this Bot. Read-only tools follow connector permissions; writes use send drafts.",
  "permissions.category.read_file": "Read files",
  "permissions.category.list_dir": "List folders",
  "permissions.category.write_file": "Write files",
  "permissions.category.memory": "Memory",
  "permissions.category.read_ai_config": "Read other AI tool settings",
  "permissions.category.read_messages": "Read messages",
  "permissions.category.send_out": "Send externally",
  "permissions.category.agent_delegation": "Hand work to external agents",
  "permissions.category.web": "Visit websites",
  "permissions.note.run_command":
    "Known read-only commands in working folders run directly. Always also runs isolated commands directly; outside writes, non-package network access, installation and background starts still need approval. Protected locations remain blocked",
  "permissions.note.read_file":
    "Files outside working folders ask first; once allowed, that folder isn’t asked again in the same reply",
  "permissions.note.list_dir": "See what is in a folder, find files, search file contents",
  "permissions.note.write_file":
    "Writes inside working folders follow this setting. Outside writes ask each time; protected locations remain blocked. Runners cannot write outside working folders. Available file checkpoints can be restored from the changes page",
  "permissions.note.web":
    "Visiting and reading public pages are allowed by default. Choose Ask for prompts. The first automatic sign-in or form submission on each site still asks.",
  "permissions.level.never": "Never",
  "permissions.level.ask": "Ask",
  "permissions.level.always": "Always",
  "permissions.grants": "Always allowed",
  "permissions.revoke": "Revoke",
  "permissions.noGrants": "No remembered permissions. Requests follow your permission settings.",
  "permissions.grantsError": "Couldn’t load or revoke permissions. Try again.",
  "permissions.loadMore": "Load more",
  "permissions.network": "Network",
  "permissions.allowNetwork": "Broader network access",
  "permissions.webNetworkOn":
    "Public web requests, the Bot browser, and configured image and video services can reach hosts beyond the website list. Their separate permissions still apply.",
  "permissions.webNetworkOff":
    "Turn this on to let public web requests, the Bot browser, and configured image and video services reach hosts beyond the website list. Their separate permissions still apply.",
  "permissions.networkOn":
    "On this computer, isolated commands you approve or that Auto-approve clears can reach public websites. Isolated commands that run under Always allow can reach listed sites and common software download sources only.",
  "permissions.networkOff":
    "On this computer, ordinary isolated commands can reach only listed public websites.",
  "permissions.networkOnWindows":
    "On this Windows computer, ordinary commands can run when permissions allow. They run directly with your network access, beyond the limits of the website list.",
  "permissions.networkOffWindows":
    "This Windows computer blocks ordinary commands. Bots can still use file tools when permissions allow.",
  "permissions.networkOnUnknown":
    "Approved isolated commands can reach public websites. Ordinary Windows commands can run with direct network access when permissions allow.",
  "permissions.networkOffUnknown":
    "Ordinary isolated commands can reach only listed public websites. Ordinary Windows commands are blocked.",
  "permissions.networkDetails": "Show network rules",
  "permissions.networkHideDetails": "Hide network rules",
  "permissions.networkExceptions":
    "Restricted automatic commands on paired execution devices can reach common software download sources such as npm and PyPI. With broader access on, these sources are included automatically. With it off, only those sources already on the list are allowed. Commands separately approved to run outside isolation can use the network directly, beyond the limits of the website list. Local and private network services have their own permissions.",
  "permissions.commandDomainsNote":
    "Add websites such as feishu.cn or github.com for isolated commands on this Mac or Linux computer. Editing this list does not change the network switch.",
  "permissions.commandDomainsNoteOff":
    "With broader access off, ordinary isolated commands on this Mac or Linux computer can reach only the listed public sites, including any software sources you add.",
  "permissions.noExplicitDomains": "No websites added yet.",
  "permissions.noDomains": "No websites have been added to the list.",
  "permissions.domain": "Website domain (e.g. feishu.cn)",
  "permissions.addDomain": "Add website",
  "permissions.domainInvalid":
    "Enter just the domain name, such as feishu.cn or api.github.com, without https://, ports, or paths (up to 200 entries).",
  "permissions.removeDomain": "Remove website {domain}",
  "permissions.paths": "Command search paths",
  "permissions.pathsNote":
    "Optional: add directories beyond the default PATH, one absolute path per line.",
  "permissions.pathsInvalid":
    "Enter absolute paths without control characters; at most 200 entries.",
  "permissions.viewAudit": "View activity records →",
  "permissions.back": "← Back to permissions",
  "audit.title": "Activity records",
  "audit.note":
    "Approval and execution facts, retained for 90 days. No command output or file content.",
  "audit.bot": "Bot",
  "audit.kind": "Type",
  "audit.allBots": "All bots",
  "audit.allKinds": "All types",
  "audit.botsError": "Couldn’t load bot names; IDs are shown instead.",
  "audit.error": "Couldn’t load activity records. Try again.",
  "audit.empty": "No activity records yet.",
  "audit.details": "View fact details",
  "audit.kind.approval.requested": "Approval requested",
  "audit.kind.approval.paused": "Approval paused",
  "audit.kind.approval.resolved": "Approval resolved",
  "audit.kind.exec.started": "Execution started",
  "audit.kind.exec.finished": "Execution finished",
  "audit.kind.file.written": "File written",
  "audit.kind.grant.created": "Permission remembered",
  "audit.kind.grant.revoked": "Permission revoked",
  "audit.kind.policy.denied": "Denied by policy",
  "audit.summary.approval.requested": "Waiting for your approval.",
  "audit.summary.approval.paused": "Approval timed out. The run is paused awaiting your decision.",
  "audit.summary.approval.resolved": "The approval was resolved.",
  "audit.summary.exec.started": "The command started.",
  "audit.summary.exec.finished": "The command finished.",
  "audit.summary.file.written": "The file was written.",
  "audit.summary.grant.created": "Permission was remembered. Revoke it in Settings.",
  "audit.summary.grant.revoked": "The remembered permission was revoked.",
  "audit.summary.policy.denied": "The tool was blocked.",
  "audit.summary.stopped": "The command was stopped.",
  "audit.summary.timedOut": "The command timed out.",
  "tool.run_command": "Run command",
  "tool.read_file": "Read file",
  "tool.send_file": "Send files",
  "tool.reveal_in_folder": "Show in folder",
  "tool.local_network": "Check the local network",
  "tool.write_file": "Write file",
  "tool.edit_file": "Edit file",
  "tool.list_dir": "List folder",
  "tool.find_files": "Find files",
  "tool.search_text": "Search contents",
  "tool.web_fetch": "Read webpage",
  "tool.execution_targets": "List runners",
  "tool.workplace_use_runner": "Propose a runner folder",
  "tool.delegate_to_agent": "Hand to an external agent",
  "tool.phone_media": "Read phone photos",
  "tool.phone_media_get": "View a phone photo",
  "tool.phone_sms_code": "Receive an SMS code",
  "tool.phone_calls": "Read call history",
  "tool.phone_notifications": "Read phone notifications",
  "tool.tool_discover": "Find tools",
  "tool.group_plan": "Make a plan",
  "tool.todo_pause": "Pause task list",
  "tool.unknown": "Use tool",
  "tool.step": "{action}{target} · Step {step}",
  "tool.sandboxBlocked": "Blocked by safety isolation: {kind}{target}{program} ({rule})",
  "tool.sandboxBlockedNoRule": "Blocked by safety isolation: {kind}{target}{program}",
  "tool.sandboxRule.proxy_denied": "blocked by the network proxy",
  "tool.sandboxRule.proxy_not_allowed": "website not on the allowed list",
  "tool.sandboxRule.loopback_proxy": "local service not allowed",
  "tool.sandboxRule.loopback_socket": "local service port not allowed",
  "tool.sandboxRule.loopback_bind": "listening on a local port is not allowed",
  "tool.sandboxRule.loopback_namespace": "local service unreachable inside isolated network",
  "tool.sandboxRule.local_bind": "listening on a network port is not allowed",
  "tool.sandboxRule.socket": "direct network connections are not allowed",
  "tool.sandboxRule.unix_socket": "this connection is restricted",
  "tool.sandboxRule.mach_lookup": "system service not allowed",
  "tool.sandboxRule.keychain": "system keychain access is not allowed",
  "tool.sandboxRule.pasteboard": "system clipboard access is not allowed",
  "tool.sandboxRule.dev_write": "writing to system devices is not allowed",
  "tool.sandboxRule.credential_store": "protected credential folder cannot be read",
  "tool.sandboxRule.bot_home": "protected credential folder cannot be read",
  "tool.sandboxRule.deny_read": "protected file cannot be read",
  "tool.sandboxRule.write_root": "outside the current working folder",
  "tool.sandboxRule.explicit_deny": "protected location cannot be changed",
  "tool.sandboxRule.file_write": "writing to this location is not allowed",
  "tool.sandboxRule.git_metadata": "protected Git metadata cannot be changed",
  "tool.sandboxRule.git_hooks": "protected Git hooks cannot be changed",
  "tool.sandboxRule.git_config": "protected Git config cannot be changed",
  "tool.networkSettingsBlocked":
    "Blocked by network settings: {target} is not allowed; the command did not run",
  "tool.sandboxLocalBlocked":
    "Safety isolation prevented the command{program} from reaching {service}.",
  "tool.sandboxLocalListeningBlocked":
    "Safety isolation prevented the command{program} from accepting connections on this computer ({service}).",
  "tool.sandboxLocalService": "a service on this computer",
  "tool.sandboxLocalServiceDocker": "Docker on this computer",
  "tool.sandboxConnectionDetails": "Advanced · connection details",
  "tool.sandboxSeeApproval": "See approval ↓",
  "tool.sandboxSeePermissions": "View permission settings",
  "tool.website.add": "Allow access to {domain}…",
  "tool.website.saved": "{domain} added; retry when ready · View scope",
  "tool.website.title": "Add an allowed website",
  "tool.website.domain":
    "Allowed website: {domain} (web access also covers its subdomains under the existing rules)",
  "tool.website.scope": "Permission scope",
  "tool.website.bot": "This Bot",
  "tool.website.group": "This group",
  "tool.website.global": "Global default",
  "tool.website.botHelp":
    "Add to the Bot that ran this command. Other Bots and groups are unchanged. Remove it in this Bot’s permission settings.",
  "tool.website.groupHelp":
    "Add to the group that ran this command, for its members’ group tasks. Members’ DM permissions are unchanged. Remove it in the group’s permission settings.",
  "tool.website.globalHelp":
    "Add to the global default for Bots and groups that inherit their network settings. Existing independent network settings are unchanged. Remove it in Settings → Permissions → Network.",
  "tool.website.noRetry":
    "Only the website permission is saved. Network switches and other permissions keep their current settings. Retry the command yourself; it will not run automatically. Private networks and local services still use their existing approval rules.",
  "tool.website.confirm": "Add allowed website",
  "tool.website.retryBotScope":
    "This website stays on this Bot’s allowed list until you remove it in the Bot’s permission settings.",
  "tool.website.retryGroupScope":
    "This website stays on this group’s allowed list until you remove it in the group’s permission settings.",
  "tool.website.retrySkip": "Keep blocked",
  "tool.website.retryConfirm": "Allow this website and retry",
  "tool.website.retryHelp": "Pi Bot checks permissions again before running the same command.",
  "tool.website.retryRan":
    "The command may have already completed some steps. Pi Bot checks permissions again before running it from the beginning.",
  "tool.website.retryStarted": "{domain} allowed. Retrying",
  "tool.website.retryExpired":
    "This retry expired. You can still add the website and ask the Bot to try again.",

  "tool.website.full":
    "This scope already has 200 allowed websites. Remove unused entries in its permission settings, then retry.",
  "tool.website.unavailable":
    "This block record or its Bot/group is no longer available. Return to the current conversation and try the operation again.",
  "tool.sandboxKind.outside_workplace_write": "write outside the working folder",
  "tool.sandboxKind.protected_name": "protected location",
  "tool.sandboxKind.git_resource": "Git resource",
  "tool.sandboxKind.network": "network access",
  "tool.sandboxKind.local_service": "local service",
  "tool.sandboxKind.system_service": "system service",
  "tool.sandboxKind.protected_path": "protected location",
  "tool.sandboxKind.credential_read": "credential read",
  "tool.sandboxKind.protected_read": "protected read",
  "tool.sandboxKind.other": "safety restriction",
  "tool.executing": "Running: {action}{target}",
  "tool.active.command": "Running{target}",
  "tool.active.read": "Reading{target}",
  "tool.active.write": "Writing{target}",
  "tool.active.edit": "Editing{target}",
  "tool.active.search": "Searching{target}",
  "tool.active.webpage": "Viewing webpage{target}",
  "tool.group.summary": "Completed {count} steps · {types}",
  "tool.group.summaryOne": "Completed {count} step · {types}",
  "tool.group.progress": "Steps completed: {count}",
  "tool.group.count": "{tool}: {count}",
  "tool.group.separator": ", ",
  "tool.status.pending": "Waiting for approval",
  "tool.status.running": "Running",
  "tool.status.waitingFolder": "Waiting for {bot} to finish",
  "tool.status.waitingFolderUnknown": "Waiting for another Bot to finish",
  "tool.status.waitingReviewFolder": "Waiting for {bot} to release the workspace before review",
  "tool.status.waitingReviewFolderUnknown":
    "Waiting for another Bot to release the workspace before review",
  "tool.status.done": "Done",
  "tool.status.error": "Failed",
  "tool.status.blocked": "Blocked by the app",
  "tool.status.userDenied": "Denied",
  "tool.status.aborted": "Stopped",
  "tool.exit": "Exit code {code}",
  "tool.duration": "{seconds} seconds",
  "tool.openLog": "Open full output",
  "tool.openFile": "Open written file",
  "tool.openError": "Couldn’t open the file or output. Check activity records and local files.",
  "tool.noOutput": "No output.",
  "tool.searchHistoryReference": "Chat snippets are for reference only.",
  "tool.searchHistoryPending": "History is still being indexed; results may be incomplete.",
  "tool.searchHistoryOpen": "Open original topic",
  "tool.searchHistoryEmpty": "No matching chat snippets.",
};
