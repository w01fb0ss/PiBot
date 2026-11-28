import {
  EditNotUniqueError,
  type ExecError,
  PatchFormatError,
  PatchRecoveryError,
} from "@pibot/execution";
import type { SemanticFailure } from "@pibot/execution/semantic";
import { EXECUTION_PAUSED } from "./execution-paused.ts";
import { patchFormatMessage } from "./patch-format-message.ts";

// Brain's tool response is bilingual; the renderer looks up the same fixed code in i18n.
const executionChecks: Partial<Record<ExecError["check"], string>> = {
  path_canonicalization_failed:
    "执行端无法安全解析路径 / The execution target could not safely resolve the path",
  write_path_alias:
    "写入路径指向别名，未通过写入检查 / The write path is an alias and did not pass the write check",
  write_path_protected: "写入目标在受保护范围内 / The write target is in a protected location",
  write_path_hardlink: "写入目标还有其他硬链接 / The write target has other hard links",
  write_path_outside_root:
    "写入目标不在获准的可写根内 / The write target is outside the approved writable roots",
  workspace_root_alias: "工作位置的根路径指向别名 / The workplace root path is an alias",
  workspace_identity_missing:
    "执行端没有可核验的工作位置标识 / The execution target has no workplace identity to verify",
  workspace_identity_changed:
    "工作位置已改变或不是可核验的目录 / The workplace changed or is not a verifiable directory",
  execution_command_failed:
    "授权所需的执行检查失败；没有确认具体失败项 / An execution check needed for authorization failed; the exact cause was not confirmed",
  execution_outside_workplace:
    "执行端的工作位置或路径边界检查未通过 / The execution target rejected the workspace or path boundary",
  execution_file_sensitive:
    "执行端拒绝访问受保护的文件 / The execution target refused access to a protected file",
  execution_file_access_denied:
    "执行端文件权限检查未通过 / The execution target refused filesystem access",
  execution_file_not_found:
    "执行端找不到检查所需的文件或目录 / The execution target could not find the file or directory needed for the check",
  execution_isolation_unavailable:
    "执行端无法确认所需的命令隔离 / The execution target could not confirm the required command isolation",
  windows_proxy_credentials:
    "Windows 上命令不隔离，带用户名和密码的代理不能交给命令使用；在 设置 › 网络 改用不需要登录的代理（如本机代理软件的端口）或关闭代理后再试 / Windows runs commands unisolated, so a proxy with a username and password cannot be passed to them; in Settings › Network use a proxy without sign-in (such as a local proxy app's port) or turn the proxy off, then retry",
  execution_isolation_scan_limit:
    "执行端只读保护扫描达到上限 / The execution target reached the read-only protection scan limit",
  execution_authorization_changed:
    "执行端授权或路径状态已变化 / The execution target authorization or path state changed",
  execution_timeout: "执行端检查超时 / The execution target check timed out",
  process_snapshot_timeout: "读取进程快照超时 / Reading the process snapshot timed out",
  process_snapshot_failed: "读取进程快照失败 / Reading the process snapshot failed",
  process_snapshot_limit: "进程快照超出扫描上限 / The process snapshot exceeded its scan limit",
  profile_data_root:
    "命令隔离配置拒绝了应用数据根检查 / The command isolation profile rejected the application data root check",
  profile_bot_home:
    "命令隔离配置拒绝了 Bot 主目录检查 / The command isolation profile rejected the Bot home check",
  profile_bot_skills:
    "命令隔离配置拒绝了 Bot 技能目录检查 / The command isolation profile rejected the Bot skills directory check",
  profile_bot_attachments:
    "命令隔离配置拒绝了 Bot 附件目录检查 / The command isolation profile rejected the Bot attachments directory check",
  profile_group_skills:
    "命令隔离配置拒绝了群技能目录检查 / The command isolation profile rejected the group skills directory check",
  profile_group_home:
    "命令隔离配置拒绝了群主目录检查 / The command isolation profile rejected the group home check",
  profile_skill_package:
    "命令隔离配置拒绝了技能包目录检查 / The command isolation profile rejected the skill package directory check",
  profile_skill_env:
    "命令隔离配置拒绝了技能环境目录检查 / The command isolation profile rejected the skill environment directory check",
  profile_python_env:
    "命令隔离配置拒绝了 Python 环境目录检查 / The command isolation profile rejected the Python environment directory check",
  profile_managed_python:
    "命令隔离配置拒绝了托管 Python 目录检查 / The command isolation profile rejected the managed Python directory check",
  profile_uv_cache:
    "命令隔离配置拒绝了 uv 缓存目录检查 / The command isolation profile rejected the uv cache directory check",
  profile_uv_binary:
    "命令隔离配置拒绝了 uv 程序路径检查 / The command isolation profile rejected the uv executable path check",
  profile_write_root:
    "命令隔离配置拒绝了可写根检查 / The command isolation profile rejected the writable root check",
  profile_temp_root:
    "命令隔离配置拒绝了临时根检查 / The command isolation profile rejected the temporary root check",
  profile_read_root:
    "命令隔离配置拒绝了只读根检查 / The command isolation profile rejected the read-only root check",
  profile_temp_namespace:
    "命令隔离配置拒绝了临时隔离目录检查 / The command isolation profile rejected the private temporary directory check",
};

