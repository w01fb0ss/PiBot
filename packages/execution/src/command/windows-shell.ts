import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { gitHardening } from "../git/git-program.ts";

/*
 * Fixed, Pi Bot-authored setup that runs before every Windows agent command (the command text
 * itself is unchanged, and policy, audit and approval cards all see the original command).
 *
 * - UTF-8 in and out: a redirected PowerShell otherwise writes in the OEM code page (936 on a
 *   Chinese system) and re-decodes native programs' UTF-8 output with it, so Chinese text, paths
 *   and error messages reached the model garbled. Python likewise encodes piped output with the
 *   system code page and fails on Chinese; PYTHONUTF8 makes it UTF-8.
 * - UTF-8 file cmdlets: Windows PowerShell 5.1 opens a BOM-less file with the ANSI code page, so a
 *   UTF-8 file a Bot tool wrote came back as mojibake. Reads and writes default to UTF-8 together
 *   so a file stays the same text through Get-Content and Set-Content. `>` redirection is still
 *   UTF-16 in 5.1 (it ignores these defaults); the run_command description tells the model to use
 *   `| Out-File -Encoding utf8` instead.
 * - Package manager shims: where PowerShell would pick npm.ps1 / pnpm.ps1 / yarn.ps1, the default
 *   (Restricted) execution policy of a fresh Windows refuses to load it. The `.cmd` twin in the
 *   same folder is the same program and needs no script policy, so the name is aliased to it.
 *   Resolved here, not in PowerShell: Get-Command / Set-Alias cost 60–250 ms per command, the
 *   variable-syntax alias costs nothing, and an alias of a native program keeps its exit code.
 *   Nothing else about the execution policy changes (maintainers 2026-11-04).
 *
 * Every statement is its own line, not a `;` chain: PowerShell quotes the offending line back in
 * an error report, and on one line that report repeated the whole prelude in front of every
 * Write-Error the model saw.
 */
const SHIMS = ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg", "corepack"];
const ENCODING = [
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "$OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$env:PYTHONUTF8='1'",
  "$PSDefaultParameterValues['Get-Content:Encoding']='utf8'",
  "$PSDefaultParameterValues['Select-String:Encoding']='utf8'",
  "$PSDefaultParameterValues['Set-Content:Encoding']='utf8'",
  "$PSDefaultParameterValues['Add-Content:Encoding']='utf8'",
  "$PSDefaultParameterValues['Out-File:Encoding']='utf8'",
];
// Write-Error's InvocationInfo points at the caller of a dynamic block (Y3), so never format
// the whole ErrorRecord. Only the first stack frame may locate the user's original source.
const FORMAT_ERROR = [
  "function __pibotWriteError($record) {",
  "  Write-Output ([string]$record.Exception.Message)",
  "  $frame=([string]$record.ScriptStackTrace -split '\\r?\\n',2)[0]",
  "  if ($frame -match '[:,]\\s*[^0-9\\r\\n]*([0-9]+)[^0-9\\r\\n]*$') {",
  "    $line=0",
  "    if ([int]::TryParse($Matches[1],[ref]$line) -and $line -ge 1 -and $line -le $__pibotLines.Count) {",
  "      Write-Output ('{0}: {1}' -f $line,$__pibotLines[$line-1].TrimEnd([char]13))",
  "    }",
  "  }",
  "  Write-Output ('CategoryInfo: {0}' -f $record.CategoryInfo)",
  "  Write-Output ('FullyQualifiedErrorId: {0}' -f $record.FullyQualifiedErrorId)",
  "}",
].join("\n");
const EXIT_STATUS = [
  // A successful last statement wins over an earlier native failure. Real PowerShell errors
  // use 1 rather than an unrelated native program's stale code; explicit exit N bypasses this.
  "if ($global:__pibotErrors -gt $global:__pibotErrorsBeforeLast) { exit 1 }",
  "if ($__pibotOk) { exit 0 }",
  // A suppressed cmdlet error may leave $? false without emitting an ErrorRecord. It must not
  // inherit an earlier native exit code either. Resolve only a literal final pipeline command;
  // variable commands/control flow keep the runtime status captured inside the block.
  "$__pibotTail=$null",
  "if ($null -ne $__pibotEnd -and $__pibotEnd.Statements.Count -gt 0) { $__pibotTail=$__pibotEnd.Statements[-1] }",
  "if ($__pibotExit -and $__pibotTail -is [System.Management.Automation.Language.PipelineAst]) {",
  "  $__pibotCommand=$__pibotTail.PipelineElements[-1]",
  "  if ($__pibotCommand -is [System.Management.Automation.Language.CommandAst]) {",
  "    $__pibotName=$__pibotCommand.GetCommandName()",
  "    if ($__pibotName) {",
  "      $__pibotInfo=Get-Command -Name $__pibotName -ErrorAction Ignore | Select-Object -First 1",
  "      if ($__pibotInfo -is [System.Management.Automation.AliasInfo]) { $__pibotInfo=$__pibotInfo.ResolvedCommand }",
  "      if ($null -ne $__pibotInfo) {",
  "        if ($__pibotInfo.CommandType -eq 'Application' -or $__pibotInfo.CommandType -eq 'ExternalScript') { exit $__pibotExit }",
  "        if ($__pibotFailed) { exit 1 }",
  "        exit 0",
  "      }",
  "    }",
  "  }",
  "}",
  "if ($__pibotFailed) { exit 1 }",
  "if ($__pibotExit) { exit $__pibotExit }",
  "exit 0",
].join("\n");
// Installing a package manager changes the answer; a minute keeps the stat calls off the hot path.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; aliases: string[] }>();

