import type { Writable } from "node:stream";
import { ExecError, type ExecRedactor } from "../core/types.ts";
import { LoginHints, PermissionErrors, SandboxDenials } from "./output-notices.ts";
import { OutputProgress } from "./output-progress.ts";

/** Retain a bounded head/tail while the redacted stream goes to the log owner. */
export class CommandOutput {
  readonly progress = new OutputProgress();
  readonly permissionErrors = new PermissionErrors();
  /** pnpm and others print EPERM on stdout, so both channels feed this. */
  readonly denials = new SandboxDenials();
  /** A CLI said it found no login; both channels, any exit code. */
  readonly loginHints = new LoginHints();
  private head = "";
  private tail = "";
  private total = 0;
  private resultLine = "";
  private resultOffset = 0;
  private readonly resultLines: { offset: number; text: string }[] = [];
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed = false;
  constructor(
    private readonly log: Writable,
    private readonly onOutput: ((text: string) => void) | undefined,
    private readonly onFailure: () => void,
  ) {
    log.on("error", () => {
      this.failed = true;
      onFailure();
    });
  }
  channel(redactor: ExecRedactor, stderr = false, observe?: (text: string) => void) {
    const stream = redactor.stream();
    const append = (text: string) => {
      if (stderr) this.permissionErrors.push(text);
      observe?.(text);
      this.denials.push(text);
      this.loginHints.push(text);
      return this.append(text);
    };
    return {
      push: (text: string) => append(stream.push(text)),
      finish: () => append(stream.finish()),
    };
  }
  dispose() {
    clearTimeout(this.timer);
    this.pending = "";
  }
  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.pending;
    this.pending = "";
    if (!text || !this.onOutput) return;
    try {
      this.onOutput(text);
    } catch {
      this.failed = true;
      this.onFailure();
    }
  }
  private append(text: string): boolean {
    if (!text || this.failed) return true;
    this.progress.push(text);
    let consumed = 0;
    for (const piece of text.split(/(?<=\n)/)) {
      consumed += piece.length;
      this.resultLine = (this.resultLine + piece).slice(0, 1200);
      if (!piece.endsWith("\n")) continue;
      if (/error|fail|✗|失败|错误|[^\s:]+:\d+:\d+/iu.test(this.resultLine)) {
        this.resultLines.push({ offset: this.resultOffset, text: this.resultLine.trimEnd() });
        if (this.resultLines.length > 120) this.resultLines.shift();
      }
      this.resultOffset = this.total + consumed;
      this.resultLine = "";
    }
    this.total += text.length;
    this.head = (this.head + text.slice(0, 15_000)).slice(0, 15_000);
    this.tail = (this.tail + text).slice(-15_000);
    // UI is a live tail; disk retention is controlled separately by the log owner.
    this.pending = (this.pending + text).slice(-64 * 1024);
    this.timer ??= setTimeout(() => this.flush(), 100);
    return this.log.write(text);
  }
  async finish() {
    this.flush();
    await new Promise<void>((resolve, reject) => {
      if (this.failed) {
        this.log.destroy();
        reject(new ExecError("output_failed"));
        return;
      }
      this.log.once("error", () => reject(new ExecError("output_failed")));
      this.log.end(resolve);
    });
    if (this.failed) throw new ExecError("output_failed");
    return this.snapshot();
  }
  snapshot() {
    if (this.total <= 15_000) return this.head;
    if (this.total <= 30_000) return this.head + this.tail.slice(15_000 - this.total);
    const results: string[] = [];
    let resultChars = 0;
    for (const line of this.resultLines) {
      if (line.offset < 15000 || line.offset >= this.total - 15000 || results.length >= 60)
        continue;
      const text = line.text.slice(0, Math.max(0, 6000 - resultChars));
      if (!text) break;
      results.push(text);
      resultChars += text.length + 1;
    }
    const selected = results.length
      ? `\n[中间的结果行 / Result lines from omitted middle]\n${results.join("\n")}\n`
      : "";
    let keep = 15_000;
    let marker = "";
    for (let pass = 0; pass < 3; pass++) {
      marker = `\n[省略 ${this.total - keep * 2} 字符 / characters omitted]\n`;
      keep = Math.floor((30_000 - marker.length - selected.length) / 2);
    }
    return this.head.slice(0, keep) + marker + selected + this.tail.slice(-keep);
  }
}
