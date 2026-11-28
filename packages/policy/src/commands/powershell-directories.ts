import { win32 } from "node:path";
import { powershellSegments } from "./powershell-segments.ts";
import { windowsLiteralPath } from "./windows-approval-shape.ts";

type Piece = ReturnType<typeof powershellSegments>["pieces"][number];

/**
 * Cmdlets that only read, format or forward objects already in the pipeline. Exempting them keeps
 * the common `... | Select-Object` / `... | Out-String` tails from turning a known directory into
 * "unknown". This is a filter, never a readonly proof: anything that can run a script block stays
 * out on purpose (a Windows review found ForEach-Object / Where-Object / `%` / `?` here,
 * which let `Get-ChildItem | ForEach-Object { Remove-Item … }` pass as harmless).
 */
const pipeOnly =
  /^(?:select-object|select|sort-object|sort|measure-object|measure|group-object|group|compare-object|format-(?:table|list|wide|custom|hex)|ft|fl|fw|out-string|out-null|out-host|write-host|select-string|test-path|get-item|get-content|gc|cat|type|get-childitem|ls|dir|pwd|get-location|write-output|echo)$/i;

const mutator =
  /^(?:touch|mkdir|md|new-item|ni|set-item|si|set-content|sc|add-content|ac|out-file|tee-object|export-csv|clear-content|clc|clear-item|cli|remove-item|ri|rm|del|erase|new-itemproperty|set-itemproperty|sp|remove-itemproperty|rp|clear-itemproperty|clp|rename-itemproperty|rnp|copy-itemproperty|cpp|move-itemproperty|mp|copy-item|cp|copy|move-item|mv|move|rename-item|ren)$/i;

const directoryChange = /^(?:cd|chdir|sl|set-location|pushd|push-location|popd|pop-location)$/i;

