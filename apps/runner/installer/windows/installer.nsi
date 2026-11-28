; Pi Bot 执行端（runner）的 Windows 安装包。
;
; 由 apps/runner/scripts/installer/windows.ts 调 makensis 编译，下面这些定义都从那边传进来：
;   PIBOT_VERSION       桌面版本号（apps/desktop/package.json），规格要求与桌面一致
;   PIBOT_VERSION_QUAD  四段版本号，VIProductVersion 只接受 4 段纯数字
;   PIBOT_SOURCE        pnpm runner:package 产出的 win32-<arch> 目录
;   PIBOT_OUT           生成的 .exe 路径
;   PIBOT_ICON          图标文件（复用 apps/desktop/build/icon.ico，仓库里不放第二份）
;
; 行为：按用户安装、用户 PATH、开始菜单、
; 可选登录自启（当前用户的启动文件夹）、卸载停进程并删启动项与 PATH 项、默认保留数据。

Unicode true
SetCompressor /SOLID lzma

!define PIBOT_NAME "Pi Bot Runner"
; 旧版的计划任务。升级时清理，确保托盘可以控制唯一的登录启动项。
!define PIBOT_TASK "Pi Bot Runner"
; 执行端数据目录，与 apps/runner/src/data-dir.ts 在 Windows 上的选择一致。
!define PIBOT_DATA_DIR "$LOCALAPPDATA\Pi Bot Runner"
!define PIBOT_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pi Bot Runner"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"

; StrFunc 的函数必须先声明再调用；卸载器里用到的要另外声明 Un 版本。
${StrStr}
${UnStrStr}

; 这两条一般由 WinMessages.nsh 提供，缺了就在编译期补上，免得旧版本 NSIS 直接报错。
!ifndef HWND_BROADCAST
  !define HWND_BROADCAST 0xFFFF
!endif
!ifndef WM_SETTINGCHANGE
  !define WM_SETTINGCHANGE 0x001A
!endif

Name "${PIBOT_NAME}"
OutFile "${PIBOT_OUT}"
InstallDir "$LOCALAPPDATA\Programs\Pi Bot Runner"
; 升级时沿用上次选的目录
InstallDirRegKey HKCU "Software\Pi Bot Runner" "InstallDir"
; 按用户安装：不提权，不弹 UAC；只写 HKCU 和用户目录。
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${PIBOT_VERSION_QUAD}"
VIAddVersionKey "ProductName" "${PIBOT_NAME}"
VIAddVersionKey "FileDescription" "${PIBOT_NAME} Setup"
VIAddVersionKey "FileVersion" "${PIBOT_VERSION}"
VIAddVersionKey "ProductVersion" "${PIBOT_VERSION}"
VIAddVersionKey "LegalCopyright" "Pi Bot"

!define MUI_ICON "${PIBOT_ICON}"
!define MUI_UNICON "${PIBOT_ICON}"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 中文系统显示中文，其它语言回退到英文；先插入的语言就是不匹配时的回退语言。
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString SecMain ${LANG_SIMPCHINESE} "Pi Bot 执行端（必需）"
LangString SecMain ${LANG_ENGLISH} "Pi Bot Runner (required)"
LangString SecAutoStart ${LANG_SIMPCHINESE} "登录时自动启动"
LangString SecAutoStart ${LANG_ENGLISH} "Start at sign-in"
LangString ShortcutPair ${LANG_SIMPCHINESE} "配对"
LangString ShortcutPair ${LANG_ENGLISH} "Pair"
LangString ShortcutStatus ${LANG_SIMPCHINESE} "状态"
LangString ShortcutStatus ${LANG_ENGLISH} "Status"
LangString StartMenuGroup ${LANG_SIMPCHINESE} "Pi Bot 执行端"
LangString StartMenuGroup ${LANG_ENGLISH} "Pi Bot Runner"
LangString DetailStopping ${LANG_SIMPCHINESE} "停止正在运行的执行端…"
LangString DetailStopping ${LANG_ENGLISH} "Stopping the running runner..."
LangString DetailShortcuts ${LANG_SIMPCHINESE} "创建开始菜单快捷方式…"
LangString DetailShortcuts ${LANG_ENGLISH} "Creating Start menu shortcuts..."
LangString DetailPath ${LANG_SIMPCHINESE} "把 pibot 加入用户 PATH…"
LangString DetailPath ${LANG_ENGLISH} "Adding pibot to the user PATH..."
LangString MsgTaskFailed ${LANG_SIMPCHINESE} "无法创建登录启动项。安装已完成，可在执行端菜单中重试。"
LangString MsgTaskFailed ${LANG_ENGLISH} "Could not set up start at sign-in. Installation is complete. Try again from the Runner tray."
LangString MsgDeleteData ${LANG_SIMPCHINESE} "是否同时删除配对数据？$\r$\n$\r$\n删除后这台执行端需要重新配对。选「否」保留数据，以后重装可直接继续用。"
LangString MsgDeleteData ${LANG_ENGLISH} "Delete the pairing data as well?$\r$\n$\r$\nThe runner would have to be paired again. Choose No to keep the data so a future install can reuse it."
LangString MsgCredentialFailed ${LANG_SIMPCHINESE} "凭据管理器里的执行端条目没能删除（可能本来就不存在）。如果它还在，重装后可能沿用原来的设备身份；需要时请在「凭据管理器」里手动删除 secrets: 开头的条目。"
LangString MsgCredentialFailed ${LANG_ENGLISH} "The runner's Credential Manager entry could not be removed (it may already be missing). If it is still there, a reinstall may reuse the old device identity; delete the entry starting with secrets: in Credential Manager."

