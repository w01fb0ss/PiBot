// Auto-approve (YOLO): a switch on one conversation that stops asking for permission there.
export const yoloZh = {
  "yolo.menu": "更多",
  "yolo.menuItem": "自动批准模式",
  "yolo.menuOn": "已开启 · 点击关闭",
  "yolo.menuOff": "这个对话里不再逐个询问权限",
  "yolo.badge": "自动批准 · 不再询问",
  "yolo.badgeHint":
    "这个对话开着自动批准模式：可自动允许的操作不再询问；危险操作和硬拒绝仍然有效。",
  "yolo.turnOff": "关闭自动批准",
  "yolo.confirmTitle": "在这个对话里开启自动批准模式？",
  "yolo.confirmIntro":
    "这个对话里符合规则的操作会直接执行。每个对话单独设置，新建话题或会话时默认关闭。",
  "yolo.confirmGroup": "群聊里所有成员 Bot 在这个会话（包括任务线程）里遵循相同的自动批准规则。",
  "yolo.privacy":
    "符合规则的命令可以使用分配给该 Bot 的访问令牌，无需再次询问。操作电脑时，截图可能会发给所选的模型服务。",
  "yolo.skips": "会自动允许",
  "yolo.skipsList":
    "访问网站、提交网页表单、批准首次使用搜索服务\n操作电脑（含截图点击和前台操作）\n允许自动批准的对外发送（设为每次发送都确认的 Bot 仍会询问）\n使用唯一保存的账号登录网站，或用 Bot 指定且能唯一匹配的账号登录",
  "yolo.keeps": "仍会确认或拦下",
  "yolo.keepsList":
    "危险操作、以你的身份发送仍需逐次确认\n文件工具和受安全隔离的命令仍限制写入工作文件夹之外的位置，并保护只读参考文件夹\n网页工具和受安全隔离的命令仍限制访问未授权的本机或局域网地址\n付费生成视频仍需逐次确认。付费生成图片仍需确认，除非已允许这个模型免确认\n管理员提权操作、你设为「不允许」的权限和禁用的应用仍会被拦下",
  "yolo.savedDirectRuns":
    "符合已保存的直接运行授权的命令可能无需询问。这些命令可用电脑上用户的权限读写文件和联网，包括工作文件夹之外的位置。",
  "yolo.detailsSummary": "查看详细规则",
  "yolo.details":
    "本机 Docker 命令仍需逐次确认。网站有多个已保存账号时，Bot 必须明确指定其中一个，否则登录会被拦下。Pi Bot 仍会拦下提权命令（如 sudo），并在运行前检查能识别的受保护位置。受安全隔离的命令还受文件访问限制。操作电脑时仍会拦下 Pi Bot、钥匙串、密码管理器和终端。缺少系统权限或平台不支持时会直接提示。",
  "yolo.keepsSafety": "操作电脑时顶部提示、移动鼠标暂停和全局停止快捷键仍然有效。",
  "yolo.nothingRemembered":
    "自动批准模式不会保存新授权。关掉后会恢复正常询问规则。每个自动允许的操作都会写进操作记录。",
  "yolo.unisolated": "暂时没有可用的命令隔离保护。需要隔离才能运行的命令会被拦下。",
  "yolo.scopeUnavailable":
    "无法确认哪些命令可以自动批准。请确认运行此对话命令的电脑已连接，然后重试。",
  "yolo.scopeChanged": "可自动批准的操作范围已变化。请查看更新后的说明，再确认。",
  "yolo.filesOnly": "读写当前工作文件夹里的文件",
  "yolo.filesAndCommands":
    "读写当前工作文件夹里的文件，以及符合规则的命令（包括安装软件、在后台运行和联网）",
  "yolo.filesAndCommands.windows": "读写当前工作文件夹里的文件，以及已同意直接运行的普通命令",
  "yolo.pending": "开启时会重新检查等待中的审批，符合规则的会自动放行。",
  "yolo.keepsList.windows":
    "危险命令和无法安全分析的命令（仍逐次确认）\n使用 Pi Bot 文件工具写入工作文件夹以外的位置仍会确认或拦下，只读参考文件夹仍受保护\n网页工具访问未授权的本机或局域网地址仍受限制，以你的身份发送仍需确认\n付费生成视频仍需逐次确认。付费生成图片仍需确认，除非已允许这个模型免确认\n管理员提权命令、设为「不允许」的权限、不能操作的应用仍会拦下",
  "yolo.details.windows":
    "本机 Docker 命令仍需逐次确认。命令在启动前仍会检查能识别的受保护位置（例如 .git、Pi Bot 数据或凭据文件夹）。直接运行时，系统不会按 Pi Bot 的文件夹或联网范围限制命令。提权命令（如 runas）始终拒绝。网站有多个已保存账号时，Bot 必须明确指定其中一个，否则登录会被拦下。",
  "yolo.readOnly.windows":
    "权限允许时，查看文件列表、读取文件等支持的只读操作不需要开启自动批准模式。",
  "yolo.windowsDisclosureTitle": "Windows 无法隔离限制命令范围。",
  "yolo.windowsDisclosure":
    "同意后，符合规则的普通 Windows 命令可用该设备的用户权限直接运行，可以读写该用户能访问的文件并联网。危险命令仍会先问你。",
  "yolo.windowsAcknowledge":
    "我同意符合规则的普通 Windows 命令使用所在设备的用户权限直接运行。这项同意适用于所有已开启或以后开启自动批准模式的对话。我随时可以在「设置 › 权限」撤回。",
  "yolo.windowsReminder":
    "你已为所有开启自动批准模式的对话同意直接运行。符合规则的普通 Windows 命令可读写该设备上用户能访问的文件并联网。危险命令仍会先问你。",
  "yolo.windowsWithoutConsent":
    "Windows 无法隔离命令。权限允许时，支持的只读命令可以直接运行。自动批准普通 Windows 命令需要你另外同意。直接运行的命令可以用该设备上用户的权限读写文件和联网。",
  "yolo.windowsConsentUnknown":
    "无法确认这台 Windows 设备是否已同意自动直接运行。命令直接运行时，可以用该设备上用户的权限读写文件和联网。可在电脑的权限设置查看同意状态。",
  "yolo.windowsConsentSettings": "前往权限设置撤回",
  "yolo.nothingRemembered.windows":
    "关闭后，这个对话恢复正常询问。Windows 直接运行同意可在权限设置里单独撤回。每个自动允许的操作都会写进操作记录。",
  "yolo.audit.unisolatedOn": "开启了全局自动批准模式无隔离命令直接运行",
  "yolo.audit.unisolatedOff": "关闭了全局自动批准模式无隔离命令直接运行",
  "yolo.confirm": "开启自动批准模式",
  "yolo.failed": "没能切换自动批准模式，请重试。",
  "yolo.stepAllowed": "自动批准已放行",
  "yolo.stepAllowedDanger": "自动批准已放行 · 危险操作",
  "yolo.audit.on": "开启了这个对话的自动批准模式",
  "yolo.audit.off": "关闭了这个对话的自动批准模式",
  "yolo.audit.allowed": "自动批准已放行",
};
export const yoloEn = {
  "yolo.menu": "More",
  "yolo.menuItem": "Auto-approve mode",
  "yolo.menuOn": "On · click to turn off",
  "yolo.menuOff": "Stop asking for permission in this conversation",
  "yolo.badge": "Auto-approve · not asking",
  "yolo.badgeHint":
    "Auto-approve is on in this conversation. Eligible operations run without asking; mandatory confirmations and hard refusals still apply.",
  "yolo.turnOff": "Turn off Auto-approve",
  "yolo.confirmTitle": "Turn on Auto-approve mode in this conversation?",
  "yolo.confirmIntro":
    "Eligible operations run without asking in this conversation. Each conversation has its own switch. New topics and chats start with it off.",
  "yolo.confirmGroup":
    "In a group, every member Bot follows the same Auto-approve rules in this conversation, including its task threads.",
  "yolo.privacy":
    "Eligible commands can use access tokens assigned to the Bot without another prompt. When a Bot operates the computer, screenshots may be sent to the selected model provider.",
  "yolo.skips": "Allowed without asking",
  "yolo.skipsList":
    "Visiting websites, submitting forms, and approving first use of search\nOperating the computer (including screenshot clicks and foreground actions)\nEligible outgoing Bot messages (Bots set to confirm every send still ask)\nSigning in with the only saved account or when the Bot names an account that matches exactly one saved account",
  "yolo.keeps": "Still asks or blocks",
  "yolo.keepsList":
    "Dangerous actions and sending as you still ask each time\nFile tools and commands with safety isolation still restrict writes outside working folders and protect read-only reference folders\nWeb tools and commands with safety isolation still restrict access to unauthorized local network addresses\nPaid video generation asks each time. Paid image generation still asks unless you allowed this model without confirmation\nAdministrator elevation, permissions set to Never, and blocked apps stay blocked",
  "yolo.savedDirectRuns":
    "Commands that match a saved direct-run permission may run without asking. They can use the computer user’s access to read and write files, including outside the working folders, and use the network.",
  "yolo.detailsSummary": "View detailed rules",
  "yolo.details":
    "Local Docker commands still ask each time. If a site has several saved accounts, sign-in is blocked unless the Bot identifies one by name. Pi Bot still blocks elevation commands such as sudo and checks for known protected locations before launch. Commands with safety isolation also have limits on file access. Computer control still blocks Pi Bot, the keychain, password managers and terminals. The app reports missing system permissions and unsupported platforms.",
  "yolo.keepsSafety":
    "When operating the computer, the top indicator, pause on mouse movement, and the global stop shortcut stay active.",
  "yolo.nothingRemembered":
    "Auto-approve saves no new permissions. Turning it off restores the usual approval rules. Every automatically allowed action is logged.",
  "yolo.unisolated":
    "Command isolation is unavailable. Commands that require isolation are blocked.",
  "yolo.scopeUnavailable":
    "Could not check which commands can be auto-approved. Make sure the computer that runs this conversation’s commands is connected, then try again.",
  "yolo.scopeChanged":
    "What can be auto-approved has changed. Review the updated details and confirm again.",
  "yolo.filesOnly": "Reading and writing files in working folders",
  "yolo.filesAndCommands":
    "Reading and writing files in working folders, and eligible commands including software installs, background commands and commands that use the network",
  "yolo.filesAndCommands.windows":
    "Reading and writing files in working folders, and ordinary commands covered by direct-run consent",
  "yolo.pending": "Turning this on checks waiting approvals again and clears the eligible ones.",
  "yolo.keepsList.windows":
    "Dangerous commands and commands that cannot be safely analyzed still ask each time\nPi Bot file tools still ask or block writes outside working folders and protect read-only reference folders\nWeb tools still restrict unauthorized local addresses. Sending as you still asks\nPaid video generation asks each time. Paid image generation still asks unless you allowed this model without confirmation\nAdministrator elevation commands, permissions set to Never, and blocked apps stay blocked",
  "yolo.details.windows":
    "Local Docker commands still ask each time. Pi Bot checks commands for known protected locations such as .git, Pi Bot data and credential folders before launch. Directly running commands have the device user’s file and network access. Elevation commands such as runas are always refused. If a site has several saved accounts, sign-in is blocked unless the Bot identifies one by name.",
  "yolo.readOnly.windows":
    "Supported read-only actions (such as listing or reading files) work without turning on Auto-approve when permissions allow.",
  "yolo.windowsDisclosureTitle": "Windows cannot isolate commands.",
  "yolo.windowsDisclosure":
    "With your consent, eligible ordinary Windows commands can run directly with the user’s permissions on that device. They can read and write files that user can access and use the network. Dangerous commands still ask first.",
  "yolo.windowsAcknowledge":
    "I agree to let eligible ordinary Windows commands run directly with the user’s permissions on the device. This consent applies to all conversations where Auto-approve is on now or turned on later. I can withdraw it in Settings › Permissions.",
  "yolo.windowsReminder":
    "You’ve allowed direct runs for all conversations with Auto-approve on. Eligible ordinary Windows commands can read and write files the device user can access and use the network. Dangerous commands still ask first.",
  "yolo.windowsWithoutConsent":
    "Windows cannot isolate commands. Supported read-only commands can run directly when permissions allow. Auto-approving ordinary Windows commands requires separate consent. Commands that run directly have the device user’s file and network access.",
  "yolo.windowsConsentUnknown":
    "Could not confirm whether automatic direct runs are allowed on this Windows device. Directly running commands have the device user’s file and network access. Check consent in Permissions on the computer.",
  "yolo.windowsConsentSettings": "Withdraw in Permissions",
  "yolo.nothingRemembered.windows":
    "Turning this off restores normal prompts in this conversation. You can withdraw Windows direct-run consent separately in Permissions. Every automatically allowed action is logged.",
  "yolo.audit.unisolatedOn": "Turned on global Auto-approve for unisolated commands",
  "yolo.audit.unisolatedOff": "Turned off global Auto-approve for unisolated commands",
  "yolo.confirm": "Turn on Auto-approve",
  "yolo.failed": "Couldn't switch Auto-approve. Try again.",
  "yolo.stepAllowed": "Auto-approved",
  "yolo.stepAllowedDanger": "Auto-approved · dangerous",
  "yolo.audit.on": "Turned on Auto-approve for this conversation",
  "yolo.audit.off": "Turned off Auto-approve for this conversation",
  "yolo.audit.allowed": "Auto-approved",
};
