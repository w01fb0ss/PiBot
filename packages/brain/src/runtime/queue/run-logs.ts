import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { commandLogRoot, sameFile } from "@pibot/execution";
import { IdSchema, type KernelMethodParams, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ToolCallsRepo } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { LocalDependencies } from "../../core/local-types.ts";
import { pruneCommandLogs } from "./command-log-retention.ts";

const MAX_LOG = 5 * 1024 * 1024;
const MAX_PAGE = 256 * 1024;
// Find a byte boundary without decoding an incomplete final code point.
function boundary(bytes: Buffer, position: number): number {
  while (position > 0 && position < bytes.length && ((bytes[position] ?? 0) & 0xc0) === 0x80)
    position--;
  if (position === bytes.length && position > 0) {
    let lead = position - 1;
    while (lead > 0 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) lead--;
    const byte = bytes[lead] ?? 0;
    const width = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
    if (position - lead < width) return lead;
  }
  return position;
}
export class RunLogs {
  private readonly pending = new Set<Promise<unknown>>();
  private pruning: Promise<void> = Promise.resolve();
  prune(botId: string) {
    const task = this.pruning.then(() =>
      this.operation((signal) => pruneCommandLogs(this.deps, botId, signal)),
    );
    this.pruning = task.catch(() => {
      if (!this.shutdown.aborted)
        this.deps.logger.warn(
          JSON.stringify({ module: "command-logs", event: "retention_deferred", botId }),
        );
    });
    return this.pruning;
  }
  isIdle() {
    return this.pending.size === 0;
  }
  constructor(
    private readonly deps: LocalDependencies,
    private readonly tools: Pick<ToolCallsRepo, "getLogPath" | "runBot">,
    private readonly shutdown: AbortSignal,
  ) {}
  private signal(parent?: AbortSignal) {
    return AbortSignal.any([
      this.shutdown,
      AbortSignal.timeout(20_000),
      ...(parent ? [parent] : []),
    ]);
  }
  private async checked(runId: string, toolCallId: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    const botId = this.tools.runBot(runId);
    const stored = this.tools.getLogPath(runId, toolCallId);
    if (!botId || !stored) throw new RpcError(RpcErrorCodes.runLogMissing, "run_log_missing");
    const base = await realpath(this.deps.dataDir);
    const name = basename(stored);
    const layouts = (data: string) => {
      const home = join(data, "bots", botId, "home");
      return [commandLogRoot(home), join(home, ".pibot")].flatMap((path) => [
        join(path, "runs", `${runId}.log`),
        ...(name.endsWith(".log") && IdSchema.safeParse(name.slice(0, -4)).success
          ? [join(path, "background", name)]
          : []),
      ]);
    };
    const canonical = layouts(base);
    const configured = layouts(resolve(this.deps.dataDir));
    const path = canonical.find(
      (candidate, index) => candidate === resolve(stored) || configured[index] === resolve(stored),
    );
    if (!path || (await realpath(path)) !== path)
      throw new RpcError(RpcErrorCodes.runLogInvalid, "run_log_invalid");
    const root = dirname(path);
    // Exact (bigint) identity: number stats round NTFS file IDs and can alias two files.
    const info = await stat(path, { bigint: true });
    if (!info.isFile()) throw new RpcError(RpcErrorCodes.runLogInvalid, "run_log_invalid");
    signal.throwIfAborted();
    return { root, path, info };
  }
  private async operation<T>(action: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal) {
    const signal = this.signal(parent);
    const pending = action(signal);
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    try {
      return await abortable(pending, signal);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (signal.aborted)
        throw new RpcError(
          signal.reason instanceof Error && signal.reason.name === "TimeoutError"
            ? RpcErrorCodes.timeout
            : RpcErrorCodes.closed,
          "run_log_cancelled",
        );
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        throw new RpcError(RpcErrorCodes.runLogMissing, "run_log_missing");
      // Filesystem errors contain absolute paths; keep them out of RPC and logs.
      throw new RpcError(RpcErrorCodes.runLogInvalid, "run_log_unavailable");
    }
  }
  read(
    { runId, toolCallId, offset = 0, limit = MAX_PAGE }: KernelMethodParams["runs.readLog"],
    parent?: AbortSignal,
  ) {
    return this.operation(async (signal) => {
      const { path, info } = await this.checked(runId, toolCallId, signal);
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        signal.throwIfAborted();
        const opened = await handle.stat({ bigint: true });
        if (!sameFile(opened, info) || (await realpath(path)) !== path)
          throw new RpcError(RpcErrorCodes.runLogInvalid, "run_log_changed");
        const size = Number(opened.size);
        // Redact the entire bounded prefix before paging: a newly registered key may
        // straddle two pages. Offsets refer to the redacted UTF-8 view, not raw bytes.
        const bytes = Buffer.alloc(Math.min(size, MAX_LOG));
        let length = 0;
        while (length < bytes.length) {
          signal.throwIfAborted();
          const result = await handle.read(bytes, length, bytes.length - length, length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        let truncated = size > MAX_LOG;
        const complete = boundary(bytes, length);
        const stream = this.deps.redactor.stream();
        const safe =
          stream.push(bytes.subarray(0, complete).toString("utf8")) +
          (truncated ? "" : stream.finish());
        const view = Buffer.from(safe);
        truncated ||= view.length > MAX_LOG;
        const endOfView = boundary(view, Math.min(view.length, MAX_LOG));
        if (offset > endOfView || boundary(view, offset) !== offset)
          throw new RpcError(RpcErrorCodes.invalidParams, "run_log_offset_invalid");
        let end = boundary(view, Math.min(offset + limit, endOfView));
        if (end === offset && end < endOfView)
          throw new RpcError(RpcErrorCodes.invalidParams, "run_log_limit_too_small");
        const newline = view.lastIndexOf(10, end - 1);
        if (end < endOfView && newline >= offset) end = newline + 1;
        signal.throwIfAborted();
        return {
          text: view.subarray(offset, end).toString("utf8"),
          offset,
          nextOffset: end < endOfView ? end : null,
          totalBytes: size,
          truncated,
        };
      } finally {
        await handle.close();
      }
    }, parent);
  }
  private show(
    runId: string,
    toolCallId: string | undefined,
    reveal: boolean,
    parent?: AbortSignal,
  ) {
    return this.operation(async (signal) => {
      const { path, root } = await this.checked(runId, toolCallId, signal);
      const show = reveal ? this.deps.host.revealPath : this.deps.host.openPath;
      if (!show) throw new RpcError(RpcErrorCodes.unsupported, "run_log_host_unsupported");
      await abortable(show({ path, allowedRoots: [root] }, signal), signal);
      return { ok: true as const };
    }, parent);
  }
  async dispose() {
    await this.pruning;
    // The RPC wait may end before an OS read does; drain the actual handle owner.
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  open(runId: string, toolCallId?: string, parent?: AbortSignal) {
    return this.show(runId, toolCallId, false, parent);
  }
  reveal(runId: string, toolCallId?: string, parent?: AbortSignal) {
    return this.show(runId, toolCallId, true, parent);
  }
}