; 同时识别旧目录包与显式注入的 SEA 文件名，绝不按目录前缀误杀其他 Node。
Var RunnerWasRunning
!macro StopRunner
  ; Win32_Process.ExecutablePath, not Get-Process .Path: NSIS starts the 32-bit PowerShell, which
  ; cannot read the path of a 64-bit process, so nothing matched and upgrades left the runner running
  ; (round-1 VM 2026-11-12).
  DetailPrint "$(DetailStopping)"
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIBOT_RUNNER_INSTALL_ROOT", w "$INSTDIR") i.r0'
!ifdef PIBOT_SEA_EXECUTABLE
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIBOT_RUNNER_INSTALL_EXE", w "${PIBOT_SEA_EXECUTABLE}") i.r0'
!else
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIBOT_RUNNER_INSTALL_EXE", w "") i.r0'
!endif
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$stopped=0; $$root=$$env:PIBOT_RUNNER_INSTALL_ROOT; $$old=[IO.Path]::Combine($$root,$\'runtime\node.exe$\'); $$prior=$\'$\'; $$entry=[IO.Path]::Combine($$root,$\'pibot-entry.txt$\'); if([IO.File]::Exists($$entry)){ $$name=[IO.File]::ReadAllText($$entry).Trim(); if($$name -match $\'^[A-Za-z0-9._-]+\.exe$$$\'){ $$prior=[IO.Path]::Combine($$root,$$name) } }; $$new=if($$env:PIBOT_RUNNER_INSTALL_EXE){[IO.Path]::Combine($$root,$$env:PIBOT_RUNNER_INSTALL_EXE)}else{$\'$\'}; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { [String]::Equals($$_.ExecutablePath,$$old,[StringComparison]::OrdinalIgnoreCase) -or ($$new -ne $\'$\' -and [String]::Equals($$_.ExecutablePath,$$new,[StringComparison]::OrdinalIgnoreCase)) -or ($$prior -ne $\'$\' -and [String]::Equals($$_.ExecutablePath,$$prior,[StringComparison]::OrdinalIgnoreCase)) } | ForEach-Object { $$stopped++; Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }; [Console]::Out.Write([int]$$stopped)"'
  Pop $0
  ; Output: how many runner processes were stopped; an upgrade restarts the tray only if one was.
  Pop $RunnerWasRunning
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIBOT_RUNNER_INSTALL_ROOT", w "") i.r0'
  System::Call 'kernel32::SetEnvironmentVariableW(w "PIBOT_RUNNER_INSTALL_EXE", w "") i.r0'
  Sleep 500
!macroend

; 把安装目录追加到用户 PATH。用户 PATH 是 REG_EXPAND_SZ（常见 %USERPROFILE% 之类的变量），
; 所以只用注册表读写，不经过 .NET 的 SetEnvironmentVariable——那个 API 会把整串写回 REG_SZ，
; 把其它条目里的变量变成死字符串。
Function AddUserPathEntry
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    Return
  ${EndIf}
  ; 前后补分号再找整条匹配，避免把 "$INSTDIR2" 这种前缀相同的目录当成已存在。
  StrCpy $1 ";$0;"
  ${StrStr} $2 $1 ";$INSTDIR;"
  ${If} $2 == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
  ${EndIf}
FunctionEnd

; 卸载时按分号切分用户 PATH，去掉指向安装目录的那一段，其余原样拼回去。
; 比较交给 StrCmp（不区分大小写），Windows 路径本来就不区分大小写。
Function un.RemoveUserPathEntry
  ReadRegStr $0 HKCU "Environment" "Path"
  ${If} $0 == ""
    Return
  ${EndIf}
  StrCpy $1 ""
  StrCpy $2 $0
  ${Do}
    ${UnStrStr} $3 $2 ";"
    ${If} $3 == ""
      StrCpy $4 $2
      StrCpy $2 ""
    ${Else}
      StrLen $5 $2
      StrLen $6 $3
      IntOp $7 $5 - $6
      StrCpy $4 $2 $7
      IntOp $7 $7 + 1
      StrCpy $2 $2 "" $7
    ${EndIf}
    ${If} $4 != ""
      ${If} $4 != "$INSTDIR"
        ${If} $1 == ""
          StrCpy $1 "$4"
        ${Else}
          StrCpy $1 "$1;$4"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${LoopUntil} $2 == ""
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
FunctionEnd

Section "$(SecMain)" SEC_MAIN
  SectionIn RO
  SetShellVarContext current
  !insertmacro StopRunner
  nsExec::ExecToLog 'schtasks.exe /Delete /F /TN "${PIBOT_TASK}"'
  Pop $0
  Delete "$SMSTARTUP\Pi Bot Runner.lnk"

  ; 目录内容就是 pnpm runner:package 的产物：内置 Node、app/dist、app/node_modules、启动脚本。
  ; 运行时行为不改，安装包只负责摆好文件和系统集成。
  SetOutPath "$INSTDIR"
!ifdef PIBOT_SEA_EXECUTABLE
  ; An upgrade from the directory layout drops the old Node runtime and node_modules,
  ; or they would cancel the slimming. Data lives elsewhere and is not touched here.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\pibot.cmd"
!endif
  File /r "${PIBOT_SOURCE}/*"
  File /oname=pibot-runner.ico "${PIBOT_ICON}"
  ; 登录自启和开始菜单均进托盘，不经 cmd，不显示黑窗。
  File /oname=pibot-start.vbs "${__FILEDIR__}/pibot-start.vbs"
  ; 清除旧版黑窗入口；SEA 文件名由打包装配显式提供。
  Delete "$INSTDIR\pibot-pair.cmd"
!ifdef PIBOT_SEA_EXECUTABLE
  FileOpen $0 "$INSTDIR\pibot-entry.txt" w
  FileWrite $0 "${PIBOT_SEA_EXECUTABLE}"
  FileClose $0
!else
  Delete "$INSTDIR\pibot-entry.txt"
!endif
  ; 卸载选「删除配对数据」时用它删凭据管理器里的设备种子。
  File /oname=uninstall-credentials.mjs "${__FILEDIR__}/uninstall-credentials.mjs"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Pi Bot Runner" "InstallDir" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Pi Bot Runner" "StartupShortcut" 1
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "DisplayName" "${PIBOT_NAME}"
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "DisplayVersion" "${PIBOT_VERSION}"
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\pibot-runner.ico"
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "Publisher" "Pi Bot"
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${PIBOT_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${PIBOT_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${PIBOT_UNINSTALL_KEY}" "NoRepair" 1

  DetailPrint "$(DetailShortcuts)"
  CreateDirectory "$SMPROGRAMS\$(StartMenuGroup)"
  CreateShortCut "$SMPROGRAMS\$(StartMenuGroup)\$(ShortcutPair).lnk" "$WINDIR\System32\wscript.exe" \
    '"$INSTDIR\pibot-start.vbs"' "$INSTDIR\pibot-runner.ico" 0
  CreateShortCut "$SMPROGRAMS\$(StartMenuGroup)\$(ShortcutStatus).lnk" "$WINDIR\System32\wscript.exe" \
    '"$INSTDIR\pibot-start.vbs"' "$INSTDIR\pibot-runner.ico" 0

  DetailPrint "$(DetailPath)"
  Call AddUserPathEntry
  ; 已经开着的终端不会自己重读 PATH，广播一次设置变更，让之后启动的进程能找到 pibot。
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ; An upgrade that stopped a running runner starts the tray again, so updating never leaves it
  ; offline until the next sign-in.
  ${If} $RunnerWasRunning != ""
  ${AndIf} $RunnerWasRunning != "0"
    Exec '"$WINDIR\System32\wscript.exe" "$INSTDIR\pibot-start.vbs"'
  ${EndIf}
SectionEnd

; Fresh installs select this by default. An upgrade keeps the user's last choice.
Section "$(SecAutoStart)" SEC_AUTOSTART
  ; The tray uses the same shortcut in this user's Startup folder.
  ClearErrors
  CreateShortCut "$SMSTARTUP\Pi Bot Runner.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\pibot-start.vbs"' "$INSTDIR\pibot-runner.ico" 0
  ${If} ${Errors}
    DetailPrint "$(MsgTaskFailed)"
    ${IfNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION "$(MsgTaskFailed)"
    ${EndIf}
  ${EndIf}
SectionEnd

Function .onInit
  SetShellVarContext current
  ReadRegStr $0 HKCU "Software\Pi Bot Runner" "InstallDir"
  ${If} $0 == ""
    Return
  ${EndIf}
  ${If} ${FileExists} "$SMSTARTUP\Pi Bot Runner.lnk"
    Return
  ${EndIf}
  ReadRegDWORD $0 HKCU "Software\Pi Bot Runner" "StartupShortcut"
  ${If} $0 != 1
    nsExec::ExecToLog 'schtasks.exe /Query /TN "${PIBOT_TASK}"'
    Pop $0
    ${If} $0 == "0"
      Return
    ${EndIf}
  ${EndIf}
  !insertmacro UnselectSection ${SEC_AUTOSTART}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopRunner

  Delete "$SMSTARTUP\Pi Bot Runner.lnk"
  ; Clean up the old scheduled task when uninstalling an upgraded installation.
  nsExec::ExecToLog 'schtasks.exe /Delete /F /TN "${PIBOT_TASK}"'
  Pop $0

  Call un.RemoveUserPathEntry
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Delete "$SMPROGRAMS\$(StartMenuGroup)\$(ShortcutPair).lnk"
  Delete "$SMPROGRAMS\$(StartMenuGroup)\$(ShortcutStatus).lnk"
  RMDir "$SMPROGRAMS\$(StartMenuGroup)"

  DeleteRegKey HKCU "${PIBOT_UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\Pi Bot Runner"

  ; 配对数据默认保留：重装后不用重新配对。静默卸载没人可问，按默认保留。
  ; 选「删除」时必须连凭据管理器里的设备种子一起删：只删目录的话重装会沿用（或重新拿到）
  ; 同一个设备身份，等于没有真正解除配对。条目删不掉只在详情里说明，不中断卸载。
  ${IfNot} ${Silent}
    IfFileExists "${PIBOT_DATA_DIR}\*.*" 0 keep_data
      MessageBox MB_YESNO|MB_ICONQUESTION "$(MsgDeleteData)" IDNO keep_data
!ifdef PIBOT_SEA_EXECUTABLE
      ; The single executable runs its fixed credential-removal helper; there is no node.exe.
      nsExec::ExecToLog /TIMEOUT=20000 '"$INSTDIR\${PIBOT_SEA_EXECUTABLE}" --pibot-internal uninstall-credentials "${PIBOT_DATA_DIR}"'
!else
      nsExec::ExecToLog /TIMEOUT=20000 '"$INSTDIR\runtime\node.exe" "$INSTDIR\uninstall-credentials.mjs" "${PIBOT_DATA_DIR}"'
!endif
      Pop $0
      ${If} $0 != "0"
        DetailPrint "$(MsgCredentialFailed)"
      ${EndIf}
      RMDir /r "${PIBOT_DATA_DIR}"
    keep_data:
  ${EndIf}

  ; 先删大目录再删零散文件，最后才删安装目录本身。
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
!ifdef PIBOT_SEA_EXECUTABLE
  Delete "$INSTDIR\${PIBOT_SEA_EXECUTABLE}"
  RMDir /r "$INSTDIR\resources"
!endif
  Delete "$INSTDIR\pibot.cmd"
  Delete "$INSTDIR\pibot-fixture.cmd"
  Delete "$INSTDIR\pibot-pair.cmd"
  Delete "$INSTDIR\uninstall-credentials.mjs"
  Delete "$INSTDIR\manifest.json"
  Delete "$INSTDIR\pibot-entry.txt"
  Delete "$INSTDIR\pibot-start.vbs"
  Delete "$INSTDIR\pibot-runner.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
