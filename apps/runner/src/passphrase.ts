import { StringDecoder } from "node:string_decoder";
import { runnerText } from "./messages.ts";
import type { RunnerRedactor } from "./redactor.ts";

export function takeEnvironmentPassphrase(redactor: RunnerRedactor) {
  const value = process.env.PIBOT_RUNNER_PASSPHRASE;
  delete process.env.PIBOT_RUNNER_PASSPHRASE;
  if (value) redactor.add(value);
  return value;
}

export async function readPassphrase(
  creating: boolean,
  signal: AbortSignal,
  redactor: RunnerRedactor,
) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("passphrase_required");
  if (creating)
    process.stderr.write(
      `${runnerText(
        "请创建一个口令来保护这台电脑上的配对信息。以后启动时可能需要输入。若忘记口令，请用新的数据目录启动，并重新配对。",
        "Create a passphrase to protect the pairing details on this computer. You may need it at startup. If you forget it, start with a fresh data folder and pair again.",
      )}\n`,
    );
  const value = await prompt(runnerText("口令：", "Passphrase: "), signal, redactor);
  if (creating) {
    const confirmation = await prompt(
      runnerText("再输一次口令：", "Repeat passphrase: "),
      signal,
      redactor,
    );
    if (value !== confirmation) throw new Error("passphrase_mismatch");
  }
  return value;
}

async function prompt(label: string, signal: AbortSignal, redactor: RunnerRedactor) {
  const input = process.stdin;
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    let raw = false;
    const decoder = new StringDecoder("utf8");
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      if (raw) input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else if (!value) reject(new Error("passphrase_required"));
      else {
        try {
          redactor.add(value);
          resolve(value);
        } catch (redactorError) {
          reject(redactorError);
        }
      }
    };
    const onAbort = () => finish(signal.reason);
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error("cancelled"));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) value = Array.from(value).slice(0, -1).join("");
        else if (value.length < 4096) value += decoder.write(Buffer.from([byte]));
      }
    };
    input.on("data", onData);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return finish(signal.reason);
    try {
      input.setRawMode(true);
      raw = true;
      process.stderr.write(label);
      input.resume();
    } catch (error) {
      finish(error);
    }
  });
}