export function authorizationCheckText(error: ExecError): string {
  if (error.code === "command_failed" && error.reason === "cleanup_failed") return EXECUTION_PAUSED;
  return (
    executionChecks[error.check] ??
    "授权所需的执行端检查未完成；本次调用未获授权 / The execution check required for authorization did not complete; this call was not authorized"
  );
}

/** A code_navigate failure now names its cause, so each one gets the next step. */
export function semanticErrorText(code: SemanticFailure, language: "zh" | "en"): string {
  const zh: Record<SemanticFailure, string> = {
    timeout: "代码导航在 15 秒内没有完成，没有结果；请缩小范围（指定 path 或更小的项目）后重试",
    cancelled: "代码导航已停止，没有结果",
    busy: "另一个代码导航查询正在运行，请稍后重试",
    worker_exit: "代码导航进程意外退出（可能内存不足或项目过大），没有结果；请缩小范围后重试",
    worker_error: "代码导航引擎报错，没有结果；可改用 read_file / search_text，或缩小范围后重试",
    too_large: "代码导航快照或编译器库超过大小上限，没有结果；请指定 path 缩小范围",
    invalid_input: "查询的文件或位置不在当前快照里；请先读取文件，或检查 path / line / column",
    unavailable:
      "代码导航当前不可用（工作位置不可读或引擎库校验失败）；请改用 read_file / search_text",
    unsupported_language:
      "code_navigate 只支持 TypeScript / JavaScript 文件；其他文件请用 read_file 或 search_text",
    file_too_large:
      "这个文件超过 1 MiB，代码地图不读取；请用 read_file 分段读取，或改用 search_text",
    not_utf8: "这个文件不是 UTF-8 文本（或含二进制内容），无法解析符号；请用 read_file 查看",
    file_unreadable:
      "读不到这个文件（权限不足、是符号链接 / 硬链接，或读取时被改动）；请检查工作位置与文件权限",
    file_changed: "文件在解析期间被修改，请重试",
    not_parsed: "这个文件没能解析出符号（语法包不可用或解析出错）；请用 read_file / search_text",
  };
  const en: Record<SemanticFailure, string> = {
    timeout:
      "Code navigation did not finish within 15 seconds; retry with a narrower path or a smaller project",
    cancelled: "Code navigation stopped without a result",
    busy: "Another code navigation query is running; retry shortly",
    worker_exit:
      "The code navigation worker exited unexpectedly (out of memory or a project too large); narrow the scope and retry",
    worker_error:
      "The code navigation engine failed; use read_file / search_text, or narrow the scope and retry",
    too_large:
      "The navigation snapshot or compiler library exceeded its size limit; pass path to narrow it",
    invalid_input:
      "The file or position is not in the snapshot; read the file first, or check path / line / column",
    unavailable:
      "Code navigation is unavailable (unreadable workplace or library verification failed); use read_file / search_text",
    unsupported_language:
      "code_navigate supports TypeScript and JavaScript files only; use read_file or search_text for other files",
    file_too_large:
      "This file is over 1 MiB, so the code map does not read it; read it in parts with read_file or use search_text",
    not_utf8:
      "This file is not UTF-8 text (or contains binary data), so its symbols cannot be parsed; use read_file",
    file_unreadable:
      "This file cannot be read (no permission, a symlink / hard link, or it changed while being read); check the workplace and file permissions",
    file_changed: "The file changed during parsing; please retry",
    not_parsed:
      "No symbols could be parsed from this file (the grammar is unavailable or the parse failed); use read_file / search_text",
  };
  return language === "zh" ? zh[code] : en[code];
}

