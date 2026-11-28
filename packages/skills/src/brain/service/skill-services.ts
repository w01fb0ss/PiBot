import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type BuiltinMethodsPort,
  type CapabilityContext,
  requireGroupMember,
} from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/skills-contract/full";
import { AuditRepo, BackgroundTaskHealthRepo } from "@pibot/storage";
import { SharedSkillPackages } from "./shared-packages.ts";
import { SkillRuntimeService } from "./skill-runtime.ts";
import { SkillService } from "./skill-service.ts";

/**
 * One private store and an LRU of group stores. Group writes never reach the private store; for
 * reading in a run see `effectiveFor`.
 */
export class SkillServices {
  readonly skills: SkillService;
  readonly packages: SharedSkillPackages;
  /** One store of prepared runtimes for every skill of this Bot, groups included. */
  readonly runtime: SkillRuntimeService;
  private readonly groups = new Map<string, SkillService>();
  private readonly writes = new Map<
    string,
    { identity: string; promise: Promise<unknown>; settled: boolean }
  >();
  constructor(private readonly ctx: CapabilityContext) {
    this.packages = new SharedSkillPackages(ctx.dataDir, ctx.db, ctx.logger);
    this.runtime = new SkillRuntimeService({
      dataDir: ctx.dataDir,
      platform: process.platform,
      arch: process.arch,
      proxy: ctx.local.deps.proxy,
      redact: (text) => ctx.redactor.redact(text),
      emit: (target, status, progress) =>
        ctx.peer.emit("skills.runtimeProgress", {
          ...(target.groupId ? { groupId: target.groupId } : {}),
          skillId: target.skillId,
          state: status.state,
          runtime: status.runtime,
          ...progress,
        }),
      local: ctx.local,
      logger: ctx.logger,
      // Audited through the same repository as every other skill change: preparing a runtime runs
      // third-party code, so it has to be explainable after the fact.
      audit: (input): void => {
        new AuditRepo(ctx.db, ctx.redactor).append({
          botId: input.botId,
          kind: "skill.runtime.prepared",
          summary:
            input.result === "approved"
              ? "Approved skill runtime installation without isolation / 已确认在无隔离的情况下安装技能运行环境"
              : "Skill runtime prepared / 技能运行环境",
          detail: {
            target: input.skillName.slice(0, 200),
            ...(input.groupId ? { groupId: input.groupId } : {}),
            skillRuntime: {
              skillId: input.skillId,
              runtime: input.runtime,
              packages: input.packages,
              result: input.result,
              ...(input.planHash ? { planHash: input.planHash } : {}),
              ...(input.mirror ? { mirror: true } : {}),
              ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
            },
          },
        });
        // Repeated failed preparations (no uv, an install error) were only in the log;
        // a streak lets the inbox say it once instead of nobody noticing it for days.
        const health = new BackgroundTaskHealthRepo(ctx.db, () =>
          ctx.peer.emit("inbox.changed", {}),
        );
        if (input.result === "failed")
          health.fail("skill_runtime", input.skillId, input.reasonCode ?? "install_failed");
        else if (input.result === "ready") health.recover("skill_runtime", input.skillId);
      },
    });
    this.skills = new SkillService({
      packages: this.packages,
      ...ctx,
      roleSkillLabels: (botId, name, description) =>
        ctx.ports
          ?.get<BuiltinMethodsPort>("builtin-methods")
          ?.skillLabels?.(botId, undefined, name, description),
      builtinMethods: (botId, language) =>
        ctx.ports
          ?.get<BuiltinMethodsPort>("builtin-methods")
          ?.methods(botId, undefined, language) ?? [],
    });
  }
  /**
   * The skills a member actually uses in a group. Groups made from templates
   * copied every member's skills into the member's own store only, so members ran with none.
   * A member now uses the skills this group set for it and, until the group sets any (even a
   * disabled one, or an edited, disabled or deleted built-in method), its own Bot
   * skills — read-only from here; group imports and edits still go to the group store. One
   * indexed single-row lookup per call, no model turn and no file read.
   */
  effectiveFor(botId: string, groupId?: string): SkillService {
    if (!groupId) return this.skills;
    const group = this.skillsFor(groupId);
    group.activeBot(botId);
    return group.builtins.repo.hasOwn(botId) ? group : this.skills;
  }
  skillsFor(groupId?: string): SkillService {
    if (!groupId) return this.skills;
    requireGroupMember(this.ctx, groupId);
    let skills = this.groups.get(groupId);
    if (!skills) {
      if (this.groups.size >= 32) {
        for (const [id, entry] of this.groups) {
          if (!entry.canRelease) continue;
          entry.imports.dispose();
          entry.uploads.dispose();
          this.groups.delete(id);
          break;
        }
        if (this.groups.size >= 32) throw new RpcError(RpcErrorCodes.busy, "group_skills_busy");
      }
      skills = new SkillService(
        {
          ...this.ctx,
          dataDir: join(this.ctx.dataDir, "groups", groupId),
          packages: this.packages,
          roleSkillLabels: (botId, name, description) =>
            this.ctx.ports
              ?.get<BuiltinMethodsPort>("builtin-methods")
              ?.skillLabels?.(botId, groupId, name, description),
          builtinMethods: (botId, language) =>
            this.ctx.ports
              ?.get<BuiltinMethodsPort>("builtin-methods")
              ?.methods(botId, groupId, language) ?? [],
        },
        groupId,
        // The background sync normally installed them already; a group created since has not.
        (botId) =>
          (skills as SkillService).builtins.installAll(
            botId,
            AbortSignal.any([this.ctx.local.shutdown.signal, AbortSignal.timeout(25_000)]),
          ),
      );
    }
    this.groups.delete(groupId);
    this.groups.set(groupId, skills);
    return skills;
  }
  /**
   * Keeps an interactive write's result for safe timeout reconciliation. The digest binds a
   * request id to one exact method/scope/payload without retaining skill text or contract data.
   */
  idempotentWrite<T>(
    requestId: string,
    input: unknown,
    signal: AbortSignal,
    action: (queueSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const identity = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.writes.get(requestId);
    if (existing) {
      if (existing.identity !== identity)
        throw new RpcError(RpcErrorCodes.invalidParams, "skill_request_mismatch");
      return existing.promise.catch((error) => {
        // A retry that arrived after the first caller timed out may replace only a write that was
        // cancelled before entering SkillService's serialized section.
        if (error instanceof DOMException && error.name === "AbortError" && !signal.aborted)
          return this.idempotentWrite(requestId, input, signal, action);
        throw error;
      }) as Promise<T>;
    }
    if (this.writes.size >= 256) {
      for (const [id, receipt] of this.writes) {
        if (!receipt.settled) continue;
        this.writes.delete(id);
        if (this.writes.size < 256) break;
      }
      if (this.writes.size >= 256) throw new RpcError(RpcErrorCodes.busy, "skill_requests_busy");
    }
    const receipt = { identity, promise: Promise.resolve() as Promise<unknown>, settled: false };
    const promise = action(signal).then(
      (result) => {
        receipt.settled = true;
        return result;
      },
      (error) => {
        if (this.writes.get(requestId) === receipt) this.writes.delete(requestId);
        throw error;
      },
    );
    receipt.promise = promise;
    this.writes.set(requestId, receipt);
    return promise;
  }
  async stop() {
    const services = [this.skills, ...this.groups.values()];
    for (const service of services) {
      service.imports.dispose();
      service.uploads.dispose();
    }
    await Promise.all(services.map((service) => service.settled()));
    this.writes.clear();
    this.groups.clear();
  }
}
