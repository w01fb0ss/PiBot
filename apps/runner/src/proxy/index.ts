// Resolves the runner's proxy once at start; the result is passed to every relay connection.
import type { RunnerLogger } from "../logger.ts";
import type { RunnerRedactor } from "../redactor.ts";
import { type PacNote, pacResolver } from "./pac.ts";
import type { PacEngine } from "./pac-engine.ts";
import {
  environmentProxy,
  flagProxy,
  noProxyList,
  type ProxySettings,
  type RunnerProxy,
  runnerProxy,
} from "./route.ts";
import { type ReadCommand, systemProxy } from "./system.ts";

export type { RunnerProxy } from "./route.ts";

export async function resolveRunnerProxy(options: {
  flag?: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  redactor: Pick<RunnerRedactor, "add">;
  logger: RunnerLogger;
  read?: ReadCommand;
  /** Probes only: a PAC engine with its own DNS answers. */
  pacEngine?: PacEngine;
}): Promise<RunnerProxy> {
  const flag = options.flag ? flagProxy(options.flag) : undefined;
  const fromEnv = environmentProxy(options.env);
  // The system is only asked when nothing closer names a proxy.
  const system =
    flag || fromEnv.settings
      ? undefined
      : await systemProxy(options.platform, options.env, options.read);
  // One line per change of PAC outcome, not one per reconnect attempt.
  let lastNote: PacNote | undefined;
  const note = (word: PacNote) => {
    if (word === lastNote) return;
    lastNote = word;
    options.logger.write("warn", "runner.proxy_pac", { outcome: word });
  };
  const proxy = runnerProxy(
    { flag, env: fromEnv.settings, system: system?.settings },
    noProxyList(options.env.NO_PROXY ?? options.env.no_proxy),
    (location) => {
      // The script address may carry an account; it is never logged, and redacted if it leaks.
      const url = new URL(location);
      if (url.password) options.redactor.add(decodeURIComponent(url.password));
      return pacResolver(location, note, options.pacEngine);
    },
  );
  // A proxy account is a credential: it never reaches the log, even inside a later error line.
  const chosen: ProxySettings | undefined =
    proxy.source === "flag" && flag !== "direct"
      ? flag
      : proxy.source === "env"
        ? fromEnv.settings
        : proxy.source === "system"
          ? system?.settings
          : undefined;
  for (const url of [chosen?.secure, chosen?.plain])
    if (url?.password) options.redactor.add(decodeURIComponent(url.password));
  options.logger.write("info", "runner.proxy", {
    source: proxy.source,
    ...(fromEnv.ignored ? { ignored: "unsupported_scheme" } : {}),
    ...(system?.note ? { system: system.note } : {}),
    ...(proxy.source === "system" && system?.settings?.pac ? { pac: true } : {}),
  });
  return proxy;
}
