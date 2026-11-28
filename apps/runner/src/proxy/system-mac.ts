// macOS system proxy from `scutil --proxy` (ships with the OS; no native module).
import { type ProxySettings, pacLocation, proxyUrl } from "./route.ts";

/** Parses scutil's `<dictionary>` dump: flat keys plus the ExceptionsList array. */
export function parseScutilProxy(text: string): { settings?: ProxySettings; wpad: boolean } {
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let inExceptions = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inExceptions) {
      if (line === "}") inExceptions = false;
      else {
        const item = /^\d+\s*:\s*(.+)$/.exec(line)?.[1];
        if (item) exceptions.push(item.trim());
      }
      continue;
    }
    if (/^ExceptionsList\s*:\s*<array>\s*\{$/.test(line)) {
      inExceptions = true;
      continue;
    }
    const pair = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(line);
    if (pair?.[1] && pair[2]) values.set(pair[1], pair[2].trim());
  }
  const location = values.get("ProxyAutoConfigURLString");
  const pac =
    values.get("ProxyAutoConfigEnable") === "1" && location ? pacLocation(location) : undefined;
  // Auto-discovery (WPAD) without a configured script address is not supported.
  const wpad = !pac && values.get("ProxyAutoDiscoveryEnable") === "1";
  const proxy = (prefix: "HTTP" | "HTTPS") =>
    values.get(`${prefix}Enable`) === "1" && values.get(`${prefix}Proxy`)
      ? proxyUrl(
          `http://${values.get(`${prefix}Proxy`)}${
            values.get(`${prefix}Port`) ? `:${values.get(`${prefix}Port`)}` : ""
          }`,
        )
      : undefined;
  const secure = proxy("HTTPS");
  const plain = proxy("HTTP");
  if (!secure && !plain && !pac) return { wpad };
  return {
    wpad,
    settings: {
      secure,
      plain,
      bypass: exceptions.map((item) => item.toLowerCase()).slice(0, 200),
      bypassSimple: values.get("ExcludeSimpleHostnames") === "1",
      ...(pac ? { pac } : {}),
    },
  };
}