function shimAliases(path: string) {
  const dirs = path.split(";").filter((dir) => win32.isAbsolute(dir));
  const aliases: string[] = [];
  for (const name of SHIMS) {
    // The first folder that has the name at all is the one PowerShell would use.
    for (const dir of dirs) {
      const has = (ext: string) => existsSync(win32.join(dir, `${name}${ext}`));
      if (!has(".ps1") && !has(".cmd") && !has(".exe") && !has(".bat")) continue;
      if (has(".ps1") && has(".cmd"))
        aliases.push(`\${alias:${name}}='${win32.join(dir, `${name}.cmd`).replaceAll("'", "''")}'`);
      break;
    }
  }
  return aliases;
}

function prelude(path: string | undefined) {
  if (!path) return ENCODING.join("\n");
  const now = Date.now();
  let entry = cache.get(path);
  if (!entry || now - entry.at > CACHE_MS) {
    entry = { at: now, aliases: shimAliases(path) };
    cache.set(path, entry);
    if (cache.size > 16) cache.delete(cache.keys().next().value as string);
  }
  return [...ENCODING, ...entry.aliases].join("\n");
}

/*
 * Parse the original source before adding a status capture: an unclosed bracket must point at
 * the user's command, never at our capture. Capturing $? inside the block avoids PS5.1's
 * dot-source status reset; LASTEXITCODE alone survives later successful cmdlets (Y4).
 * The capture occupies a new line after the original source, so user stack line numbers stay
 * unchanged, including trailing comments. Named end blocks need it before their closing brace.
 */
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

// The policy accepts only literal cmd queries. Bind the system executable and disable AutoRun.
const READ_ONLY_CMD = [
  "$__pibotCmdQueries=$__pibotAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -match '^cmd(?:\\.exe)?$' }, $true)",
  "foreach ($__pibotQuery in ($__pibotCmdQueries | Sort-Object { $_.Extent.StartOffset } -Descending)) {",
  "  $head=$__pibotQuery.CommandElements[0].Extent",
  "  $replacement='& $env:ComSpec'",
  "  if ($__pibotQuery.CommandElements[1].Extent.Text -ieq '/c') { $replacement+=' /d' }",
  "  $__pibotCmd=$__pibotCmd.Remove($head.StartOffset,$head.EndOffset-$head.StartOffset).Insert($head.StartOffset,$replacement)",
  "}",
  "if ($__pibotCmdQueries.Count -gt 0) {",
  "  $__pibotAst=[System.Management.Automation.Language.Parser]::ParseInput($__pibotCmd,[ref]$null,[ref]$null)",
  "}",
];

