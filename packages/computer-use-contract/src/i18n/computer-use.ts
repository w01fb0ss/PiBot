// Operating the computer (grant card, steps, records, settings, profile, routine preauth).
export const computerUseZh = {
  "activity.kind.computer": "操作电脑",
  "computerUse.listSeparator": "、",
  "computerUse.error.notReady": "操作电脑的服务还没准备好，请稍后重试。",
  "computerUse.error.failed": "没能完成，请重试。",

  "computerUse.card.label": "操作电脑授权",
  "computerUse.card.subtitle": "只能操作勾选的应用。建议项是按这次任务给出的。",
  "computerUse.card.reason.first": "只能操作勾选的应用。建议项是按这次任务给出的。",
  "computerUse.card.reason.new_app": "要操作的应用不在这次授权里，需要你再确认一次。",
  "computerUse.card.reason.expired": "上次的授权已经过期，需要你再确认一次。",
  "computerUse.card.reason.coordinates": "这一步要按截图里的位置点击，需要你单独允许。",
  "computerUse.card.suggested": "建议",
  "computerUse.card.blocked": "在黑名单里，不能勾选",
  "computerUse.card.inAlways": "已在总是允许清单里",
  "computerUse.card.duration": "时限",
  "computerUse.duration.task": "这次任务 · 30 分钟",
  "computerUse.duration.today": "今天",
  "computerUse.card.foregroundAsk": "要占用前台时先问我",
  "computerUse.card.coordinates": "允许截图点击",
  "computerUse.card.coordinatesNote":
    "界面读不到的地方，按截图里的位置点击和拖动，会移动你的鼠标，只在你空闲时做。整屏截图也算截图点击。只对这次任务有效。",
  "computerUse.card.coordinatesRequested": "这次请求里包含截图点击。",
  "computerUse.card.alwaysNote":
    "「一直允许」：在勾选的应用里以后不再询问（截图点击除外），可在这个 Bot 资料面板的「权限」里撤销",
  "computerUse.card.noticeProvider": "截图会发给 {provider}（当前用的模型）",
  "computerUse.card.noticeLocal": "截图只交给这台电脑上的本机模型",
  "computerUse.card.noticeNoImages": "当前模型不接收截图，截图点击不可用",
  "computerUse.card.noticeScope": "清单外的应用不截图、不能操作",
  "computerUse.card.noticePassword": "密码框不能输入",
  "computerUse.card.noticeRecord": "每一步都记入「记录」",
  "computerUse.card.noneSelected": "至少勾选一个应用才能允许。",
  "computerUse.result.task": "这次任务 30 分钟内",
  "computerUse.result.today": "今天",
  "computerUse.result.denied": "你拒绝了 · 不会操作你的电脑",
  "computerUse.system.cardNote":
    "还缺系统授权。macOS 要你在系统设置里手动打开，打开后回到这里再允许。",

  "computerUse.permission.accessibility": "辅助功能",
  "computerUse.permission.screen": "屏幕录制",
  "computerUse.permission.automation": "自动化",
  "computerUse.permission.accessibilityNote": "按界面点按钮、填内容；截图点击时移动鼠标",
  "computerUse.permission.screenNote": "截图（只裁到你允许的应用窗口）",
  "computerUse.permission.automationNote":
    "让 Bot 用脚本控制「系统事件」和「访达」；点「去开启」后在系统弹窗里选「好」",
  "computerUse.permission.open": "去开启",
  "computerUse.permission.openError": "没能打开系统设置，请手动打开「隐私与安全性」。",
  "computerUse.permission.staleHint":
    "如果系统设置里已经打开但这里仍显示未开启（常见于更新或重装之后），请在系统设置的列表里先把 Pi Bot 移除，再重新添加。",
  "computerUse.permissionStatus.granted": "已开启",
  "computerUse.permissionStatus.denied": "未开启",
  "computerUse.permissionStatus.not_determined": "未开启",
  "computerUse.permissionStatus.unknown": "用到时询问",
  "computerUse.permissionStatus.not_required": "不需要",
  "computerUse.permissions.title": "系统授权",
  "computerUse.permissions.noteWin32": "Windows 不需要额外授权；以管理员身份运行的窗口不能操作。",
  "computerUse.permissions.noteLinux":
    "X11 不需要额外授权；Wayland 下截图每次会话要确认一次，按坐标点击受限。",
  "computerUse.permissions.none": "这台电脑不需要额外的系统授权。",
  "computerUse.unavailable.unsupported_platform": "这台电脑的系统暂不支持操作电脑。",
  "computerUse.unavailable.non_interactive_session": "当前会话没有桌面，不能操作电脑。",
  "computerUse.unavailable.wayland_limited":
    "Wayland 下只能有限地操作电脑：截图要确认，按坐标点击受限。",
  "computerUse.unavailable.driver_missing": "操作电脑的组件没有装好，请重新安装 Pi Bot。",
  "computerUse.unavailable.helper_unavailable": "读取应用列表所需的系统组件暂时无法启动。",
  "computerUse.unavailable.permission_missing": "请在系统设置中开启辅助功能和屏幕录制权限。",
  "computerUse.unavailable.permission_missing_desktop":
    "系统没有提供操作电脑需要的显示或输入权限。请确认这个会话有桌面、Pi Bot 可以截屏和模拟输入，然后重新打开 Pi Bot。",
  "computerUse.unavailable.runner": "这个执行端不支持操作电脑，或需要升级执行端。",

  "computerUse.tool.screenshot": "截图",
  "computerUse.tool.ui_tree": "读取界面",
  "computerUse.tool.ui_action": "按界面操作",
  "computerUse.tool.pointer": "截图点击",
  "computerUse.tool.keys": "按键输入",
  "computerUse.tool.open_app": "打开应用",
  "computerUse.tool.open_file": "用应用打开文件",
  "computerUse.tool.browser": "使用浏览器",
  "computerUse.method.ui": "按界面操作",
  "computerUse.method.browser": "Bot 浏览器",
  "computerUse.method.coordinates": "截图点击",
  "computerUse.method.keys": "按键输入",
  "computerUse.stage.background": "后台",
  "computerUse.stage.foreground": "前台",
  "computerUse.step.tag": "{app} · {stage} · {method}",
  "computerUse.step.click": "点击截图上的 ({x}, {y})",
  "computerUse.step.view": "查看「{step}」的截图",
  "computerUse.stepResult.done": "完成",
  "computerUse.stepResult.error": "出错",
  "computerUse.stepResult.denied": "被拒绝",
  "computerUse.stepResult.skipped": "跳过",
  "computerUse.steps.loadError": "操作步骤读取失败。",
  "computerUse.viewer.title": "步骤截图",
  "computerUse.viewer.click": "点击位置 ({x}, {y})，按截图换算到屏幕坐标",
  "computerUse.viewer.note":
    "截图只裁到授权的应用窗口，发给了当前模型的厂商，保存在这个 Bot 的文件夹里，过期自动删除。",

  "computerUse.state.working": "操作 {app} 中",
  "computerUse.state.workingNoApp": "操作电脑中",
  "computerUse.state.paused": "操作电脑已暂停",
  "computerUse.state.queued": "等前台",
  "computerUse.state.waiting": "等你确认前台操作",
  "computerUse.foreground.label": "前台操作确认",
  "computerUse.foreground.ask": "要在前台操作 {app}：{action}。会移动你的鼠标。",
  "computerUse.foreground.allow": "允许",
  "computerUse.foreground.skip": "跳过这步",
  "computerUse.foreground.asking": "等你确认在前台操作 {app}",
  "computerUse.foreground.queued": "等前台：另一个 Bot 正在用，排第 {position} 个",
  "computerUse.foreground.waiting_idle": "等你空闲后在前台操作 {app}",
  "computerUse.foreground.waiting_unlock": "屏幕锁着，解锁后才能在前台操作 {app}",
  "computerUse.chat.stopped": "已停止操作电脑 · 这次的操作授权已撤销 · 已记入「记录」",
  "computerUse.chat.pausedActivity": "你动了鼠标或键盘，前台操作已暂停 · 3 秒没动就继续",

  "computerUse.log.note": "每一步都在这里：做了什么、哪个应用、方式和截图。截图过期后只留文字。",
  "computerUse.log.empty": "还没有操作电脑的记录。",

  "computerUse.settings.inUse": "现在谁在用",
  "computerUse.settings.idle": "没有 Bot 在操作电脑",
  "computerUse.settings.botState": "{name}：{state}",
  "computerUse.settings.someBot": "一个 Bot",
  "computerUse.shortcut.title": "随时停止",
  "computerUse.shortcut.label": "全局快捷键",
  "computerUse.shortcut.note": "停止所有 Bot 正在做的电脑操作，并撤销这次授权",
  "computerUse.browserData.title": "Bot 的浏览器",
  "computerUse.browserData.note":
    "每个 Bot 一个独立的浏览器，和你的浏览器完全分开；代理用「通用」里的手动代理。",
  "computerUse.browserData.isolated": "独立配置，没有你的登录",
  "computerUse.browserData.clear": "清除浏览数据",

  "computerUse.blocklist.title": "不能操作的应用",
  "computerUse.blocklist.note": "这些应用不能截图、不能操作，也加不进任何 Bot 的「总是允许」清单。",
  "computerUse.blocklist.always": "一直不能",
  "computerUse.blocklist.remove": "移出 {name}",
  "computerUse.picker.search": "搜索应用",
  "computerUse.picker.noMatch": "没有匹配的应用",
  "computerUse.picker.more": "还有 {count} 个，搜索可以缩小范围",
  "computerUse.picker.truncated": "应用太多，只列出了一部分。",
  "computerUse.picker.unsupported": "读不到这台电脑上的应用：{reason}",
  "computerUse.picker.unsupportedGeneric": "暂时无法读取这台电脑上的应用列表。",
  "computerUse.picker.loading": "正在读取这台电脑上的应用…",
  "computerUse.picker.done": "完成",
  "computerUse.retention.title": "操作截图",
  "computerUse.retention.label": "保留多久",
  "computerUse.retention.note": "步骤里的截图存在各 Bot 自己的文件夹，过期自动删除",
  "computerUse.retention.days": "{count} 天",

  "computerUse.profile.follow": "跟随全局：{level}",
  "computerUse.profile.always": "总是允许",
  "computerUse.profile.never": "不允许",
  "computerUse.profile.listLabel": "在这些应用里不用再问：",
  "computerUse.profile.add": "添加应用",
  "computerUse.profile.remove": "移除 {name}",
  "computerUse.profile.info":
    "清单外的应用仍会弹授权卡；截图点击每次任务单独授权；「不能操作的应用」加不进来。",
  "computerUse.profile.empty": "清单是空的，等于没有设「总是允许」。",
  "computerUse.profile.inactive":
    "先添加允许的应用，再选择「总是允许」。当前清单暂不生效，清单外的应用仍需询问。",

  "computerUse.preauth.apps": "只能操作：{apps}",
  "computerUse.preauth.none": "不提前允许；用到时进「待办」。",
  "computerUse.preauth.never": "这个 Bot 不允许操作电脑。",
  "computerUse.preauth.pending":
    "这个版本还不能提前允许操作电脑；用到时会进「待办」，最多等 24 小时。",
  "computerUse.preauth.coordinatesTag": "截图点击 · 不能提前允许",
  "computerUse.preauth.coordinates": "例行任务里用到截图点击时进「待办」。",
} as const;

