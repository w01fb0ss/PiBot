import { UnsafeSandboxEnvironmentError } from "@pibot/execution/host-environment";

import { isRunnerMessageCode, type RunnerMessageCode, runnerMessages } from "./messages.ts";

type RunnerFailure = {
  code: RunnerMessageCode;
  messageZh: string;
  messageEn: string;
  variables?: UnsafeSandboxEnvironmentError["variables"];
};

function message(code: RunnerMessageCode): RunnerFailure {
  const { zh, en } = runnerMessages[code];
  return { code, messageZh: zh, messageEn: en };
}

export function runnerFailure(error: unknown): RunnerFailure {
  if (error instanceof UnsafeSandboxEnvironmentError) {
    const reasons = error.variables.map((name) =>
      name === "SRT_DEBUG"
        ? { zh: `${name} 可能输出命令原文`, en: `${name} can log raw commands` }
        : {
            zh: `${name} 会覆盖受保护的临时目录`,
            en: `${name} overrides the protected temporary directory`,
          },
    );
    const names = error.variables.join(", ");
    return {
      code: "unsafe_sandbox_environment",
      variables: error.variables,
      messageZh: `执行端拒绝启动：${reasons.map(({ zh }) => zh).join("；")}。请从启动终端或服务的环境配置中移除 ${names}，再启动执行端。`,
      messageEn: `Runner refused to start: ${reasons.map(({ en }) => en).join("; ")}. Remove ${names} from the launching shell or service environment, then start the runner again.`,
    };
  }
  if (error instanceof Error && isRunnerMessageCode(error.message)) return message(error.message);
  // The runtime puts the startup failure first and still reports cleanup failures separately.
  if (error instanceof AggregateError) {
    const primary = runnerFailure(error.errors[0]);
    return primary.code === "internal" ? message("lifecycle_failed") : primary;
  }
  return message("internal");
}

export function runnerErrorCode(error: unknown): string {
  return runnerFailure(error).code;
}

/** Permanent service configuration errors must not restart forever; failed drain still wins. */
export function runnerExitCode(error: unknown): number {
  return runnerFailure(error).code === "unsafe_sandbox_environment" ? 78 : 1;
}
