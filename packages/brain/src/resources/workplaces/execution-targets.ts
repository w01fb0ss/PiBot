import type { ExecutionTarget } from "@pibot/execution";
import { type ExecutionLocationTarget, RpcError, RpcErrorCodes } from "@pibot/protocol-base";

export interface RegisteredExecutionTarget {
  target: ExecutionTarget;
  platform: "darwin" | "linux" | "win32";
  name: string;
  pairedDeviceId: string;
}
/** The connection owner disposes targets; deregistration closes admission immediately. */
export class ExecutionTargets {
  private readonly entries = new Map<string, RegisteredExecutionTarget>();
  register(id: ExecutionLocationTarget, entry: RegisteredExecutionTarget) {
    if (!id.startsWith("runner:") || this.entries.has(id))
      throw new RpcError(RpcErrorCodes.busy, "runner_target_busy");
    this.entries.set(id, entry);
    return () => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    };
  }
  /** Presentation only; callers needing authority still use require and freeze the entry. */
  get(id: string): RegisteredExecutionTarget | undefined {
    return this.entries.get(id);
  }
  require(id: string): RegisteredExecutionTarget {
    const entry = this.entries.get(id);
    if (!entry) throw new RpcError(RpcErrorCodes.closed, "runner_target_offline");
    return entry;
  }
}