export const computerUseEn: { [K in keyof typeof computerUseZh]: string } = {
  "activity.kind.computer": "Computer",
  "computerUse.listSeparator": ", ",
  "computerUse.error.notReady": "Computer control isn't ready yet. Try again in a moment.",
  "computerUse.error.failed": "That didn't work. Try again.",

  "computerUse.card.label": "Computer access request",
  "computerUse.card.subtitle":
    "Only the checked apps can be used. Suggestions come from this task.",
  "computerUse.card.reason.first":
    "Only the checked apps can be used. Suggestions come from this task.",
  "computerUse.card.reason.new_app":
    "This app isn't covered by the current permission. Confirm again.",
  "computerUse.card.reason.expired": "The previous permission expired. Confirm again.",
  "computerUse.card.reason.coordinates":
    "This step clicks by screenshot position and needs your separate permission.",
  "computerUse.card.suggested": "Suggested",
  "computerUse.card.blocked": "Blocked, can't be checked",
  "computerUse.card.inAlways": "Already always allowed",
  "computerUse.card.duration": "Duration",
  "computerUse.duration.task": "This task · 30 minutes",
  "computerUse.duration.today": "Today",
  "computerUse.card.foregroundAsk": "Ask me before taking over the foreground",
  "computerUse.card.coordinates": "Allow screenshot clicks",
  "computerUse.card.coordinatesNote":
    "Where the interface can't be read, the Bot clicks and drags at positions in a screenshot. This moves your mouse and only happens while you're idle. Full-screen screenshots count as screenshot clicks. This task only.",
  "computerUse.card.coordinatesRequested": "This request includes screenshot clicks.",
  "computerUse.card.alwaysNote":
    "“Always allow”: don’t ask again in the checked apps (screenshot clicks excluded). You can revoke it on this Bot’s Permissions tab.",
  "computerUse.card.noticeProvider": "Screenshots are sent to {provider} (the current model)",
  "computerUse.card.noticeLocal": "Screenshots only go to the local model on this computer",
  "computerUse.card.noticeNoImages":
    "The current model does not accept screenshots; screenshot clicks are unavailable",
  "computerUse.card.noticeScope": "Apps not on the list are never captured or used",
  "computerUse.card.noticePassword": "Password fields can't be typed into",
  "computerUse.card.noticeRecord": "Every step is saved to Records",
  "computerUse.card.noneSelected": "Check at least one app to allow.",
  "computerUse.result.task": "This task, 30 minutes",
  "computerUse.result.today": "Today",
  "computerUse.result.denied": "You denied this · The Bot won't use your computer",
  "computerUse.system.cardNote":
    "A system permission is missing. macOS requires you to turn it on in System Settings, then come back here to allow.",

  "computerUse.permission.accessibility": "Accessibility",
  "computerUse.permission.screen": "Screen Recording",
  "computerUse.permission.automation": "Automation",
  "computerUse.permission.accessibilityNote":
    "Press buttons and fill in fields; moves the mouse for screenshot clicks",
  "computerUse.permission.screenNote": "Screenshots (cropped to the apps you allow)",
  "computerUse.permission.automationNote":
    "Lets Bots script System Events and Finder; after Turn on, choose OK in the system dialog",
  "computerUse.permission.open": "Turn on",
  "computerUse.permission.openError":
    "Couldn't open System Settings. Open Privacy & Security yourself.",
  "computerUse.permission.staleHint":
    "If it is already on in System Settings but still shows off here (common after an update or reinstall), remove Pi Bot from that list and add it again.",
  "computerUse.permissionStatus.granted": "On",
  "computerUse.permissionStatus.denied": "Off",
  "computerUse.permissionStatus.not_determined": "Off",
  "computerUse.permissionStatus.unknown": "Asked on first use",
  "computerUse.permissionStatus.not_required": "Not needed",
  "computerUse.permissions.title": "System permissions",
  "computerUse.permissions.noteWin32":
    "Windows needs no extra permission. Windows running as administrator can't be controlled.",
  "computerUse.permissions.noteLinux":
    "X11 needs no extra permission. On Wayland, screenshots are confirmed once per session and position clicks are limited.",
  "computerUse.permissions.none": "This computer needs no extra system permission.",
  "computerUse.unavailable.unsupported_platform":
    "Computer control isn't supported on this system yet.",
  "computerUse.unavailable.non_interactive_session":
    "This session has no desktop, so the computer can't be controlled.",
  "computerUse.unavailable.wayland_limited":
    "Limited on Wayland: screenshots need confirmation and position clicks are restricted.",
  "computerUse.unavailable.driver_missing":
    "The computer control component is missing. Reinstall Pi Bot.",
  "computerUse.unavailable.permission_missing":
    "Enable Accessibility and Screen Recording in system settings.",
  "computerUse.unavailable.permission_missing_desktop":
    "The system is not granting the display or input access computer control needs. Make sure this session has a desktop and that Pi Bot may take screenshots and simulate input, then reopen Pi Bot.",
  "computerUse.unavailable.runner":
    "This runner does not support computer control, or the runner needs to be upgraded.",

  "computerUse.tool.screenshot": "Screenshot",
  "computerUse.tool.ui_tree": "Read interface",
  "computerUse.tool.ui_action": "Use interface",
  "computerUse.tool.pointer": "Screenshot click",
  "computerUse.tool.keys": "Type keys",
  "computerUse.tool.open_app": "Open app",
  "computerUse.tool.open_file": "Open file in app",
  "computerUse.tool.browser": "Use browser",
  "computerUse.method.ui": "Interface",
  "computerUse.method.browser": "Bot browser",
  "computerUse.method.coordinates": "Screenshot click",
  "computerUse.method.keys": "Keys",
  "computerUse.stage.background": "Background",
  "computerUse.stage.foreground": "Foreground",
  "computerUse.step.tag": "{app} · {stage} · {method}",
  "computerUse.step.click": "Click at ({x}, {y}) in the screenshot",
  "computerUse.step.view": "View screenshot for “{step}”",
  "computerUse.stepResult.done": "Done",
  "computerUse.stepResult.error": "Error",
  "computerUse.stepResult.denied": "Refused",
  "computerUse.stepResult.skipped": "Skipped",
  "computerUse.steps.loadError": "Couldn't load the steps.",
  "computerUse.viewer.title": "Step screenshot",
  "computerUse.viewer.click": "Clicked at ({x}, {y}), mapped from the screenshot to the screen",
  "computerUse.viewer.note":
    "Cropped to the allowed app windows, sent to the current model's provider, and kept in this Bot's folder until it expires.",

  "computerUse.state.working": "Using {app}",
  "computerUse.state.workingNoApp": "Using the computer",
  "computerUse.state.paused": "Computer use paused",
  "computerUse.state.queued": "Waiting for foreground",
  "computerUse.state.waiting": "Waiting for you to confirm",
  "computerUse.foreground.label": "Foreground confirmation",
  "computerUse.foreground.ask":
    "Wants to work in {app} in the foreground: {action}. This moves your mouse.",
  "computerUse.foreground.allow": "Allow",
  "computerUse.foreground.skip": "Skip this step",
  "computerUse.foreground.asking": "Waiting for you to confirm foreground use of {app}",
  "computerUse.foreground.queued":
    "Waiting for the foreground: another Bot is using it (#{position} in line)",
  "computerUse.foreground.waiting_idle": "Will use {app} in the foreground once you're idle",
  "computerUse.foreground.waiting_unlock":
    "Screen is locked. {app} can be used in the foreground after you unlock",
  "computerUse.chat.stopped":
    "Computer use stopped · This permission was revoked · Saved to Records",
  "computerUse.chat.pausedActivity":
    "You moved the mouse or typed, so foreground work paused · Resumes after 3 idle seconds",

  "computerUse.log.note":
    "Every step: what was done, in which app, how, and its screenshot. Expired screenshots leave the text only.",
  "computerUse.log.empty": "No computer use recorded yet.",

  "computerUse.settings.inUse": "In use now",
  "computerUse.settings.idle": "No Bot is using the computer",
  "computerUse.settings.botState": "{name}: {state}",
  "computerUse.settings.someBot": "A Bot",
  "computerUse.shortcut.title": "Stop anytime",
  "computerUse.shortcut.label": "Global shortcut",
  "computerUse.shortcut.note":
    "Stops all computer work by every Bot and revokes the current permission",
  "computerUse.browserData.title": "Bot browsers",
  "computerUse.browserData.note":
    "Each Bot has its own browser, fully separate from yours. It uses the manual proxy from General.",
  "computerUse.browserData.isolated": "Separate profile, none of your sign-ins",
  "computerUse.browserData.clear": "Clear browsing data",

  "computerUse.blocklist.title": "Apps Bots can't use",
  "computerUse.blocklist.note":
    "These apps are never captured or controlled, and can't be added to any Bot's always-allowed list.",
  "computerUse.blocklist.always": "Always blocked",
  "computerUse.blocklist.remove": "Remove {name}",
  "computerUse.picker.search": "Search apps",
  "computerUse.picker.noMatch": "No matching apps",
  "computerUse.picker.more": "{count} more. Search to narrow the list",
  "computerUse.picker.truncated": "Too many apps; only some are listed.",
  "computerUse.picker.unsupported": "Can't list the apps on this computer: {reason}",
  "computerUse.picker.unsupportedGeneric": "Can't list the apps on this computer right now.",
  "computerUse.unavailable.helper_unavailable":
    "The system helper for listing apps couldn't start.",
  "computerUse.picker.loading": "Reading the apps on this computer…",
  "computerUse.picker.done": "Done",
  "computerUse.retention.title": "Step screenshots",
  "computerUse.retention.label": "Keep for",
  "computerUse.retention.note":
    "Stored in each Bot's own folder and deleted automatically when they expire",
  "computerUse.retention.days": "{count} days",

  "computerUse.profile.follow": "Global: {level}",
  "computerUse.profile.always": "Always allow",
  "computerUse.profile.never": "Don't allow",
  "computerUse.profile.listLabel": "Don't ask again in these apps:",
  "computerUse.profile.add": "Add app",
  "computerUse.profile.remove": "Remove {name}",
  "computerUse.profile.info":
    "Apps not on the list still show a permission card. Screenshot clicks are allowed per task. Blocked apps can't be added.",
  "computerUse.profile.empty": "The list is empty, so nothing is always allowed.",
  "computerUse.profile.inactive":
    'Add the apps you allow, then choose "Always". This list is currently inactive; other apps still require approval.',

  "computerUse.preauth.apps": "Only these apps: {apps}",
  "computerUse.preauth.none": "Not allowed in advance; requests go to Inbox when needed.",
  "computerUse.preauth.never": "This Bot isn't allowed to use the computer.",
  "computerUse.preauth.pending":
    "Computer use can't be allowed in advance in this version yet. Requests go to Inbox and wait up to 24 hours.",
  "computerUse.preauth.coordinatesTag": "Screenshot clicks · Can't be allowed in advance",
  "computerUse.preauth.coordinates":
    "If a routine needs screenshot clicks, the request goes to Inbox.",
};
