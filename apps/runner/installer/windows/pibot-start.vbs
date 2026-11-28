' Pi Bot Runner: start the tray when the user signs in, without a console window.
'
' The Startup shortcut runs this file through wscript.exe. The install folder comes from the script's
' own location, so it still works when the user picks another install folder in the installer.
' Pure ASCII on purpose: Windows Script Host reads .vbs as ANSI unless it carries a BOM.
' The independent execution owner survives a tray crash. This supervisor only restarts exit 70.
' Owner decision 2026-11-11: only exit code 70 (the runner's
' fatal-crash exit, see apps/runner/src/fatal.ts) is restarted, with backoff 5 s doubling to 60 s.
' A normal stop (0), "already running" or another business error (1) and a refused environment
' (78) are not. Five crashes within ten minutes stop the loop; runner.fatal lines stay in the log.
Dim shell, folder, command, code, delay, crashes, windowStart, fs, entry, pattern
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
command = Chr(34) & folder & "runtime\node.exe" & Chr(34) & " " & Chr(34) & folder & "app\dist\runner.js" & Chr(34) & " runner tray"
If fs.FileExists(folder & "pibot-entry.txt") Then
  entry = Trim(fs.OpenTextFile(folder & "pibot-entry.txt", 1).ReadAll)
  Set pattern = New RegExp
  pattern.Pattern = "^[A-Za-z0-9._-]+\.exe$"
  pattern.IgnoreCase = True
  If Not pattern.Test(entry) Then WScript.Quit 1
  command = Chr(34) & folder & entry & Chr(34) & " runner tray"
End If
delay = 5
crashes = 0
windowStart = Now
Do
  ' 0 = hidden window, True = wait: this script stays as a small supervisor while the runner runs.
  code = shell.Run(command, 0, True)
  If code <> 70 Then Exit Do
  If DateDiff("s", windowStart, Now) > 600 Then
    crashes = 0
    delay = 5
    windowStart = Now
  End If
  crashes = crashes + 1
  If crashes >= 5 Then Exit Do
  WScript.Sleep delay * 1000
  delay = delay * 2
  If delay > 60 Then delay = 60
Loop
