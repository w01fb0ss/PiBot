// The knowledge tab of the Connections page and its errors. Keys stay flat so the i18n
// table stays one lookup; the page adds only strings it actually renders.
export const knowledgeZh = {
  "knowledge.category": "知识库",
  "knowledge.empty":
    "Pi Bot 可以连接本地文档文件夹（PDF、Word、TXT、Markdown）、Obsidian 笔记库和 Notion，让 Bot 查你的资料并注明出处。",
  "knowledge.emptyTitle": "还没有知识库",
  "knowledge.added": "已添加",
  "knowledge.addTitle": "添加知识库",
  "knowledge.account": "账号",
  "knowledge.account.workspace": "工作区",
  "knowledge.account.name": "名字",
  "knowledge.account.email": "邮箱",
  "knowledge.account.loading": "正在读取账号信息…",
  "knowledge.account.unavailable": "未能读取账号信息",
  "knowledge.account.reason.no_bot": "在下方选一个 Bot 后，这里会自动显示 Notion 账号信息。",
  "knowledge.account.reason.signin": "登录 Notion 后会显示。",
  "knowledge.account.reason.tool_missing":
    "这个 Notion 连接不提供账号信息（团队工作区的连接可能没有），连接本身照常可用。",
  "knowledge.account.reason.denied": "权限设置不允许自动读取，连接本身照常可用。",
  "knowledge.account.reason.failed": "Notion 这次没有回应，稍后再试。",
  "knowledge.account.reason.unreadable": "Notion 的回答里没有找到账号信息。",
  "knowledge.empty.addObsidian": "添加 Obsidian 库",
  "knowledge.empty.addFolder": "添加本地文档文件夹",
  "knowledge.empty.addNotion": "连接 Notion",
  "knowledge.detected": "在这台电脑上找到的 Obsidian 库",
  "knowledge.detected.note": "从 Obsidian 自己的笔记库列表读出，只添加文件夹路径，不读笔记内容。",
  "knowledge.installed": "已安装",
  "knowledge.add": "添加",
  "knowledge.add.notion": "Notion",
  "knowledge.add.notionHint": "用 Notion 账号登录，默认只读，可在详情中按需开启修改",
  "knowledge.add.obsidian": "Obsidian 库",
  "knowledge.add.obsidianHint": "选一个库文件夹，默认只读，可在详情中按需开启修改",
  "knowledge.add.folder": "本地文档文件夹",
  "knowledge.add.folderHint":
    "支持读取 PDF、Word、TXT、Markdown；默认只读，可在详情中开启修改 Markdown 笔记",
  "knowledge.add.dialogTitle.obsidian": "添加 Obsidian 库",
  "knowledge.add.dialogTitle.folder": "添加本地文档文件夹",
  "knowledge.add.dialogTitle.notion": "连接 Notion",
  "knowledge.add.pickBots": "给哪些 Bot 用",
  "knowledge.add.pickBotsNote":
    "默认选中主 Bot。你可以调整新知识源的访问范围。如果文件夹已经添加，Pi Bot 会打开它的详情，供你查看和调整当前分配。",
  "knowledge.add.alreadyAdded": "这个文件夹已添加。下方显示当前可以使用它的 Bot 和群聊。",
  "knowledge.add.confirmFolder": "选择文件夹并添加",
  "knowledge.add.confirmDetected": "添加这个库",
  "knowledge.add.confirmNotion": "连接 Notion",
  "knowledge.picking": "请在窗口里选择所在的文件夹…",
  "knowledge.origin": "来源",
  "knowledge.reselectFolder": "重新选择文件夹",
  "knowledge.vaultChangedTitle": "文件夹位置或同步状态已变化",
  "knowledge.vaultChangedNote":
    "文件夹可能被移动、由云盘重新同步，或由旧版本添加。请重新选择文件夹并确认谁可以访问和编辑。",
  "knowledge.summary.scanning": "正在统计文件夹内的文档…",
  "knowledge.summary.allSupported": "已识别 {supported} 篇文档（支持 Markdown / TXT / PDF / Word）",
  "knowledge.summary.withUnsupported":
    "已识别 {supported} 篇文档；{unsupported} 个暂不支持的文件已跳过",
  "knowledge.summary.empty": "文件夹里目前没有文档（支持 Markdown、TXT、PDF、Word）",
  "knowledge.summary.truncated": "统计尚未完成，可能还有其他文件",
  "knowledge.summary.unexamined": "{count} 个文件尚未完成检查",
  "knowledge.summary.scannedPdf": "{count} 个扫描/纯图片 PDF（无可选文字）",
  "knowledge.summary.skippedLarge": "{count} 个文件过大已跳过",
  "knowledge.summary.skippedUnreadable": "{count} 个文件或子文件夹无法读取",
  "knowledge.summary.timeout": "文件夹响应较慢，暂时无法完成统计，请稍后重试。",
  "knowledge.summary.failed": "暂时无法完成文件夹文档统计",
  "knowledge.summary.denied": "读取权限阻止了文档统计。请检查已分配 Bot 的读取权限后重试。",
  "knowledge.advancedNote": "查看文件夹路径等技术信息",
  "knowledge.advancedPath": "文件夹路径",
  "knowledge.assignPromptTitle": "选一个 Bot 即可开始使用",
  "knowledge.assignPromptNote": "目前还没有 Bot 可以使用这个知识库，点选下方头像即可生效。",
  "knowledge.notionNote":
    "会打开浏览器让你登录 Notion。能读到哪些页面，由你在 Notion 里授权给 Pi Bot 的范围决定；查询这个知识源的，只有下面分到的 Bot。",
  "knowledge.notionConnect": "登录 Notion",
  "knowledge.notionConnectorMissing":
    "这个 Notion 知识库对应的连接已丢失，点下方按钮即可恢复，已分配的 Bot 不会丢失。",
  "knowledge.notionReconnect": "重新连接 Notion",
  "knowledge.notionReauthPages": "重新授权 Notion 页面",
  "knowledge.removed": "已断开「{name}」",
  "knowledge.kind.obsidian": "Obsidian 库",
  "knowledge.kind.folder": "本地文档文件夹",
  "knowledge.kind.notion": "Notion",
  "knowledge.origin.obsidian": "文件夹：{path}",
  "knowledge.origin.folder": "文件夹：{path}",
  "knowledge.origin.notion": "Notion 连接",
  "knowledge.lastUsed": "最近一次：{time}",
  "knowledge.neverUsed": "还没有使用过",
  "knowledge.remove": "断开",
  "knowledge.removeNote": "只删除这条记录，不会改动你的文件或 Notion 页面。",
  "knowledge.removeConfirm": "断开「{name}」？",
  "knowledge.readOnlyNote": "新添加的知识库默认只读，可在知识库详情的「读写权限」中按需开启修改。",
  "knowledge.permissions": "读写权限",
  "knowledge.writable": "Bot 可以修改这个知识库",
  "knowledge.writableNote": "Bot 通过知识库修改页面时，每次都会先展示改动内容请你确认。",
  "knowledge.writableNote.local":
    "仅支持修改 Markdown（.md）笔记，PDF、Word 和 TXT 保持只读；每次改动前都会展示改动内容请你确认。",
  "knowledge.writableConfirmTitle": "允许 Bot 修改这个 Notion 知识库？",
  "knowledge.writableConfirmNote":
    "允许的操作：{actions}。每次操作前，Pi Bot 都会展示改动并请你确认。",
  "knowledge.writableConfirmAction": "确认开启写入",
  "knowledge.notionWriteToolsMissing": "还有 Notion 操作需要你确认后才能使用。",
  "knowledge.notionWriteToolsEnable": "立即启用写入权限",
  "knowledge.notionWriteToolsUnavailable": "当前 Notion 连接不提供这些操作：{actions}。",
  "knowledge.notionAction.create": "新建页面",
  "knowledge.notionAction.update": "修改页面",
  "knowledge.notionAction.delete": "删除页面",
  "knowledge.notionReadUnavailable":
    "Notion 页面读取功能不可用。Pi Bot 需要先读取页面，才能展示改动。",
  "knowledge.notionEnableRead": "启用页面读取",
  "knowledge.notionAuthFailed": "Notion 登录未完成，请重试。",
  "knowledge.notionReauthFailed": "Notion 页面重新授权未完成，原来的登录仍可使用。",
  "knowledge.notionReadOnlyBlocked":
    "Notion 连接当前处于「仅读取」模式，权限策略会拦截所有修改。请先改为「写入前确认」。",
  "knowledge.notionSwitchToAskWrites": "改为写入前确认",
  "knowledge.repointSuccess": "已重新关联文件夹，现在可以重新打开或重试查询。",
  "knowledge.repointConflict": "这个文件夹已用于「{name}」。请重新选择文件夹。",
  "knowledge.repointConfirmTitle": "将所选文件夹用于「{name}」？",
  "knowledge.repointRecipients": "可访问所选文件夹：{recipients}",
  "knowledge.repointAllRecipients": "所有 Bot 和群聊（包括从归档恢复的 Bot 和群聊）",
  "knowledge.repointGroupRecipient": "{name}（群聊）",
  "knowledge.repointArchivedRecipient": "{name}（已归档，恢复后可访问）",
  "knowledge.repointUnknownRecipient.bot": "无法识别的 Bot",
  "knowledge.repointUnknownRecipient.group": "无法识别的群聊",
  "knowledge.repointUnknownAssignmentsKept": "确认后，无法识别的分配也会保留。",
  "knowledge.repointNoRecipients": "尚未分配 Bot 或群聊",
  "knowledge.repointWritable":
    "已分配的 Bot 也可修改此文件夹中的 Markdown 笔记。每次修改前都会请你确认。",
  "knowledge.repointReadOnly": "已分配的 Bot 可以读取此文件夹。",
  "knowledge.repointConfirmAction": "确认关联文件夹",
  "knowledge.openKnowledge": "打开知识库详情",
  "knowledge.notionWriteRecovery": "请在知识库详情中检查可用操作和页面访问权限。",
  "knowledge.error.repoint_stale": "文件夹或访问设置已变化，或确认已过期。请重新选择文件夹。",
  "knowledge.error.notion_write_consent_changed":
    "Notion 连接或可用操作已变化。请查看详情并重新确认。",
  "knowledge.error.picker_unavailable": "现在打不开选择文件夹的窗口，请打开 Pi Bot 窗口后再试。",
  "knowledge.error.busy": "正在处理上一个知识库，请稍候再试。",
  "knowledge.error.vault_not_detected":
    "这个库不在这台电脑的 Obsidian 列表里了，请重新查找或直接选文件夹。",
  "knowledge.error.vault_missing": "选择的文件夹不存在或读不了，请重新选择。",
  "knowledge.error.vault_not_directory": "选择的不是文件夹，请重新选择对应的文件夹。",
  "knowledge.error.vault_changed": "知识源文件夹已变化，请在详情里重新选择文件夹。",
  "knowledge.error.vault_invalid": "选择的位置不是有效的本地文件夹，请重新选择。",
  "knowledge.error.vault_unreadable": "没有权限读取这个文件夹，请检查系统的文件访问权限后重试。",
  "knowledge.error.source_missing": "这个知识源已经不存在，列表已刷新。",
  "knowledge.error.connector_missing": "这个知识源对应的连接已经不存在，请重新添加。",
  "knowledge.error.notion_search_tool_missing": "这个 Notion 连接没有可用的搜索工具。",
  "knowledge.error.notion_read_tool_missing": "这个 Notion 连接没有可用的读取工具。",
  "knowledge.error.notion_query_empty": "要搜的内容不能为空。",
  "knowledge.error.notion_ref_empty": "要读的页面不能为空。",
  "knowledge.error.notion_read_only":
    "Notion 连接当前处于「仅读取」模式，请先在「读写权限」中改为「写入前确认」。",
  "knowledge.error.notion_write_tools_missing":
    "当前 Notion 连接没有提供可用的编辑操作。请在知识库详情中查看连接状态。",
  "knowledge.openNote": "打开出处",
  "knowledge.openingNote": "正在打开…",
  "knowledge.revealed.obsidian_unavailable": "未检测到 Obsidian，已在系统文件夹中为你定位该文件。",
  "knowledge.revealed.duplicate_vault":
    "检测到多个同名 Obsidian 库，为避免打开错误，已在系统文件夹中为你定位该文件。",
  "knowledge.revealed.not_in_obsidian":
    "这个文件夹不在 Obsidian 的库列表中，已在系统文件夹中为你定位该文件。",
  "knowledge.revealed.document_file": "已在系统文件夹中为你定位该文档。",
  "knowledge.error.reference_invalid": "这条引用不在回复里，或不是可打开的知识库链接。",
  "knowledge.error.reference_ambiguous":
    "这条旧引用可能指向多个 Obsidian 库或文件。请让 Bot 重新引用需要的文件。",
  "knowledge.error.reference_missing": "找不到这条回复，可能已被删除。",
  "knowledge.error.reference_changed": "知识源或引用已变化，请刷新后重新点击。",
  "knowledge.error.reference_reselect":
    "这个知识源是旧版本添加的，请在「连接 › 知识库」详情里重新选择文件夹后再打开。",
  "knowledge.error.reference_unsupported": "这台电脑上暂时打不开这条引用。",
  "knowledge.error.reference_denied":
    "这个知识源被权限设置拒绝了，点击打开不能绕过「读取文件」的权限。",
  "knowledge.error.reference_unknown":
    "已经交给系统打开，但无法确认是否成功。请先查看对应窗口，不要重复点击。",
} as const;

