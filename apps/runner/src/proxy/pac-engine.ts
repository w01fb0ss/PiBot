// Evaluates an untrusted PAC script in QuickJS compiled to WebAssembly. node:vm shares the runner's
// process and is no security boundary; this VM has no filesystem, network, process or timers, a
// memory cap and an instruction deadline, and its only host calls answer from prepared values.
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";
import { QuickJS } from "quickjs-wasi";
import { PAC_HELPERS } from "./pac-helpers.ts";

const MEMORY_LIMIT = 32 * 1024 * 1024;
const EVAL_MS = 1000;
const DNS_MS = 2000;
const DNS_ROUNDS = 3;
const DNS_HOSTS = 16;

/** The binary ships beside the single executable; from source it is the package's own copy. */
async function wasmBytes() {
  return readFile(
    isSea()
      ? join(dirname(process.execPath), "resources", "quickjs.wasm")
      : fileURLToPath(import.meta.resolve("quickjs-wasi/quickjs.wasm")),
  );
}

/** Host DNS for the PAC functions, bounded so a dead resolver cannot hold a connection attempt. */
export type PacResolve = (host: string) => Promise<string | null>;
export const resolveIPv4: PacResolve = async (host) => {
  try {
    const result = await lookup(host, { family: 4, signal: AbortSignal.timeout(DNS_MS) } as never);
    return result.address;
  } catch {
    // An unresolvable name is an ordinary PAC answer (isResolvable() false), not a failure.
    return null;
  }
};

export function localIPv4() {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return "127.0.0.1";
}

export interface PacEngine {
  /** FindProxyForURL(url, host) of `script`, as the raw string it returned. */
  find(script: string, url: string, host: string): Promise<string>;
}

export function createPacEngine(options: { resolve?: PacResolve; myIp?: () => string } = {}) {
  let module: Promise<WebAssembly.Module> | undefined;
  const resolve = options.resolve ?? resolveIPv4;
  const myIp = options.myIp ?? localIPv4;
  const compiled = () => {
    module ??= wasmBytes().then((bytes) => WebAssembly.compile(bytes));
    // A failed load may succeed on the next attempt (e.g. a transient read error).
    module.catch(() => {
      module = undefined;
    });
    return module;
  };

  async function once(
    script: string,
    url: string,
    host: string,
    answers: ReadonlyMap<string, string | null>,
    misses: Set<string>,
    ip: string,
  ) {
    const deadline = performance.now() + EVAL_MS;
    const vm = await QuickJS.create({
      wasm: await compiled(),
      memoryLimit: MEMORY_LIMIT,
      interruptHandler: () => performance.now() > deadline,
      // The guest has no console; QuickJS's own diagnostics must not reach the runner's output.
      wasi: (memory) => ({
        fd_write(_fd: number, iovs: number, count: number, written: number) {
          const view = new DataView(memory.buffer);
          let total = 0;
          for (let i = 0; i < count; i++) total += view.getUint32(iovs + i * 8 + 4, true);
          view.setUint32(written, total, true);
          return 0;
        },
      }),
    });
    try {
      const resolver = vm.newFunction("__pibotResolve", (name) => {
        const key = name?.isString ? name.toString().toLowerCase() : "";
        if (answers.has(key)) {
          const value = answers.get(key);
          return value ? vm.newString(value) : vm.null;
        }
        if (key && misses.size < DNS_HOSTS) misses.add(key);
        return vm.null;
      });
      vm.setProp(vm.global, "__pibotResolve", resolver);
      resolver.dispose();
      const address = vm.newString(ip);
      vm.setProp(vm.global, "__pibotMyIp", address);
      address.dispose();
      vm.evalCode(PAC_HELPERS, "pac-helpers.js").dispose();
      vm.evalCode(script, "proxy.pac").dispose();
      const find = vm.global.getProp("FindProxyForURL");
      try {
        if (!find.isFunction) throw new Error("pac_no_function");
        const urlArg = vm.newString(url);
        const hostArg = vm.newString(host);
        const result = vm.callFunction(find, vm.undefined, urlArg, hostArg);
        urlArg.dispose();
        hostArg.dispose();
        try {
          // Never let a returned object run guest toString(): only a real string is an answer.
          if (!result.isString) throw new Error("pac_bad_result");
          return result.toString().slice(0, 4096);
        } finally {
          result.dispose();
        }
      } finally {
        find.dispose();
      }
    } finally {
      vm.dispose();
    }
  }

  return {
    /**
     * PAC functions are synchronous, but DNS here is not: each round answers the names the script
     * asked for in the previous one (host DNS with a timeout), until it asks for nothing new.
     */
    async find(script, url, host) {
      const answers = new Map<string, string | null>();
      const ip = myIp();
      for (let round = 0; ; round++) {
        const misses = new Set<string>();
        const result = await once(script, url, host, answers, misses, ip);
        if (!misses.size || round + 1 >= DNS_ROUNDS) return result;
        await Promise.all(
          [...misses].map(async (name) => {
            answers.set(name, await resolve(name));
          }),
        );
      }
    },
  } satisfies PacEngine;
}
