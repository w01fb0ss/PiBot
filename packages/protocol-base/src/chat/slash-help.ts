/** Parse only a whole, single-line help request. Other slash input is an ordinary message. */
export function slashHelpRequest(text: string): { command?: string } | undefined {
  const value = text.trim();
  if (/^\/(?:help|帮助)$/iu.test(value)) return {};
  const match = /^\/([^\r\n]+?)[\t ]+(?:help|帮助)$/iu.exec(value);
  const command = match?.[1]?.trim();
  return command ? { command } : undefined;
}