export const knowledgeEn = {
  "knowledge.category": "Knowledge",
  "knowledge.empty":
    "Pi Bot can connect local document folders (PDF, Word, TXT, Markdown), Obsidian vaults, and Notion, so Bots can search your files and cite every source.",
  "knowledge.emptyTitle": "No knowledge sources yet",
  "knowledge.added": "Added",
  "knowledge.addTitle": "Add a knowledge source",
  "knowledge.account": "Account",
  "knowledge.account.workspace": "Workspace",
  "knowledge.account.name": "Name",
  "knowledge.account.email": "Email",
  "knowledge.account.loading": "Reading the account…",
  "knowledge.account.unavailable": "Couldn't read the account",
  "knowledge.account.reason.no_bot":
    "Pick a Bot below and your Notion account details will load automatically.",
  "knowledge.account.reason.signin": "Shown after you sign in to Notion.",
  "knowledge.account.reason.tool_missing":
    "This Notion connection doesn't share account details (team workspace connections may not); the connection still works.",
  "knowledge.account.reason.denied":
    "Your permission settings don't allow reading it automatically; the connection still works.",
  "knowledge.account.reason.failed": "Notion didn't answer this time. Try again later.",
  "knowledge.account.reason.unreadable": "No account details were found in Notion's answer.",
  "knowledge.empty.addObsidian": "Add an Obsidian vault",
  "knowledge.empty.addFolder": "Add a local document folder",
  "knowledge.empty.addNotion": "Connect Notion",
  "knowledge.detected": "Obsidian vaults found on this computer",
  "knowledge.detected.note":
    "Read from Obsidian's own vault list; only the folder path is added, never your notes.",
  "knowledge.installed": "Installed",
  "knowledge.add": "Add",
  "knowledge.add.notion": "Notion",
  "knowledge.add.notionHint":
    "Sign in with Notion; read-only by default, edits can be enabled in details",
  "knowledge.add.obsidian": "Obsidian vault",
  "knowledge.add.obsidianHint":
    "Pick a vault folder; read-only by default, edits can be enabled in details",
  "knowledge.add.folder": "Local document folder",
  "knowledge.add.folderHint":
    "Reads PDF, Word, TXT, and Markdown; read-only by default, Markdown edits can be enabled in details",
  "knowledge.add.dialogTitle.obsidian": "Add Obsidian vault",
  "knowledge.add.dialogTitle.folder": "Add local document folder",
  "knowledge.add.dialogTitle.notion": "Connect Notion",
  "knowledge.add.pickBots": "Who can use it",
  "knowledge.add.pickBotsNote":
    "Your main Bot is selected by default. Choose who can use a new source here. If the folder is already added, Pi Bot opens its details so you can review and edit its current access.",
  "knowledge.add.alreadyAdded":
    "This folder is already in Knowledge. The Bots and groups with access are shown below.",
  "knowledge.add.confirmFolder": "Choose folder & add",
  "knowledge.add.confirmDetected": "Add vault",
  "knowledge.add.confirmNotion": "Connect Notion",
  "knowledge.picking": "Choose the folder in the dialog…",
  "knowledge.origin": "Source",
  "knowledge.reselectFolder": "Choose folder again",
  "knowledge.vaultChangedTitle": "Folder moved or changed by sync",
  "knowledge.vaultChangedNote":
    "The folder may have moved, been restored by cloud sync, or been added in an older version. Choose it again and confirm who can access and edit it.",
  "knowledge.summary.scanning": "Scanning documents in folder…",
  "knowledge.summary.allSupported":
    "{supported} documents recognized (Markdown / TXT / PDF / Word)",
  "knowledge.summary.withUnsupported":
    "{supported} documents recognized; {unsupported} unsupported files skipped",
  "knowledge.summary.empty": "No documents in this folder yet (supports Markdown, TXT, PDF, Word)",
  "knowledge.summary.truncated": "The scan is incomplete. There may be more files.",
  "knowledge.summary.unexamined": "{count} files still to be checked",
  "knowledge.summary.scannedPdf": "{count} image-only PDF(s) with no searchable text",
  "knowledge.summary.skippedLarge": "{count} oversized file(s) skipped",
  "knowledge.summary.skippedUnreadable": "{count} unreadable file(s) or folder(s) skipped",
  "knowledge.summary.timeout": "This folder is responding slowly; try scanning again in a moment.",
  "knowledge.summary.failed": "Couldn't scan documents in this folder",
  "knowledge.summary.denied":
    "Read permissions blocked the scan. Check the assigned Bot’s read permissions and try again.",
  "knowledge.advancedNote": "View technical details such as the folder path",
  "knowledge.advancedPath": "Folder path",
  "knowledge.assignPromptTitle": "Pick a Bot to get started",
  "knowledge.assignPromptNote":
    "No Bot can access this library yet. Click a Bot below to grant access.",
  "knowledge.notionNote":
    "Opens your browser to sign in to Notion. Which pages can be read follows what you grant Pi Bot in Notion; only the Bots assigned below can query this source.",
  "knowledge.notionConnect": "Sign in to Notion",
  "knowledge.notionConnectorMissing":
    "The Notion connection behind this library is missing. Reconnect below to restore it without losing your Bot assignments.",
  "knowledge.notionReconnect": "Reconnect Notion",
  "knowledge.notionReauthPages": "Re-authorize Notion pages",
  "knowledge.removed": "Disconnected “{name}”",
  "knowledge.kind.obsidian": "Obsidian vault",
  "knowledge.kind.folder": "Local document folder",
  "knowledge.kind.notion": "Notion",
  "knowledge.origin.obsidian": "Folder: {path}",
  "knowledge.origin.folder": "Folder: {path}",
  "knowledge.origin.notion": "Notion connection",
  "knowledge.lastUsed": "Last used: {time}",
  "knowledge.neverUsed": "Not used yet",
  "knowledge.remove": "Disconnect",
  "knowledge.removeNote":
    "This removes the record only; your files and Notion pages are left untouched.",
  "knowledge.removeConfirm": "Disconnect “{name}”?",
  "knowledge.readOnlyNote":
    "New libraries are read-only by default. You can enable edits under Read & write permissions in details.",
  "knowledge.permissions": "Read & write permissions",
  "knowledge.writable": "Bots can edit this library",
  "knowledge.writableNote":
    "For edits made through Knowledge, Pi Bot shows the changes and asks you to confirm each time.",
  "knowledge.writableNote.local":
    "Applies to Markdown (.md) notes only (PDF, Word, and TXT stay read-only). Before any change is saved, Pi Bot will show you what will change and ask you to confirm.",
  "knowledge.writableConfirmTitle": "Allow Bots to edit this Notion library?",
  "knowledge.writableConfirmNote":
    "Bots can {actions}. Pi Bot shows the changes and asks you to confirm each action.",
  "knowledge.writableConfirmAction": "Enable editing",
  "knowledge.notionWriteToolsMissing": "Some Notion actions still need your confirmation.",
  "knowledge.notionWriteToolsEnable": "Enable write permissions now",
  "knowledge.notionWriteToolsUnavailable":
    "This Notion connection does not offer these actions: {actions}.",
  "knowledge.notionAction.create": "create pages",
  "knowledge.notionAction.update": "update pages",
  "knowledge.notionAction.delete": "delete pages",
  "knowledge.notionReadUnavailable":
    "Page reading is unavailable. Pi Bot needs to read the Notion page before it can show the changes.",
  "knowledge.notionEnableRead": "Enable page reading",
  "knowledge.notionAuthFailed": "Notion sign-in was not completed. Try again.",
  "knowledge.notionReauthFailed":
    "Notion page authorization was not completed. Your existing sign-in still works.",
  "knowledge.notionReadOnlyBlocked":
    "This Notion connection is set to Read-only mode, so policy blocks all edits. Switch it to Ask before writes first.",
  "knowledge.notionSwitchToAskWrites": "Switch to ask before writes",
  "knowledge.repointSuccess": "Folder reconnected. You can open it or try again now.",
  "knowledge.repointConflict": "This folder is already used by “{name}”. Choose another folder.",
  "knowledge.repointConfirmTitle": "Use this folder for “{name}”?",
  "knowledge.repointRecipients": "Access to the selected folder: {recipients}",
  "knowledge.repointAllRecipients": "all Bots and groups, including those restored from archive",
  "knowledge.repointGroupRecipient": "{name} (group)",
  "knowledge.repointArchivedRecipient": "{name} (archived, access resumes when restored)",
  "knowledge.repointUnknownRecipient.bot": "unrecognized Bot",
  "knowledge.repointUnknownRecipient.group": "unrecognized group",
  "knowledge.repointUnknownAssignmentsKept":
    "Confirming will also keep the unrecognized assignments.",
  "knowledge.repointNoRecipients": "no Bots or groups assigned",
  "knowledge.repointWritable":
    "Assigned Bots can also edit Markdown notes in this folder. Pi Bot will ask you to confirm each edit.",
  "knowledge.repointReadOnly": "Assigned Bots can read this folder.",
  "knowledge.repointConfirmAction": "Confirm folder",
  "knowledge.openKnowledge": "Open library details",
  "knowledge.notionWriteRecovery":
    "Check available actions and page access in the library details.",
  "knowledge.error.repoint_stale":
    "The folder or access settings changed, or the confirmation expired. Choose the folder again.",
  "knowledge.error.notion_write_consent_changed":
    "The Notion connection or its available actions changed. Review the details and confirm again.",
  "knowledge.error.picker_unavailable":
    "The folder dialog is not available right now. Open the Pi Bot window and try again.",
  "knowledge.error.busy": "Another knowledge source is still being handled; try again in a moment.",
  "knowledge.error.vault_not_detected":
    "That vault is not in this computer's Obsidian list any more. Search again or pick the folder instead.",
  "knowledge.error.vault_missing": "That folder is gone or unreadable. Choose it again.",
  "knowledge.error.vault_not_directory":
    "That is not a folder. Choose the folder that holds your documents.",
  "knowledge.error.vault_changed":
    "The knowledge source folder changed. Choose it again in library details.",
  "knowledge.error.vault_invalid": "That location is not a valid local folder. Choose it again.",
  "knowledge.error.vault_unreadable":
    "Pi Bot does not have permission to read that folder. Check the system file access settings and try again.",
  "knowledge.error.source_missing":
    "That knowledge source no longer exists; the list was refreshed.",
  "knowledge.error.connector_missing":
    "The connection behind this knowledge source is gone. Add it again.",
  "knowledge.error.notion_search_tool_missing": "This Notion connection has no usable search tool.",
  "knowledge.error.notion_read_tool_missing": "This Notion connection has no usable read tool.",
  "knowledge.error.notion_query_empty": "Enter something to search for.",
  "knowledge.error.notion_ref_empty": "Choose a page to read.",
  "knowledge.error.notion_read_only":
    "This Notion connection is in Read-only mode. Switch it to Ask before writes under Read & write permissions first.",
  "knowledge.error.notion_write_tools_missing":
    "The current Notion connection offers no editing actions. Check the connection status in the library details.",
  "knowledge.openNote": "Open source",
  "knowledge.openingNote": "Opening…",
  "knowledge.revealed.obsidian_unavailable":
    "Obsidian wasn't found here; revealed the file in your system file manager instead.",
  "knowledge.revealed.duplicate_vault":
    "Multiple Obsidian vaults share this name; revealed the exact file in your file manager instead.",
  "knowledge.revealed.not_in_obsidian":
    "This folder isn't in Obsidian's vault list; revealed the file in your file manager instead.",
  "knowledge.revealed.document_file": "Revealed the document in your system file manager.",
  "knowledge.error.reference_invalid":
    "This reference is not in the reply, or is not an openable knowledge link.",
  "knowledge.error.reference_ambiguous":
    "This older reference could point to more than one Obsidian vault or file. Ask your Bot to cite the file again.",
  "knowledge.error.reference_missing": "That reply cannot be found; it may have been deleted.",
  "knowledge.error.reference_changed":
    "The knowledge source or the reference changed. Refresh and click again.",
  "knowledge.error.reference_reselect":
    "This knowledge source was added by an older version. Choose its folder again in Connections → Knowledge, then open it.",
  "knowledge.error.reference_unsupported":
    "This reference cannot be opened on this computer right now.",
  "knowledge.error.reference_denied":
    "Your file permissions deny this knowledge source, and clicking cannot override a read denial.",
  "knowledge.error.reference_unknown":
    "It was handed to the system to open, but whether it opened cannot be confirmed. Check before clicking again.",
} as const;
