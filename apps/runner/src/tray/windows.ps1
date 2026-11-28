[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiTrayIcon { [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon); }'
$lastIcon = ''; $lastTasks = -1
$zh = [Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'zh'
function L($a,$b) { if ($zh) { $a } else { $b } }
$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$state = $menu.Items.Add('Pi Bot Runner'); $state.Enabled = $false
$pair = $menu.Items.Add((L '配对…' 'Pair…'))
$unpair = $menu.Items.Add((L '解除配对…' 'Unpair…')); $unpair.Visible = $false
$login = $menu.Items.Add((L '登录时启动' 'Start at sign-in'))
$startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Pi Bot Runner.lnk'
$login.Checked = [IO.File]::Exists($startupLink)
$logs = $menu.Items.Add((L '打开日志' 'Open logs'))
$quit = $menu.Items.Add((L '退出' 'Quit'))
$tray.ContextMenuStrip = $menu
$tray.Visible = $true
$form = $null
$paired = $false
$connecting = $false
$pair.Add_Click({
  if ($script:paired -and [System.Windows.Forms.MessageBox]::Show((L '更换已配对的电脑？' 'Replace the paired computer?'), 'Pi Bot Runner', 'YesNo', 'Question') -ne 'Yes') { return }
  $dialog = New-Object Windows.Forms.Form; $dialog.Text = L '配对执行端' 'Pair runner'; $dialog.Width=500; $dialog.Height=235
  $label = New-Object Windows.Forms.Label; $label.Text=L '在主电脑的「设置 › 设备 › 添加设备 › 另一台电脑 / 服务器」复制配对码，再粘贴到这里。' 'On your main computer, go to Settings › Devices › Add device › Another computer / server. Copy the code and paste it here.'; $label.SetBounds(15,15,450,45)
  $inputCode = New-Object Windows.Forms.TextBox; $inputCode.SetBounds(15,62,450,25); $inputCode.MaxLength=1152
  $submit = New-Object Windows.Forms.Button; $submit.Text=L '配对' 'Pair'; $submit.SetBounds(370,102,90,30); $submit.DialogResult='OK'
  $cancel = New-Object Windows.Forms.Button; $cancel.Text=L '取消' 'Cancel'; $cancel.SetBounds(270,102,90,30); $cancel.DialogResult='Cancel'
  $legacy = New-Object Windows.Forms.LinkLabel; $legacy.Text=L '显示本机配对码' 'Show code from this computer'; $legacy.SetBounds(15,142,320,25)
  $legacy.Add_Click({ $dialog.DialogResult='Retry'; $dialog.Close() })
  $dialog.Controls.AddRange(@($label,$inputCode,$submit,$cancel,$legacy)); $dialog.AcceptButton=$submit; $dialog.CancelButton=$cancel
  try {
    $result=$dialog.ShowDialog()
    if ($result -eq 'OK') { [Console]::Out.WriteLine('pair-code:' + $inputCode.Text.Trim()); [Console]::Out.Flush() }
    elseif ($result -eq 'Retry') { [Console]::Out.WriteLine('pair'); [Console]::Out.Flush() }
  } finally { $dialog.Dispose() }
})
$unpair.Add_Click({
  if ([Windows.Forms.MessageBox]::Show((L '解除配对后，执行端会停止接收已配对设备的任务。要再次使用，请重新配对。' 'After unpairing, Pi Bot Runner stops accepting work from paired devices. Pair again to use it.'), (L '解除配对？' 'Unpair?'), 'YesNo', 'Question') -ne 'Yes') { return }
  [Console]::Out.WriteLine('unpair'); [Console]::Out.Flush()
})
$login.Add_Click({
  try {
    if ([IO.File]::Exists($startupLink)) {
      [IO.File]::Delete($startupLink)
    } else {
      $install = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Pi Bot Runner' -Name InstallDir -ErrorAction Stop).InstallDir
      $launcher = Join-Path $install 'pibot-start.vbs'
      if (-not [IO.File]::Exists($launcher)) { throw 'missing launcher' }
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($startupLink)
      $shortcut.TargetPath = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
      $shortcut.Arguments = '"' + $launcher + '"'
      $shortcut.IconLocation = (Join-Path $install 'pibot-runner.ico') + ',0'
      $shortcut.Save()
    }
    $login.Checked = [IO.File]::Exists($startupLink)
  } catch {
    $tray.ShowBalloonTip(5000, 'Pi Bot Runner', (L '没能更改登录时启动的设置。请从安装好的执行端再试一次。' 'Could not change start at sign-in. Try again from the installed Runner.'), 'Warning')
  }
})
$logs.Add_Click({ [Console]::Out.WriteLine('logs'); [Console]::Out.Flush() })
$quit.Add_Click({ $quit.Enabled = $false; [Console]::Out.WriteLine('quit'); [Console]::Out.Flush() })
$read = [Console]::In.ReadLineAsync()
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 100
$timer.Add_Tick({
  if (-not $script:read.IsCompleted) { return }
  $line = $script:read.Result
  if ($null -eq $line) { [System.Windows.Forms.Application]::Exit(); return }
  $script:read = [Console]::In.ReadLineAsync()
  try { $v = $line | ConvertFrom-Json } catch { return }
  if ($v.statusUnavailable) { $state.Text = L '状态暂不可用' 'Status temporarily unavailable'; $tray.Text = $state.Text }
  if ($v.close) { [System.Windows.Forms.Application]::Exit(); return }
  if ($v.error) {
    $quit.Enabled = $true
    $tray.ShowBalloonTip(5000, 'Pi Bot Runner', (L $v.error.zh $v.error.en), 'Warning')
  }
  if ($v.PSObject.Properties.Name -contains 'connecting') {
    $script:connecting = $v.connecting
    $pair.Enabled = -not $script:connecting
    $unpair.Enabled = -not $script:connecting
    if ($script:connecting) {
      $state.Text = L '正在连接…' 'Connecting…'
      $tray.Text = $state.Text
      $tray.ShowBalloonTip(3000, 'Pi Bot Runner', $state.Text, 'Info')
    }
  }
  if ($null -ne $v.status) {
    $script:paired = $v.status.paired
    $unpair.Visible = $script:paired
    $connection = switch ($v.status.connection) {
      'online' { L '在线' 'Online' }
      { $_ -eq 'connecting' -or $_ -eq 'reconnecting' } { L '正在连接…' 'Connecting…' }
      default { L '离线' 'Offline' }
    }
    $tasks = [int]$v.status.runningCommands + [int]$v.status.backgroundTasks
    $path = if ($v.status.connection -eq 'online') {
      switch ($v.status.path) {
        'lan' { L '同一网络直连' 'Direct on the same network' }
        'address' { L '直连' 'Direct' }
        'punched' { L '跨网络直连' 'Direct across networks' }
        'relay' { L '经中继转发' 'Via relay' }
      }
    }
    $label = if ($script:connecting) { L '正在连接…' 'Connecting…' }
      elseif (-not $script:paired) { L '未配对' 'Unpaired' }
      else { (@($v.status.name, $connection, $path, "$(L '任务' 'Tasks'): $tasks") | Where-Object { $_ }) -join ' · ' }
    $state.Text = $label; $tray.Text = $label.Substring(0,[Math]::Min(63,$label.Length))
    if ($v.icon -and [IO.File]::Exists($v.icon) -and ($script:lastIcon -ne $v.icon -or $script:lastTasks -ne $tasks)) {
      $bitmap = New-Object System.Drawing.Bitmap($v.icon)
      if ($tasks -gt 0) { $g = [Drawing.Graphics]::FromImage($bitmap); $g.FillEllipse([Drawing.Brushes]::Red,22,22,10,10); $g.Dispose() }
      $handle = $bitmap.GetHicon()
      try { $temporary = [Drawing.Icon]::FromHandle($handle); $newIcon = $temporary.Clone(); $temporary.Dispose() } finally { [void][PiTrayIcon]::DestroyIcon($handle) }
      $script:lastIcon=$v.icon; $script:lastTasks=$tasks
      $old = $tray.Icon; $tray.Icon = $newIcon
      if ($old) { $old.Dispose() }; $bitmap.Dispose()
    }
  }
  if ($v.PSObject.Properties.Name -contains 'pairing') {
    if ($v.pairing) {
      if ($null -eq $script:form -or $script:form.IsDisposed) {
        $script:form = New-Object Windows.Forms.Form; $script:form.Text = L '配对执行端' 'Pair runner'; $script:form.Width=470; $script:form.Height=150
        $script:code = New-Object Windows.Forms.TextBox; $script:code.ReadOnly=$true; $script:code.Width=420; $script:code.Left=15; $script:code.Top=15
        $copy = New-Object Windows.Forms.Button; $copy.Text=L '复制' 'Copy'; $copy.Top=50; $copy.Left=15
        $copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($script:code.Text) })
        $script:form.Controls.Add($script:code); $script:form.Controls.Add($copy)
      }
      $script:code.Text=$v.pairing; $script:form.Show(); $script:form.Activate()
    } elseif ($script:form) { $script:form.Close(); $script:form=$null }
  }
})
$timer.Start()
try { [Windows.Forms.Application]::Run() } finally { $timer.Dispose(); if ($form) { $form.Dispose() }; $tray.Visible=$false; $tray.Dispose(); $menu.Dispose() }