function readOnlyGit(program: string | undefined) {
  // Bind the executable before any shell lookup. Insert flags before the command and its
  // operands so an approved query cannot select a pager, diff driver or optional index write.
  const prefix = program
    ? [
        "&",
        psQuote(program),
        ...gitHardening("win32", program).map(psQuote),
        "--no-pager",
        "--no-optional-locks",
        "--no-replace-objects",
      ].join(" ")
    : "& '__pibotMissingGit'";
  return [
    "function __pibotMissingGit { throw 'git_unavailable' }",
    "$__pibotGitCommands=$__pibotAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -match '^git(?:\\.exe)?$' }, $true)",
    "foreach ($__pibotGit in ($__pibotGitCommands | Sort-Object { $_.Extent.StartOffset } -Descending)) {",
    "  $__pibotElements=$__pibotGit.CommandElements",
    "  for ($i=1; $i -lt $__pibotElements.Count; $i++) {",
    "    $element=$__pibotElements[$i]",
    "    if ($element.Extent.Text -ceq '-C') { $i++; continue }",
    "    if ($element.Extent.Text.StartsWith('-')) { continue }",
    "    if ($element -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }",
    "    $flags=switch -CaseSensitive ($element.Value) {",
    "      'status' { ' --ignore-submodules=all' }",
    "      'diff' { ' --no-ext-diff --no-textconv --ignore-submodules=all' }",
    "      { $_ -ceq 'log' -or $_ -ceq 'show' } { ' --no-ext-diff --no-textconv --no-show-signature --ignore-submodules=all' }",
    "      default { '' }",
    "    }",
    "    $__pibotCmd=$__pibotCmd.Insert($element.Extent.EndOffset,[string]$flags)",
    "    break",
    "  }",
    "  $head=$__pibotElements[0].Extent",
    `  $__pibotCmd=$__pibotCmd.Remove($head.StartOffset,$head.EndOffset-$head.StartOffset).Insert($head.StartOffset,${psQuote(prefix)})`,
    "}",
    "if ($__pibotGitCommands.Count -gt 0) {",
    "  $__pibotAst=[System.Management.Automation.Language.Parser]::ParseInput($__pibotCmd,[ref]$null,[ref]$null)",
    "}",
  ];
}

