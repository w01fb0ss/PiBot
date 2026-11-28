import { posix, win32 } from "node:path";
import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import { MessagesRepo } from "@pibot/storage";

export function personSuppliedFolder(
  ctx: CapabilityContext,
  context: ToolRunContext,
  input: string,
): string | undefined {
  const { platform, userHome } = ctx.local.deps;
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const homePath = windows ? /^~[\\/]/u : /^~\//u;
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/u : /^\//u;
  const normalize = (value: string) => {
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return;
    const source =
      value === "~"
        ? userHome
        : homePath.test(value)
          ? path.join(userHome, value.slice(2))
          : absolute.test(value)
            ? value
            : undefined;
    if (source === undefined) return;
    const normalized = path.resolve(source);
    // Windows drive letters are case-insensitive; directory names can be case-sensitive.
    return windows
      ? normalized.replace(/^[a-z](?=:)/i, (drive) => drive.toUpperCase())
      : normalized;
  };

  if (!context.conversationId) return;
  const wanted = normalize(input);
  if (!wanted) return;
  // Sentence punctuation right after a path (「项目在 ~/code/shop，帮我…」) is not part of it.
  const matches = (value: string) =>
    normalize(value) === wanted ||
    normalize(value.replace(/[，。；：、！？,.;:!?）)」』】]+$/u, "")) === wanted;
  // Compare whole path tokens, including quoted paths with spaces. A path prefix or an
  // embedded slash in a URL cannot authorize a different folder.
  for (const { content } of new MessagesRepo(ctx.db).personTypedContent(context.conversationId)) {
    if (typeof content !== "string") continue;
    for (const line of content.split(/\r?\n/u)) {
      if (matches(line.trim())) return wanted;
      const tokens = line.matchAll(
        /`([^`]+)`|"([^"]+)"|(?<![\p{L}\p{N}])'([^']+)'|“([^”]+)”|‘([^’]+)’|<([^>]+)>|(?<![\p{L}\p{N}./\\])\(([^)]+)\)|（([^）]+)）|((?:~|\/|[A-Za-z]:[\\/]|\\\\)[^\s`"<>]*)|[^\s`"'“‘<（]+/gu,
      );
      for (const token of tokens) {
        const value = token.slice(1).find(Boolean);
        if (value !== undefined && matches(value)) return wanted;
      }
    }
  }
}
