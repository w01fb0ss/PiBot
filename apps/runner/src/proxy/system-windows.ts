// Windows system proxy: the user's WinINet setting (registry, read with reg.exe), else the
// machine's WinHTTP setting (netsh). Both ship with Windows; no native module.
import { noProxyList, type ProxySettings, pacLocation, proxyUrl } from "./route.ts";

export const INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * ProxyServer is either one `host:port` for every scheme or `http=a:1;https=b:2;socks=c:3`.
 * ProxyOverride is a `;` list where `<local>` means host names without a dot.
 */
export function windowsProxySettings(server: string, override = ""): ProxySettings | undefined {
  const entries = server.split(";").map((item) => item.trim());
  let secure: URL | undefined;
  let plain: URL | undefined;
  if (entries.some((item) => item.includes("="))) {
    for (const entry of entries) {
      const [scheme = "", value = ""] = entry.split("=", 2);
      if (scheme.toLowerCase() === "https") secure = proxyUrl(value);
      else if (scheme.toLowerCase() === "http") plain = proxyUrl(value);
    }
    // WinINet uses the http= proxy for https too when only that one is set.
    secure ??= plain;
  } else {
    secure = plain = proxyUrl(entries[0]);
  }
  if (!secure && !plain) return undefined;
  const bypass = noProxyList(override);
  return {
    secure,
    plain,
    bypass: bypass.filter((item) => item !== "<local>"),
    bypassSimple: bypass.includes("<local>"),
  };
}

/** `reg query <key>` lines look like `    ProxyServer    REG_SZ    10.0.0.1:7890`. */
export function parseRegQuery(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_[A-Z_]+\s+(.*?)\s*$/.exec(line);
    if (match?.[1]) values.set(match[1], match[2] ?? "");
  }
  const enabled = /^0x0*1$/i.test(values.get("ProxyEnable") ?? "");
  const manual = enabled
    ? windowsProxySettings(values.get("ProxyServer") ?? "", values.get("ProxyOverride"))
    : undefined;
  // WinINet asks the auto-config script first and uses the manual proxy only without one.
  const pac = pacLocation(values.get("AutoConfigURL") ?? "");
  const bypass = noProxyList(values.get("ProxyOverride"));
  return {
    settings: pac
      ? {
          ...(manual ?? {
            bypass: bypass.filter((item) => item !== "<local>"),
            bypassSimple: bypass.includes("<local>"),
          }),
          pac,
        }
      : manual,
    wpad: !pac && /^0x0*1$/i.test(values.get("AutoDetect") ?? ""),
  };
}

/**
 * `netsh winhttp show proxy` is localized ("Proxy Server(s) :" / "代理服务器:"), so the labels are
 * not matched: the first value that looks like a proxy is the server and the next is the bypass
 * list. "Direct access" output has neither.
 */
export function parseNetshWinhttp(text: string): ProxySettings | undefined {
  const values = text
    .split(/\r?\n/)
    .map((line) => /:\s+(\S.*?)\s*$/.exec(line)?.[1] ?? "")
    .filter(Boolean);
  const index = values.findIndex((value) =>
    /^(?:[a-z]+=)?[\w.-]+:\d+(?:;(?:[a-z]+=)?[\w.-]+:\d+)*;?$/i.test(value.replaceAll(" ", "")),
  );
  if (index < 0) return undefined;
  const bypass = values[index + 1];
  return windowsProxySettings(
    values[index] ?? "",
    bypass && !bypass.startsWith("(") ? bypass : undefined,
  );
}