const SCRIPT = (encoded: string, readOnly?: { git?: string }) =>
  [
    `$__pibotCmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    "$__pibotLines=$__pibotCmd.Split([char]10)",
    "$__pibotErrors=$null",
    "$__pibotAst=[System.Management.Automation.Language.Parser]::ParseInput($__pibotCmd,[ref]$null,[ref]$__pibotErrors)",
    "if ($__pibotErrors.Count -gt 0) {",
    "  foreach ($__pibotError in $__pibotErrors) {",
    "    Write-Output ('{0}:{1}: {2}' -f $__pibotError.Extent.StartLineNumber,$__pibotError.Extent.StartColumnNumber,$__pibotError.Message)",
    // The quoted line is the one the model wrote; TrimEnd drops the \r of a CRLF source.
    "    Write-Output (('  | ' + $__pibotLines[$__pibotError.Extent.StartLineNumber - 1]).TrimEnd([char]13))",
    "  }",
    "  exit 1",
    "}",
    ...(readOnly ? [...READ_ONLY_CMD, ...readOnlyGit(readOnly.git)] : []),
    FORMAT_ERROR,
    "$__pibotCapture=[Environment]::NewLine + '$global:__pibotOk=$?; $global:__pibotExit=$LASTEXITCODE' + [Environment]::NewLine",
    // PS5.1 resets $? after a function/block call even when it wrote errors. The pipeline
    // counts emitted records synchronously; a same-line marker excludes earlier statements
    // without shifting the user line numbers used by the error formatter.
    "$__pibotBeforeLast='; $global:__pibotErrorsBeforeLast=$global:__pibotErrors; '",
    "$__pibotLast=$null",
    "$__pibotEnd=$__pibotAst.EndBlock",
    "if ($null -eq $__pibotEnd) { $__pibotEnd=$__pibotAst.ProcessBlock }",
    "if ($null -eq $__pibotEnd) { $__pibotEnd=$__pibotAst.BeginBlock }",
    "if ($null -ne $__pibotEnd -and $__pibotEnd.Statements.Count -gt 0) { $__pibotLast=$__pibotEnd.Statements[-1] }",
    // The marker assignment itself makes `$?` true. Do not insert it before a last statement
    // that reads `$?`, or a user conditional would observe our bookkeeping instead of its error.
    "$__pibotReadsQ=$false",
    "if ($null -ne $__pibotLast) { $__pibotReadsQ=$null -ne $__pibotLast.Find({ param($node) $node -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.VariablePath.UserPath -eq '?' }, $true) }",
    "$__pibotEndOffset=$__pibotCmd.Length",
    "if ($null -ne $__pibotEnd -and -not $__pibotEnd.Unnamed) { $__pibotEndOffset=$__pibotEnd.Extent.EndOffset-1 }",
    "$__pibotSource=$__pibotCmd.Insert($__pibotEndOffset,$__pibotCapture)",
    "if ($null -ne $__pibotLast -and -not $__pibotReadsQ) { $__pibotSource=$__pibotSource.Insert($__pibotLast.Extent.StartOffset,$__pibotBeforeLast) }",
    "$__pibotBlock=[ScriptBlock]::Create($__pibotSource)",
    "$global:__pibotOk=$true",
    "$global:__pibotExit=0",
    "$global:LASTEXITCODE=0",
    "$global:__pibotErrors=0",
    "$global:__pibotErrorsBeforeLast=0",
    "if ($__pibotReadsQ) { $global:__pibotErrorsBeforeLast=[int]::MaxValue }",
    "$__pibotFailed=$false",
    // Error stream records still distinguish real errors from SilentlyContinue/handled errors.
    "try {",
    "  . $__pibotBlock 2>&1 | ForEach-Object {",
    "    if ($_ -is [System.Management.Automation.ErrorRecord]) {",
    // A native program writing to stderr arrives as an error record in 5.1, but the program may
    // still have succeeded; its exit code is decided below from $LASTEXITCODE.
    "      if ($_.FullyQualifiedErrorId -like 'NativeCommand*') { Write-Output ([string]$_) } else { $global:__pibotFailed=$true; $global:__pibotErrors++; __pibotWriteError $_ }",
    "    } else { $_ }",
    // Format here, inside the pipeline: PS5.1's implicit table formatter holds objects back to
    // size columns, and the `exit` below ended the process first (round-1 VM 2026-11-12:
    // everything after Get-Location was lost). 4096 columns keep long lines whole.
    "  } | Out-String -Stream -Width 4096",
    "} catch {",
    "  $global:__pibotFailed=$true",
    "  $global:__pibotOk=$false",
    "  __pibotWriteError $_",
    "}",
    EXIT_STATUS,
  ].join("\n");

export function windowsPowerShellArgs(
  command: string,
  path?: string,
  readOnly?: { git?: string },
): string[] {
  // Base64 keeps the command out of PowerShell's parse of the -Command text and survives any
  // quoting, newline or non-ASCII character the model wrote. The cost is that a command near the
  // Windows command-line limit (32,767 characters) no longer fits; such a command could not run
  // here before either.
  const encoded = Buffer.from(command, "utf8").toString("base64");
  const lookup = readOnly
    ? "\n$PSDefaultParameterValues['Get-Command:ListImported']=$true\n$env:NoDefaultCurrentDirectoryInExePath='1'"
    : "";
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `${prelude(path)}${lookup}\n${SCRIPT(encoded, readOnly)}`,
  ];
}