/** A segment with `{` / `$(` evaluates a script block or subexpression, so it is not just data. */
const runsCode = (tokens: string[]) => /\{|@\{|\$\(/.test(tokens.join(" "));

/**
 * Only a statement's leading literal is a value. A double-quoted string with `$` or a backtick
 * interpolates (it may run `$(…)`), and a bare number is not worth guessing about, so neither
 * counts as data.
 */
const dataHead = (token: string) => /^'(?:[^']|'')*'$/.test(token) || /^"[^"$`]*"$/.test(token);

/**
 * Arguments containing `(`, `@`, `$`, `[`, `{` or a backtick can run code, splat arguments or
 * interpolate, so the cmdlet is no longer a plain pipeline tail (`Sort-Object (Clear-Content …)`,
 * `Sort-Object $s`, `Select-Object @a`).
 */
const argumentRuns = /[()@$[\]`{]/;

const literal = (raw: string | undefined) => {
  if (!raw) return undefined;
  if (/^'(?:[^']|'')*'$/.test(raw)) return raw.slice(1, -1).replaceAll("''", "'");
  if (/^"[^"$`]*"$/.test(raw)) return raw.slice(1, -1);
  return /[\s'"$`*?(){}@%]/.test(raw) ? undefined : raw;
};

const absolute = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
// `HKCU:`, `Env:`, `Cert:`, `Function:`, `Alias:` or any `::` member path is a provider location,
// not a file path: writing there changes registry / environment / command lookup, which this
// scanner cannot map to a folder at all.
const providerPath = /^[a-z][\w.-]+:|::/i;

function project(path: string, directories: readonly string[]): string[] | undefined {
  // Rooted/drive-relative paths depend on per-drive state, which this scanner cannot certify.
  if (!absolute(path) && /^[\\/]|^[a-z]:/i.test(path)) return undefined;
  if (providerPath.test(path)) return undefined;
  if (absolute(path)) return [path];
  return directories.map((directory) => `${directory}\\${path}`);
}

/** Targets of a directory change; undefined means the cwd can no longer be trusted. */
function directoryTargets(
  raw: string[],
  program: string | undefined,
  directories: readonly string[],
) {
  if (/^(?:popd|pop-location)$/i.test(program ?? "")) return undefined;
  let args = raw.slice(1);
  if (/^-(?:literalpath|path)$/i.test(args[0] ?? "")) args = args.slice(1);
  const token = args[0] ?? "";
  const target = args.length === 1 ? literal(token) : undefined;
  if (
    !target ||
    /^[#-]/.test(token) ||
    /[\u2018-\u201f\p{Cc}]/u.test(target) ||
    (token === target && token.includes(",")) ||
    !windowsLiteralPath(target, true)
  )
    return undefined;
  return project(target, directories);
}

const pathFlag = /^-(?:literalpath|path|filepath|destination)$/i;
const inlinePathFlag = /^-(?:literalpath|path|filepath|destination):(.+)$/i;
// Flags that own the next token as data (`-Name X`, `-Property P`): without them a property name
// would be read as the destination path and the real registry target would be dropped.
const valueFlag = /^-(?:value|itemtype|encoding|filter|include|exclude|name|property)$/i;
const knownSwitch = /^-(?:force|recurse|append|noclobber|confirm|whatif|passthru)$/i;
const contentWriters = /^(?:set-content|sc|add-content|ac|out-file|tee-object|export-csv)$/i;
const valuePrograms = /^(?:echo|write-output|write-host|out-host|out-string)$/i;

/** Path operands of a writing cmdlet; content values are skipped, not mistaken for filenames. */
function writeOperands(
  raw: string[],
  redirect: number,
  program: string,
  markUnknownFlag: () => void,
) {
  const copies = /^(?:copy-item|cp|copy|copy-itemproperty|cpp)$/i.test(program);
  const operands: string[] = [];
  if (redirect >= 0) {
    const token = raw[redirect] ?? "";
    operands.push(token.replace(/^(?:\d|\*)?>>?/, "") || raw[redirect + 1] || "");
  }
  const positional: string[] = [];
  for (let i = 1; i < raw.length && (redirect < 0 || i < redirect); i++) {
    const arg = raw[i] ?? "";
    const inline = inlinePathFlag.exec(arg);
    // Copy sources are reads: `-Path` (spaced or inline) feeds the copy, only `-Destination` is
    // written. A spaced flag owns the next token; an inline one must not swallow it.
    if (copies && /^-(?:literalpath|path|filepath)$/i.test(arg)) i++;
    else if (copies && /^-(?:literalpath|path|filepath):/i.test(arg)) continue;
    else if (inline) operands.push(inline[1] ?? "");
    else if (pathFlag.test(arg)) operands.push(raw[++i] ?? "");
    else if (valueFlag.test(arg)) i++;
    else if (!arg.startsWith("-")) positional.push(arg);
    else if (!knownSwitch.test(arg)) markUnknownFlag();
  }
  if (copies) {
    // Sources are reads; only the destination (a flag or the last positional) is a new write.
    if (!operands.length && positional.length) operands.push(positional.at(-1) ?? "");
  } else if (/^(?:move-item|mv|move|move-itemproperty|mp)$/i.test(program)) {
    // Moving removes the source too, so sources and destination are all write targets.
    operands.push(...positional);
  } else if (!valuePrograms.test(program) && !pipeOnly.test(program)) {
    // `echo hi>notes.txt` / `Get-Content a>b.txt` write only the redirect target; the earlier
    // tokens are data or source paths, not write targets.
    operands.push(
      ...(contentWriters.test(program) ? positional.slice(0, operands.length ? 0 : 1) : positional),
    );
  }
  return operands;
}

/** Whether a non-writing segment can be skipped without calling the directory unknown. */
function readonly(piece: Piece, program: string | undefined) {
  const raw = piece.tokens;
  if (runsCode(raw)) return false;
  if (pipeOnly.test(program ?? "") && !argumentRuns.test(raw.slice(1).join(" "))) return true;
  // Only a lone literal can be data; `'a' + (Set-Content …)` is an expression.
  return raw.length === 1 && !piece.afterPipeOrCall && dataHead(raw[0] ?? "");
}

/**
 * Whether a segment is a directory switch, a recognized write, or a read-only tail. Anything else
 * (`iex (…'function'…)`, `Import-Alias`, `Import-Module`, `. .\defs.ps1`, a splat, an assignment
 * into `$ExecutionContext`) can change what later cmdlet names mean. When the directory is
 * uncertain, an opaque segment prevents later pipeline tails from being treated as harmless.
 */
function exempt(piece: Piece) {
  const raw = piece.tokens;
  if (!raw.length) return true;
  const program = literal(raw[0])?.toLowerCase();
  if (directoryChange.test(program ?? "") || mutator.test(program ?? "")) return true;
  if (raw.some((value) => /^(?:\d|\*)?>>?/.test(value))) return true;
  return readonly(piece, program);
}

/** Display-only facts: PowerShell remains opaque and never gains readonly authorization here. */
export async function powershellDirectoryWrites(
  command: string,
  cwd: string,
  verifyDirectory: (path: string) => Promise<boolean>,
) {
  const writes = new Set<string>();
  let directories: string[] = [cwd];
  let unknown = false;
  let changed = false;
  let unverifiedDirectory = false;
  let unknownWrite = false;
  const parsed = powershellSegments(command);
  if (parsed.unclosed || parsed.tooLong) unknown = true;
  const tainted = parsed.pieces.some((piece) => !exempt(piece));
  for (const piece of parsed.pieces) {
    const raw = piece.tokens;
    if (!raw.length) continue;
    const program = literal(raw[0])?.toLowerCase();
    if (directoryChange.test(program ?? "")) {
      // A nonterminating Set-Location error leaves the previous cwd live. Every possible cwd
      // must be verified before an opaque command can be treated like one with no cd prefix.
      changed = true;
      const projected = directoryTargets(raw, program, directories);
      if (!projected?.length) unknown = true;
      else {
        const candidates = [...new Set([...directories, ...projected])];
        directories = [...new Set(candidates.map((path) => win32.normalize(path)))];
        if (directories.length > 16) {
          directories = [];
          unknown = true;
        } else if (!unknown && !unverifiedDirectory) {
          const verified = await Promise.all(candidates.map(verifyDirectory));
          unverifiedDirectory = verified.includes(false);
        }
      }
      continue;
    }
    if (
      /(?:^|[\s({])(?:cd|chdir|sl|set-location|pushd|push-location|popd|pop-location)\b/i.test(
        raw.join(" "),
      )
    ) {
      // A directory change hidden inside an expression or script block still moves the cwd.
      changed = true;
      unknown = true;
    }
    const redirect = raw.findIndex((value) => /^(?:\d|\*)?>>?/.test(value));
    if (!mutator.test(program ?? "") && redirect < 0) {
      if (changed) {
        // Even at a verified directory, an expression can change the location before writing.
        const opaqueCode =
          !readonly(piece, program) &&
          (!program || program === "." || runsCode(raw.filter((token) => !dataHead(token))));
        if (((unknown || unverifiedDirectory) && tainted) || opaqueCode) unknownWrite = true;
      }
      continue;
    }
    const operands = writeOperands(raw, redirect, program ?? "", () => {
      // Without a directory switch this scan has no known target to lose, so an unfamiliar flag
      // must not turn an otherwise normal command into a danger fact.
      if (changed) unknownWrite = true;
    });
    for (const operand of operands) {
      if (redirect >= 0 && /^\$null$/i.test(operand)) continue;
      const value = literal(operand);
      // A provider target (`HKCU:`, `Env:`, `Function:` …) is outside every folder model, so it is
      // an unknown location even without a directory switch.
      if (value && providerPath.test(value)) {
        unknownWrite = true;
        continue;
      }
      const paths = value
        ? project(value, directories)?.map((path) => win32.normalize(path))
        : undefined;
      if (!changed) {
        // No switch: relative targets resolve from the cwd the caller verified, but `..` can leave
        // it, so record the normalized target instead of assuming it stays inside.
        // A target this scan cannot pin down (`*.docx`, an interpolated path) is an unknown
        // location, not a non-write: silently dropping it hid `Clear-Content …\*.docx`.
        if (!paths) unknownWrite = true;
        else if (!unknown) for (const path of paths) writes.add(path);
        continue;
      }
      const absoluteOperand = absolute(value ?? "");
      if (!paths || ((unknown || unverifiedDirectory) && !absoluteOperand)) unknownWrite = true;
      if (!unknown || absoluteOperand) for (const path of paths ?? []) writes.add(path);
    }
    if (!operands.length && changed) unknownWrite = true;
  }
  return { writes: [...writes], unknownWrite };
}