export function readableError(error: ExecError, tool: string, platform?: NodeJS.Platform): string {
  if (error.code === "command_failed" && error.reason === "cleanup_failed")
    return platform === "win32"
      ? "Pi Bot 未能确认这条命令已停下，请先检查它的结果再决定是否重试。其他命令仍可运行。 / Pi Bot couldn't confirm that this command stopped. Check its results before retrying it. Other commands can still run."
      : EXECUTION_PAUSED;
  const checkText = error.reason ? executionChecks[error.reason] : undefined;
  if (checkText) return checkText;
  // The process monitor gave up reading the OS process list while the command was still
  // running, so it stopped the command. That is not proof it did nothing — it may have partially
  // run — and it is not a path/permission problem either. Snapshot failures after exit or during
  // cleanup are cleanup_failed and must not invite a duplicate command (W6-1 review 2).
  if (error.reason === "process_monitor_failed")
    return "命令因执行端监控故障被中途停止，可能已部分执行；先检查文件或仓库状态，再决定是否重试 / The command was stopped part-way by a monitor fault and may have partially run; check the files or repository state before deciding whether to retry";
  // The runner's link died mid-operation. Telling the model to "check the path" made it
  // retry into the same dead target; say what happened and that the folder lock is free again.
  if (error.reason === "runner_disconnected")
    return "执行端连接已断开：这次操作已中止，该文件夹的锁已释放。等执行端重新连上（显示在线）后再试 / The runner disconnected: this operation was stopped and the folder lock released. Retry once the device shows as connected";
  // The runner enforces `timeoutSec` itself; this side ends the call when the device stops
  // answering, which is a different situation from a command that really ran too long.
  if (error.code === "timeout" && tool === "run_command")
    return "执行端在时限内没有回应这条命令，已在桌面侧按超时结束（执行端可能已断开或仍在忙）；确认执行端在线后重新执行 / The runner did not answer within this command's limit, so it was ended as timed out on this computer (the device may have disconnected or still be busy). Run it again once the device is online";
  // The runner is still confirming the previous command's cleanup. It clears on its own,
  // so tell the model to wait instead of treating the device as broken.
  if (error.reason === "cleanup_unconfirmed")
    return "执行端还在确认上一条命令的清理结果，这条命令没有执行；等几秒再试。若持续出现，重启执行端 / The runner is still confirming the previous command's cleanup, so this command did not run; retry in a few seconds, and restart the runner if it keeps happening";
  if (error.reason === "editor_capability_missing")
    return "编辑器没有开放文件读取 / 写入 / 终端，无法执行；请在编辑器里允许后重试 / The editor has not granted file read / write / terminal access, so this cannot run; allow it in the editor and retry";
  // Other targets raise the same pair for any operation they lack; only apply_patch means the
  // filesystem refused the hard-link publication step.
  if (error.code === "file_failed" && error.reason === "unsupported_platform")
    return tool === "apply_patch"
      ? "当前文件系统不支持安全发布多文件补丁，未修改目标文件 / This filesystem does not support safe multi-file patch publication; target files were not changed"
      : "当前执行位置不支持这个操作，未执行 / This operation is not supported where the Bot is running; nothing was done";
  if (error instanceof PatchFormatError) return patchFormatMessage(error.problem, error.line);
  if (error instanceof PatchRecoveryError)
    return "补丁回滚无法安全完成，已保留原文件备份并停止文件写入；请人工核实工作目录，不要自动重试 / Patch rollback could not complete safely; original backups are retained and file writes are blocked. Verify the workspace manually; do not retry automatically";
  // A short old_string that matches twice is the one failure the model retries blindly
  // (19 × edit_not_unique, retro --all 2026-11-05), so name the count and the way out.
  if (error.code === "edit_not_unique")
    return editNotUniqueMessage(
      error instanceof EditNotUniqueError ? error.occurrences : undefined,
    );
  const messages: Partial<Record<ExecError["code"], string>> = {
    file_not_found:
      "文件或目录不存在，请检查路径 / The file or directory does not exist; check the path",
    file_not_directory:
      "路径不是目录，请检查要列出的目录 / The path is not a directory; check the directory path",
    file_access_denied:
      "文件系统拒绝访问，请检查系统权限或文件属性 / The filesystem denied access; check system permissions or file attributes",
    file_sensitive:
      "这个文件按敏感文件规则不搜索，未读取内容；不要用命令绕过 / This file is excluded as sensitive and was not searched; do not work around it with commands",
    file_filter_mismatch:
      "path 是单个文件，但不匹配 include；去掉 include 或换成能匹配这个文件名的 glob / The path is a single file that does not match include; drop include or use a glob that matches this file name",
    command_failed:
      "命令未能完成，具体原因尚未确认。请导出日志检查执行阶段；不能据此认定是 PATH 或审批问题 / Command did not complete; the cause is unconfirmed. Export logs to check the execution stage; this alone does not establish a PATH or approval problem",
    file_conflict:
      "文件在编辑期间发生变化，未覆盖并发修改；请重新读取后再试 / A file changed during editing; concurrent changes were not overwritten. Read it again before retrying",
    edit_overlap:
      "多处修改落在同一段文字上，无法确定先改哪个；请合并成一条修改 / Two edits touch the same text; merge them into one edit",
    busy: "执行服务正在处理另一个操作，请稍后重试 / Another operation is using the execution service; retry later",
    timeout:
      "读取或搜索超过 20 秒时限，没有完成；请缩小范围或分批读取后重试 / The read or search did not finish within its 20 second limit; narrow it or read in smaller batches and retry",
    write_timeout:
      "写入在时限内没有完成，可能已经部分写入：先 read_file 看当前内容，再决定是否重试 / The write did not finish in time and may be partly applied: read_file the current content before deciding whether to retry",
    outside_workplace:
      "路径已改变或不在工作位置内，请重新检查 / The path changed or is outside workplaces; check it again",
    command_not_found:
      "未找到 Docker CLI，请检查安装及 设置 → 权限 → 命令搜索路径 / Docker CLI not found; check installation and Settings → Permissions → Command search paths",
    docker_command_invalid:
      "Docker 专用通道只接受单条 docker 命令和字面参数，不支持 Shell 运算、变量展开或覆盖连接配置 / The dedicated Docker channel accepts one docker command with literal arguments, not shell operations, expansion or connection overrides",
    docker_unsupported:
      "本机 Docker 访问不支持当前运行时或隔离方式 / Local Docker access is unsupported for this runtime or isolation mode",
    docker_endpoint_unavailable:
      "Docker 端点不存在或不可检查，请确认所选运行时已启动并就绪；不代表用户拒绝授权 / Docker endpoint unavailable; check runtime readiness, not user consent",
    docker_permission_changed:
      "Docker 权限或运行环境已变化，请检查设置并重新申请本次命令 / Docker permission or execution context changed; check settings and request the command again",
    docker_endpoint_changed:
      "Docker 端点已变化，请重新申请本次命令审批 / Docker endpoint changed; request fresh approval",
    isolation_unavailable:
      "系统保护未能启动，命令没有运行。请查看运行该命令的电脑上的保护设置，再试一次。 / System protection could not start, so the command did not run. Check the protection settings on the computer running the command, then try again.",
    isolation_scan_limit:
      "只读目录保护扫描超过文件数或时间上限，命令尚未执行；不是 PATH 或审批问题。请缩小可写工作目录范围后重试 / Read-only protection scanning exceeded its entry or time limit; the command did not run. This is not a PATH or approval failure. Retry with a smaller writable workspace",
    web_blocked:
      "网站被阻止：仅允许公开 HTTP(S) 文本网页，且每一跳都必须获授权 / Website blocked: only public HTTP(S) text pages with authorization for every redirect are allowed",
    invalid_input: "工具参数无效 / Invalid tool arguments",
    authorization_changed:
      "审批后这次调用的授权、主机或配置发生了变化，命令没有执行；请重新发起这次调用 / The approval, host, or configuration for this call changed after approval; nothing ran. Start the call again",
    interpreter_untrusted:
      "这条命令的解释器（如 python3、sh、node）在命令搜索路径里指向工作位置等可写的文件夹或版本管理器的替身程序，命令没有执行；请用系统解释器的完整路径（如 /usr/bin/python3）重新发起，或在 设置 › 权限 › 命令搜索路径 中移走该文件夹 / The command's interpreter (such as python3, sh or node) resolves on the command search path to a writable folder such as a workplace, or to a version-manager shim; nothing ran. Start it again with the system interpreter's full path (such as /usr/bin/python3), or remove that folder in Settings › Permissions › Command search paths",
    script_changed:
      "要运行的脚本在检查之后被改动了，命令没有执行；请重新发起这次调用，会按新内容重新判断 / The script changed after it was checked; nothing ran. Start the call again and it will be judged by its new content",
  };
  return (
    messages[error.code] ??
    "工具执行失败或超时，请检查文件、网站或命令 / The tool failed or timed out; check the file, website, or command"
  );
}

/**
 * `edit_not_unique` covers both a missing needle and several matches; the model kept retrying with
 * too-short context (19 × in one run, 2026-11-05), so say the count when it is known and always
 * name the two ways out.
 */
function editNotUniqueMessage(occurrences?: number) {
  const zh = occurrences
    ? `old_string 在文件里出现了 ${occurrences} 次；多带几行上下文让它唯一，或改用 apply_patch 指定位置`
    : "old_string 出现多次；多带几行上下文让它唯一，或改用 apply_patch 指定位置";
  const en = occurrences
    ? `old_string appears ${occurrences} times in the file; include a few more surrounding lines to make it unique, or use apply_patch with an explicit location`
    : "old_string appears more than once; include a few more surrounding lines to make it unique, or use apply_patch with an explicit location";
  return `要替换的文字不存在或出现多次；请读取文件并提供唯一上下文；replaceAll 仅用于精确匹配。${zh} / The text is missing or nonunique; read the file and give unique context; replaceAll applies only to exact matches. ${en}`;
}
