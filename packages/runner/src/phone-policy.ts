import { createHash } from "node:crypto";
import {
  RpcError,
  RpcErrorCodes,
  type RunnerPolicyPreparation,
  RunnerPolicyPreparationSchema,
  RunnerPreparedFactsSchema,
} from "@pibot/protocol-base";

type Facts = ReturnType<typeof RunnerPreparedFactsSchema.parse>;
export type PolicyFactSource = (
  input: RunnerPolicyPreparation,
  signal: AbortSignal,
) => Promise<Facts>;
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");

/** Session-scoped, one-use preparation. A delayed confirmation cannot authorize changed inputs. */
export function phonePolicyFacts(targetId: string, source?: PolicyFactSource) {
  const pending = new Map<
    string,
    { input: RunnerPolicyPreparation; hash: string; expiresAt: number; windowsReadOnly: boolean }
  >();
  const active = new Map<
    string,
    { input: RunnerPolicyPreparation; hash: string; expiresAt: number }
  >();
  const refused = (): never => {
    throw new RpcError(RpcErrorCodes.dispatchDenied, "policy_preparation_changed");
  };
  return {
    async prepare(raw: unknown, signal: AbortSignal) {
      const input = RunnerPolicyPreparationSchema.parse(raw);
      if (!source) throw new RpcError(RpcErrorCodes.unsupported, "phone_policy_unsupported");
      if (
        input.context.boundary.location?.target !== targetId ||
        input.context.boundary.readonlySource ||
        input.context.boundary.roots.some((r) => r.role === "writable")
      )
        return refused();
      for (const [id, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(id);
      if (pending.size >= 32 || pending.has(input.opId) || active.has(input.opId))
        throw new RpcError(RpcErrorCodes.busy, "policy_preparation_busy");
      const facts = RunnerPreparedFactsSchema.parse(await source(input, signal));
      if (Buffer.byteLength(JSON.stringify(facts)) > 600_000)
        throw new RpcError(RpcErrorCodes.busy, "policy_facts_capacity");
      signal.throwIfAborted();
      pending.set(input.opId, {
        input,
        hash: digest(facts),
        expiresAt: Date.now() + 120_000,
        windowsReadOnly:
          facts.result.reason === "windows_read_only" && facts.result.windowsReadOnly === true,
      });
      return facts;
    },
    claim(
      opId: string | undefined,
      request: RunnerPolicyPreparation["request"],
      file: {
        writeRoots: readonly string[];
        denyWriteRoots?: readonly string[];
        rootIdentities?: readonly unknown[];
        network?: unknown;
        allowUnisolated?: boolean;
        secretEnv?: unknown;
        pathEntries?: unknown;
        homeDir?: unknown;
        skillGroupId?: unknown;
        gitEntryPlanId?: unknown;
        windowsReadOnly?: unknown;
      },
    ) {
      const held = opId ? pending.get(opId) : undefined;
      if (opId) pending.delete(opId);
      if (!held || held.expiresAt <= Date.now() || digest(held.input.request) !== digest(request))
        return refused();
      const roots = held.input.context.boundary;
      const identities = roots.roots.map((r) => ({
        canonicalPath: r.canonicalPath,
        device: r.device,
        inode: r.inode,
        role: r.role,
      }));
      if (
        digest(file.writeRoots) !== digest(roots.writeRoots) ||
        digest(file.denyWriteRoots ?? []) !== digest(roots.denyWriteRoots) ||
        digest(file.rootIdentities) !== digest(identities)
      )
        return refused();
      if (
        request.category === "run_command" &&
        (digest(file.network) !== digest(held.input.context.settings.network) ||
          file.allowUnisolated !== (roots.location?.platform === "win32") ||
          file.secretEnv !== undefined ||
          file.pathEntries !== undefined ||
          file.homeDir !== undefined ||
          file.skillGroupId !== undefined ||
          file.gitEntryPlanId !== undefined ||
          file.windowsReadOnly !== undefined)
      )
        return refused();
      active.set(opId as string, held);
      return held.windowsReadOnly;
    },
    async assert(opId: string, signal: AbortSignal) {
      const held = active.get(opId);
      if (!held || !source || held.expiresAt <= Date.now()) return refused();
      const current = RunnerPreparedFactsSchema.parse(await source(held.input, signal));
      if (digest(current) !== held.hash || current.result.decision === "deny") refused();
    },
    release(opId?: string) {
      if (opId) active.delete(opId);
    },
    dispose() {
      pending.clear();
      active.clear();
    },
  };
}
