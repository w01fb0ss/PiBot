import { isAbsolute, relative, resolve } from "node:path";
import { looksLikeCredentialValue } from "@pibot/plugins-contract";
import { AbsolutePathSchema } from "@pibot/plugins-contract/full";

export function importWorkingDirectory(value: string, home: string): string | undefined {
  if (
    value.length > 4096 ||
    /[\0\r\n]/.test(value) ||
    value.includes("${") ||
    looksLikeCredentialValue(value)
  )
    return undefined;
  if (!/^~[\\/]/.test(value))
    return isAbsolute(value) ? AbsolutePathSchema.safeParse(value).data : undefined;
  const cwd = resolve(home, value.slice(2).replaceAll("\\", "/"));
  const fromHome = relative(home, cwd);
  if (fromHome === ".." || /^\.\.[\\/]/.test(fromHome) || isAbsolute(fromHome)) return undefined;
  return cwd;
}
