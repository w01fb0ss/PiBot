// Share the literal token boundaries between Windows risk hints and approval checks.
/** `afterPipeOrCall`: the token sits right after `|` or `&`, where PowerShell expects a program. */
type Piece = { tokens: string[]; afterPipeOrCall: boolean; separator: string };

/** Split on unquoted separators while remembering which one, so call operators stay commands. */
export function powershellSegments(command: string) {
  const pieces: Piece[] = [{ tokens: [], afterPipeOrCall: false, separator: "" }];
  let word = "";
  let quote = "";
  const groups: string[] = [];
  let mismatchedGroup = false;
  const flush = () => {
    if (word) pieces.at(-1)?.tokens.push(word);
    word = "";
  };
  for (let i = 0; i < command.length && i < 32_768; i++) {
    const char = command[i] ?? "";
    if (quote) {
      word += char;
      if (char === quote) {
        if (command[i + 1] === quote) word += command[++i];
        else quote = "";
      } else if (char === "`" && quote === '"' && command[i + 1]) word += command[++i];
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      word += char;
    } else if (char === "(" || char === "[" || char === "{") {
      groups.push(char === "(" ? ")" : char === "[" ? "]" : "}");
      word += char;
    } else if (char === ")" || char === "]" || char === "}") {
      if (groups.pop() !== char) mismatchedGroup = true;
      word += char;
    } else if (char === ">") {
      // `echo hi>notes.txt` attaches the redirect to the word; split it so the target is a path.
      const prefix = /(?:\d+|\*)$/.exec(word)?.[0] ?? "";
      word = word.slice(0, word.length - prefix.length);
      flush();
      pieces.at(-1)?.tokens.push(prefix + (command[i + 1] === ">" ? ">>" : ">"));
      if (command[i + 1] === ">") i += 1;
    } else if (/[;\r\n|&]/.test(char)) {
      flush();
      // `&` is the call operator and `|` puts the next token in command position; only `;` and a
      // newline start a statement whose head may be a plain value.
      pieces.push({ tokens: [], afterPipeOrCall: char === "&" || char === "|", separator: char });
    } else if (/\s/.test(char)) flush();
    else word += char;
  }
  flush();
  return {
    pieces,
    unclosed: Boolean(quote) || groups.length > 0 || mismatchedGroup,
    tooLong: command.length > 32_768,
  };
}
