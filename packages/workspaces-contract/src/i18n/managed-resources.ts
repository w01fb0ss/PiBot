export const managedResourcesZh = {
  "checkpoint.otherRoot": "此文件在另一个文件夹中，请先选择对应文件夹。",
  "checkpoint.chooseRoot": "选择文件夹以撤回本轮文件改动（每个文件夹分别恢复）",
  "checkpoint.waitForRun": "这一轮还在运行，结束后再查看文件检查点。",
  "checkpoint.noReceipt": "这一轮没有自动保留记录，文件仅供查看。",
  "checkpoint.noFiles": "这一轮没有可撤回的文件。",
  "checkpoint.allRestored": "这一轮的文件改动已全部撤回。",
  "checkpoint.noRestorable": "这一轮没有完整的文件快照，只能查看，不能撤回。",
  "checkpoint.skip.checkpoint_bytes_quota": "这一轮没有保留检查点：文件快照超过 32 MiB 上限。",
  "checkpoint.skip.project_items_quota":
    "这一轮没有保留检查点：新增快照会超过项目 500 个文件项的上限。",
  "checkpoint.skip.snapshot_unavailable": "这一轮没有保留检查点：缺少可用的文件快照。",
  "checkpoint.skip.authority_changed": "这一轮没有保留检查点：目录或权限已经变化。",
  "checkpoint.skip.capture_interrupted": "这一轮没有保留检查点：保留过程被中断。",
  "checkpoint.skip.capture_failed": "这一轮没有保留检查点：保留未完成。",
  "checkpoint.restoreReason.file_changed": "Bot 改完后文件又变了，所以没有撤回。",
  "checkpoint.restoreReason.file_in_use": "文件正被别的程序打开，关掉后再试或另存。",
  "checkpoint.restoreReason.unsafe_path": "文件路径无法通过安全检查，所以没有撤回。",
  "checkpoint.restoreReason.recovery_interrupted": "撤回被中断，请先核查恢复记录。",
  "checkpoint.fileConflictUnknown": "这个文件没有撤回，请先核对当前文件。",
  "checkpoint.reselectConflict": "核对并解决冲突后，重新选择文件，再发起撤回。",
  "checkpoint.noRestores": "还没有撤回记录。",
  "checkpoint.retryRequest": "重试原撤回请求",
  "checkpoint.requestUnconfirmed": "撤回结果尚未确认。重试会沿用原请求，避免重复操作。",
  "checkpoint.itemReason.snapshot_missing": "没有完整快照，不能撤回。",
  "checkpoint.itemReason.command": "命令改的文件只能看，不能撤回。",
  "checkpoint.itemReason.unsafe_path": "文件路径无法通过安全检查，不能撤回。",
  "checkpoint.itemReason.quota": "文件快照超过保留上限，不能撤回。",
  "errors.managed_git_config_unsafe": "仓库包含不支持的 Git 过滤器或配置，无法安全完成此操作。",
  "errors.managed_git_layout_unsupported": "暂不支持这个 Git 仓库的结构。",
  "errors.managed_git_config_unavailable": "无法安全读取 Git 配置，请确认仓库可访问后重试。",
  "errors.managed_exclude_unsafe":
    "无法安全更新 Git 本地忽略规则；请检查 .git/info/exclude 是否为链接、被其他程序修改或超过大小限制。",
  "errors.worktree_creation_missing":
    "创建未完成，工作区目录不存在，无法恢复。请点击“新建”重新创建；原项目和已有分支会保留。",
  "errors.worktree_dirty":
    "独立工作区或主项目有未提交、未跟踪或忽略的文件。请先提交或处理这些文件，再整合。",
  "errors.worktree_diverged":
    "主项目已有这个独立工作区未包含的新提交，无法直接自动合并；请先同步或手动合并。",
  "errors.worktree_stale": "目录、提交或工作区版本已变化。请重新检查工作区后重试。",
  "errors.worktree_source_scope": "请从原主项目或已绑定的独立工作区发起整合。",
  "errors.worktree_bound": "工作区仍被话题或群使用，请先解除绑定并停止相关任务。",
  "errors.worktree_integrated_binding_pending":
    "代码已合入主项目，但主目录尚未切回。工作区已保留，请停止相关任务后重试合入。",
  "errors.worktree_integrated_cleanup_pending":
    "代码已合入并切回主项目，但工作区尚未清理。请处理占用、引用或未提交文件后重试清理。",
  "errors.worktree_unmerged_or_dirty":
    "工作区尚有未合入的提交或未提交／忽略文件，已保留，请先处理。",
  "errors.managed_plan_readonly": "当前是只规划模式，请先切换为执行。",
  "errors.managed_plan_step_merge": "这是计划步骤的工作区，通过检查后由 Pi Bot 自动合并。",
  "errors.managed_permission_never": "当前权限不允许此操作，请检查该 Bot 的文件和命令权限。",
  "errors.managed_invalid_operation": "此操作无效或当前不可用，请核对后重试。",
  "errors.managed_path_changed": "目录状态已变化，暂时无法继续。请核对后重试。",
  "errors.managed_platform_unsupported": "当前系统暂不支持此工作区操作。",
  "errors.managed_resource_busy": "工作区或相关资源正在使用中，请稍后重试。",
  "errors.managed_background_running":
    "这个文件夹里还有后台命令在运行（比如预览服务器）。先在聊天里停止它，再重试。",
  "errors.managed_files_changed": "文件内容或状态已变化，请核对当前文件后重试。",
  "errors.managed_git_unavailable": "Git 暂不可用，请确认已安装且应用可以访问。",
  "errors.managed_git_failed": "Git 操作未完成，请检查仓库状态后重试。",
  "errors.managed_path_unavailable": "所需目录暂不可用，请确认目录存在且可访问后重试。",
  "errors.checkpoint_hardlink_unsupported":
    "未能在当前磁盘上准备安全恢复，原文件未动。请检查磁盘剩余空间和文件夹的写入权限，再重试。",
  "errors.checkpoint_cross_device": "项目和恢复目录不在同一磁盘，无法安全撤回文件。",
  "errors.checkpoint_automatic_only": "这一轮的自动保留尚不可用。",
  "managed.resources": "工作区与文件检查点",
  "managed.title": "独立工作区",
  "managed.main": "主项目 · 仅查看",
  "managed.detached": "未在分支上",
  "managed.review": "独立审查此工作区",
  "managed.reviewAction": "审查",
  "managed.reviewStarted": "独立审查已启动，审查范围已固定到选中的工作区。",
  "managed.scmHint": "查看同项目各工作区的文件改动，不改变执行目录。",
  "managed.otherScope": "其他会话的工作区：可查看和审查，管理操作由所属会话处理。",
  "managed.external": "外部工作区：可查看和审查，不支持在此合入或删除。",
  "managed.locked": "工作区已锁定，请先解除占用。",
  "managed.unavailable": "工作区目录不可用，请先检查 Git 工作区状态。",
  "managed.moreFiles": "加载更多文件",
  "managed.readError": "无法读取文件改动，请重试。",
  "managed.tooManyFiles": "文件改动超出读取上限，请先缩小改动范围。",
  "managed.integrateHint":
    "将已提交的版本合入原主项目，然后清理工作区目录并保留分支；存在冲突或目录仍被使用时会保留工作区。",
  "managed.file.modified": "已修改",
  "managed.file.added": "已新增",
  "managed.file.deleted": "已删除",
  "managed.file.untracked": "未跟踪",
  "managed.file.typechange": "类型变更",
  "managed.file.conflicted": "存在冲突",

  "managed.empty": "还没有独立工作区。",
  "managed.create": "创建独立工作区",
  "managed.bind": "绑定此话题／群的主目录",
  "managed.view": "查看改动",
  "managed.changedFiles": "文件变动",
  "managed.noChanges": "没有未提交的改动",
  "managed.allChanges": "查看全部改动",
  "managed.commitIntegrate": "提交并合入主项目，清理工作区",
  "managed.commitIntegrateHint":
    "将安全提交此任务的当前文件改动，合入主项目后清理工作区目录。Git 分支保留；冲突时保留两个工作区。",
  "managed.integrate": "合入主项目并清理",
  "managed.createdUnbound": "工作区已创建，执行目录保持原设置。",
  "managed.destination": "整合目标 · 原主项目",
  "managed.current": "当前查看的工作区",
  "managed.commitFirst": "工作区有未提交或未处理的文件，请先提交或清理；整合只包含已提交的版本。",
  "managed.sourceDirty": "主项目有未提交或未处理的文件，请先处理。",
  "managed.returnToSource": "如需新建另一个独立工作区，请先将话题切回主项目。",
  "managed.remove": "清理独立工作区",
  "managed.confirm": "确认",
  "managed.cancel": "取消",
  "managed.refresh": "刷新",
  "managed.recover": "核查中断状态",
  "managed.more": "加载更多",
  "managed.hint":
    "自动建在项目的 .pibot/wt/ 下。可查看不同工作区的改动，执行目录保持原设置。使用 Git 本地忽略规则，不修改 .gitignore。仅带入已提交版本。",
  "managed.removeHint":
    "清理这个工作区的目录，保留 Git 分支。须已停止使用，且没有未提交、未跟踪或忽略文件；未合入的提交仍保存在分支中。",
  "managed.loading": "正在读取…",
  "managed.error": "操作未完成。请确认目录空闲、版本未变化且有相应权限，再重试。",
  "managed.state.creating": "创建中",
  "managed.state.ready": "可用",
  "managed.state.integrating": "整合中",
  "managed.state.removing": "清理中",
  "managed.state.removed": "已清理",
  "managed.state.interrupted": "已中断，需核查",
  "managed.state.conflict": "存在冲突",
  "checkpoint.title": "文件检查点",
  "checkpoint.empty": "还没有文件检查点。",
  "checkpoint.create": "保留本次文件检查点",
  "checkpoint.restore": "撤回所选文件",
  "checkpoint.confirmHint":
    "仅在当前文件仍匹配运行后内容时撤回。原文件保留在恢复目录；命令、Git 状态和外部操作不会撤销。",
  "checkpoint.coverage": "命令改动、旧记录或缺少快照的文件只能查看，不能撤回。",
  "checkpoint.select": "选择可撤回文件",
  "checkpoint.details": "查看文件",
  "checkpoint.partial": "部分文件可撤回",
  "checkpoint.available": "可撤回",
  "checkpoint.expired": "已过期",
  "checkpoint.done": "撤回完成",
  "checkpoint.conflict": "部分文件未撤回",
  "checkpoint.interrupted": "操作中断，核查恢复记录",
  "checkpoint.recover": "核查恢复记录",
  "checkpoint.resume": "继续未完成的撤回",
  "checkpoint.operations": "撤回记录",
  "checkpoint.recoveryPath": "原文件保留位置",
} as const;
export type ManagedResourceKey = keyof typeof managedResourcesZh;
export const managedResourcesEn: Record<ManagedResourceKey, string> = {
  "checkpoint.waitForRun": "This run is still active. Check its file checkpoint after it finishes.",
  "checkpoint.noReceipt": "This run has no automatic checkpoint record. Its files are view-only.",
  "checkpoint.noFiles": "There are no files to restore in this run.",
  "checkpoint.allRestored": "All file changes from this run have been restored.",
  "checkpoint.noRestorable":
    "This run has no complete file snapshots. Its files can be viewed but not restored.",
  "checkpoint.skip.checkpoint_bytes_quota":
    "No checkpoint was retained for this run: its file snapshots exceeded the 32 MiB limit.",
  "checkpoint.skip.project_items_quota":
    "No checkpoint was retained for this run: the new snapshots would exceed the project limit of 500 file items.",
  "checkpoint.skip.snapshot_unavailable":
    "No checkpoint was retained for this run: file snapshots were unavailable.",
  "checkpoint.skip.authority_changed":
    "No checkpoint was retained for this run: its directory or permissions changed.",
  "checkpoint.skip.capture_interrupted":
    "No checkpoint was retained for this run: capture was interrupted.",
  "checkpoint.skip.capture_failed":
    "No checkpoint was retained for this run: capture did not complete.",
  "checkpoint.restoreReason.file_changed":
    "The file changed after the Bot edited it, so it was not restored.",
  "checkpoint.restoreReason.file_in_use":
    "The file is open in another program. Close it and try again, or save a copy.",
  "checkpoint.restoreReason.unsafe_path":
    "The file path did not pass safety checks, so it was not restored.",
  "checkpoint.restoreReason.recovery_interrupted":
    "Restore was interrupted. Inspect the recovery journal first.",
  "checkpoint.fileConflictUnknown": "This file was not restored. Check the current file first.",
  "checkpoint.reselectConflict":
    "Check and resolve the conflicts, then select files again to start a new restore.",
  "checkpoint.noRestores": "No restore history yet.",
  "checkpoint.retryRequest": "Retry the original restore",
  "checkpoint.requestUnconfirmed":
    "The restore result is unconfirmed. Retrying reuses the original request to avoid duplicates.",
  "checkpoint.itemReason.snapshot_missing": "No complete snapshot is available for restore.",
  "checkpoint.itemReason.command": "Files changed by commands are view-only.",
  "checkpoint.itemReason.unsafe_path":
    "The file path did not pass safety checks and cannot be restored.",
  "checkpoint.itemReason.quota":
    "The file snapshot exceeded the retention limit and cannot be restored.",
  "errors.managed_git_config_unsafe":
    "The repository contains unsupported Git filters or configuration, so this operation cannot be completed safely.",
  "errors.managed_git_layout_unsupported": "This Git repository layout is not supported yet.",
  "errors.managed_git_config_unavailable":
    "Git configuration could not be read safely. Check that the repository is accessible, then retry.",
  "errors.managed_exclude_unsafe":
    "Cannot safely update Git local exclusions. Check .git/info/exclude for links, concurrent changes or an oversized file.",
  "errors.worktree_creation_missing":
    "Creation did not finish and the workspace directory is missing. Create a new workspace; the original project and existing branch are retained.",
  "errors.worktree_dirty":
    "The workspace or source project has changed, untracked or ignored files. Commit or handle them before integrating.",
  "errors.worktree_diverged":
    "The main project has newer commits that are not in this separate workspace, so it cannot be merged automatically. Sync or merge manually first.",
  "errors.worktree_stale":
    "The folder, commit or workspace revision changed. Check the workspace and retry.",
  "errors.worktree_source_scope":
    "Integrate from the original project or a workspace bound to this conversation.",
  "errors.worktree_bound": "The workspace is still in use. Unbind it and stop related tasks first.",
  "errors.worktree_integrated_binding_pending":
    "Code merged into the source, but switching back did not finish. The workspace is retained; stop related tasks and retry the merge action.",
  "errors.worktree_integrated_cleanup_pending":
    "Code merged and the source folder is active, but cleanup did not finish. Resolve active references or uncommitted files, then retry cleanup.",
  "errors.worktree_unmerged_or_dirty":
    "The workspace has unmerged commits or changed, untracked or ignored files. It has been retained.",
  "errors.managed_plan_readonly": "Plan-only mode is active. Switch to Execute first.",
  "errors.managed_plan_step_merge":
    "This is a plan step's workspace; Pi Bot merges it once it passes its checks.",
  "errors.managed_permission_never":
    "Current permissions deny this operation. Check this Bot's file and command permissions.",
  "errors.managed_invalid_operation":
    "This operation is invalid or currently unavailable. Check the operation and retry.",
  "errors.managed_path_changed": "The directory state has changed. Check it before retrying.",
  "errors.managed_platform_unsupported":
    "This workspace operation is not supported on this system yet.",
  "errors.managed_resource_busy":
    "The workspace or a related resource is in use. Please retry later.",
  "errors.managed_background_running":
    "A background command is still running in this folder (a preview server, for example). Stop it in the chat, then try again.",
  "errors.managed_files_changed":
    "File contents or state have changed. Check the current files before retrying.",
  "errors.managed_git_unavailable":
    "Git is unavailable. Check that it is installed and accessible to the app.",
  "errors.managed_git_failed":
    "The Git operation did not complete. Check the repository state and retry.",
  "errors.managed_path_unavailable":
    "A required directory is unavailable. Check that it exists and is accessible, then retry.",
  "errors.checkpoint_hardlink_unsupported":
    "Could not prepare a safe restore on this drive. The original file is still in place. Check available space and folder write access, then retry.",
  "errors.checkpoint_cross_device":
    "The project and recovery directory are on different disks, so files cannot be restored safely.",
  "errors.checkpoint_automatic_only":
    "Automatic file checkpointing is not yet available for this run.",
  "managed.resources": "Workspaces and file checkpoints",
  "managed.title": "Separate workspaces",
  "managed.main": "Main project · View only",
  "managed.detached": "No branch",
  "managed.review": "Independently review this workspace",
  "managed.reviewAction": "Review",
  "managed.reviewStarted":
    "Independent review started with its scope pinned to the selected workspace.",
  "managed.scmHint":
    "View file changes across this project's workspaces without changing the execution folder.",
  "managed.otherScope":
    "Another conversation's workspace: view and review here; manage it from its owning conversation.",
  "managed.external":
    "External workspace: view and review only; merging and deletion are unavailable here.",
  "managed.locked": "This workspace is locked. Release its active use first.",
  "managed.unavailable": "The workspace folder is unavailable. Check its Git worktree state first.",
  "managed.moreFiles": "Load more files",
  "managed.readError": "Could not read file changes. Please retry.",
  "managed.tooManyFiles": "File changes exceed the read limit. Reduce the change scope first.",
  "managed.integrateHint":
    "Merge committed revisions into the original project, then remove the workspace folder and retain its branch. Conflicts or active use preserve the workspace.",
  "managed.file.modified": "Modified",
  "managed.file.added": "Added",
  "managed.file.deleted": "Deleted",
  "managed.file.untracked": "Untracked",
  "managed.file.typechange": "Type changed",
  "managed.file.conflicted": "Conflicted",

  "managed.empty": "No separate workspaces yet.",
  "managed.create": "Create workspace",
  "managed.bind": "Bind this topic / group's primary folder",
  "managed.view": "View changes",
  "managed.changedFiles": "File changes",
  "managed.noChanges": "No uncommitted changes",
  "managed.allChanges": "View all changes",
  "managed.commitIntegrate": "Commit, merge into project and clean up",
  "managed.commitIntegrateHint":
    "Safely commit this task's current file changes, merge into the main project, then remove the workspace directory. The Git branch is retained; conflicts preserve both workspaces.",
  "managed.integrate": "Merge into source and clean up",
  "managed.createdUnbound": "Workspace created. The execution folder keeps its current setting.",
  "managed.destination": "Integration target · Original project",
  "managed.current": "Currently viewed workspace",
  "managed.commitFirst":
    "This workspace has uncommitted or unhandled files. Commit or clean them first; integration includes committed revisions only.",
  "managed.sourceDirty":
    "The source project has uncommitted or unhandled files. Handle them first.",
  "managed.returnToSource":
    "Switch the topic back to the source project to create another workspace.",
  "managed.remove": "Clean up workspace",
  "managed.confirm": "Confirm",
  "managed.cancel": "Cancel",
  "managed.refresh": "Refresh",
  "managed.recover": "Verify interrupted state",
  "managed.more": "Load more",
  "managed.hint":
    "Created under the project's .pibot/wt/. View changes in different workspaces without changing the execution folder. Uses Git local exclusions without changing .gitignore. Only committed files are included.",
  "managed.removeHint":
    "Remove this workspace directory and retain its Git branch. It must be unused with no changed, untracked or ignored files. Unmerged commits remain on the branch.",
  "managed.loading": "Loading…",
  "managed.error":
    "The operation could not finish. Check that folders are idle, revisions are current and permissions allow it, then retry.",
  "managed.state.creating": "Creating",
  "managed.state.ready": "Ready",
  "managed.state.integrating": "Integrating",
  "managed.state.removing": "Removing",
  "managed.state.removed": "Removed",
  "managed.state.interrupted": "Interrupted; verification required",
  "managed.state.conflict": "Conflict",
  "checkpoint.title": "File checkpoints",
  "checkpoint.empty": "No file checkpoints yet.",
  "checkpoint.create": "Keep this run's file checkpoint",
  "checkpoint.otherRoot": "This file is in another folder. Select that folder first.",
  "checkpoint.chooseRoot":
    "Choose a folder to revert this turn’s file changes (restore each folder separately)",
  "checkpoint.restore": "Revert selected files",
  "checkpoint.confirmHint":
    "Revert only when current files still match the run's final content. Originals remain in a recovery folder. Commands, Git state and external effects are not undone.",
  "checkpoint.coverage":
    "Command changes, older records and files without complete snapshots are view-only.",
  "checkpoint.select": "Select restorable files",
  "checkpoint.details": "View files",
  "checkpoint.partial": "Partly restorable",
  "checkpoint.available": "Restorable",
  "checkpoint.expired": "Expired",
  "checkpoint.done": "Reverted",
  "checkpoint.conflict": "Some files were not restored",
  "checkpoint.interrupted": "Interrupted; inspect recovery journal",
  "checkpoint.recover": "Inspect recovery journal",
  "checkpoint.resume": "Resume incomplete revert",
  "checkpoint.operations": "Revert history",
  "checkpoint.recoveryPath": "Original files retained at",
};
