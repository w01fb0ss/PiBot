// Proxy auto-config: the system names a PAC script; the runner fetches it directly and asks it,
// in the sandboxed engine, which proxy reaches the relay. Any failure means a direct connection,
// as before PAC support, and is logged as a fixed word.
import { readFile, stat } from "node:fs/promises";
import { Agent as HttpAgent, get as httpGet, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, get as httpsGet } from "node:https";
import { fileURLToPath } from "node:url";
import { createPacEngine, type PacEngine } from "./pac-engine.ts";
import { proxyUrl } from "./route.ts";

const PAC_LIMIT = 1024 * 1024;
const FETCH_MS = 10_000;
const CACHE_MS = 60_000;
const REDIRECTS = 3;

export type PacNote = "pac_failed" | "pac_socks_unsupported";

/** The first entry the runner can use: PROXY/HTTP or HTTPS (a CONNECT proxy) or DIRECT. */
export function pacChoice(answer: string): { proxy?: URL; direct?: true; socks?: true } {
  let socks = false;
  for (const raw of answer.split(";")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (/^DIRECT$/i.test(entry)) return { direct: true };
    const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(entry);
    if (match?.[1] && match[2]) {
      const url = proxyUrl(
        `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`,
      );
      if (url) return { proxy: url };
      continue;
    }
    if (/^SOCKS[45]?\s/i.test(entry)) socks = true;
  }
  return socks ? { socks: true } : {};
}

function download(url: URL, signal: AbortSignal, redirects = REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    // A fresh agent with no proxy settings: the PAC file is fetched directly, never through the
    // proxy it describes or one from the environment.
    const options = {
      signal,
      agent: secure ? new HttpsAgent() : new HttpAgent(),
      timeout: FETCH_MS,
    };
    const done = (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume();
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return reject(new Error("pac_redirect_invalid"));
        }
        if (next.protocol !== "http:" && next.protocol !== "https:")
          return reject(new Error("pac_redirect_invalid"));
        return download(next, signal, redirects - 1).then(resolve, reject);
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error("pac_status"));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PAC_LIMIT) {
          response.destroy(new Error("pac_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    };
    const request = secure ? httpsGet(url, options, done) : httpGet(url, options, done);
    request.once("timeout", () => request.destroy(new Error("pac_timeout")));
    request.once("error", reject);
  });
}

async function pacScript(url: URL, signal: AbortSignal) {
  if (url.protocol === "file:") {
    const path = fileURLToPath(url);
    if ((await stat(path)).size > PAC_LIMIT) throw new Error("pac_too_large");
    return readFile(path, { encoding: "utf8", signal });
  }
  if (url.protocol === "http:" || url.protocol === "https:") return download(url, signal);
  throw new Error("pac_scheme_unsupported");
}

/**
 * One PAC source for the runner's lifetime. The script is re-fetched after a short cache, so a
 * reconnect follows a changed PAC file; concurrent connection attempts share one fetch.
 */
export function pacResolver(
  location: string,
  note: (word: PacNote) => void,
  engine: PacEngine = createPacEngine(),
) {
  let cached: { at: number; script: Promise<string> } | undefined;
  const script = () => {
    if (!cached || performance.now() - cached.at > CACHE_MS) {
      const pending = (async () => {
        const url = new URL(location);
        return pacScript(url, AbortSignal.timeout(FETCH_MS));
      })();
      const entry = { at: performance.now(), script: pending };
      cached = entry;
      // A failed fetch is retried on the next connection attempt, not cached for a minute.
      pending.catch(() => {
        if (cached === entry) cached = undefined;
      });
    }
    return cached.script;
  };
  return async (target: string): Promise<URL | undefined> => {
    try {
      const url = new URL(target);
      // PAC scripts are written for http(s) URLs; the relay's ws(s) address is asked as such, and
      // only up to the host (as browsers do for https): the path and query carry room tickets,
      // which an untrusted script could otherwise leak through the names it asks DNS for.
      const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
      const asked = `${scheme}//${url.host}/`;
      const choice = pacChoice(await engine.find(await script(), asked, url.hostname));
      if (choice.proxy) return choice.proxy;
      if (choice.socks) note("pac_socks_unsupported");
      else if (!choice.direct) note("pac_failed");
      return undefined;
    } catch {
      note("pac_failed");
      return undefined;
    }
  };
}
