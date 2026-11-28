import { isAbsolute, relative, sep } from "node:path";
import type {
  BrainCapability,
  BuiltinMethodsPort,
  RegisterRpc,
  SkillsPort,
} from "@pibot/brain/kit";
import { abortable } from "@pibot/brain/kit";
import { skillReferenceTools } from "@pibot/skills-contract";
import { RpcError, RpcErrorCodes, withProgressDeadline } from "@pibot/skills-contract/full";
import { skillsEn, skillsZh } from "@pibot/skills-contract/i18n";
import { BotsRepo } from "@pibot/storage";
import { SkillLinks } from "./links/skill-links.ts";
import { PluginSkillHost } from "./plugin-skills.ts";
import { copyImportedSkill } from "./service/imported-skill-copy.ts";
import { planMethodKeys } from "./service/plan-method-keys.ts";
import {
  bringOverSkill,
  registerSkillCatalogRpc,
  SkillCatalogRepo,
} from "./service/skill-catalog.ts";
import { readSkillReference } from "./service/skill-reference.ts";
import { registerSkillRpc } from "./service/skill-rpc.ts";
import { SkillServices } from "./service/skill-services.ts";
import { SkillUpdates } from "./service/skill-updates.ts";
import {
  findWorkflow,
  registerWorkflowRpc,
  workflowForFiles,
  workflowSkill,
} from "./service/skill-workflows.ts";
import { createTeach, registerTeachRpc } from "./teach/teach-rpc.ts";

export function skillsCapability(): BrainCapability {
  return {
    id: "skills",
    async register(ctx) {
      const mainBot = new BotsRepo(ctx.db).getMain();
      if (!mainBot) throw new Error("Main Bot missing before skills start");
      const services = new SkillServices(ctx);
      const shutdown = new AbortController();
      const signal = AbortSignal.any([shutdown.signal, ctx.local.shutdown.signal]);
      const pending = new Set<Promise<unknown>>();
      let closed = false;
      const pluginSkills = new PluginSkillHost(`${ctx.dataDir}/plugin-skills`);
      const catalog = new SkillCatalogRepo(ctx.db);
      const track = <T>(action: () => Promise<T>): Promise<T> => {
        if (closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "skills_stopped"));
        const work = Promise.resolve().then(action);
        pending.add(work);
        void work
          .finally(() => pending.delete(work))
          .catch(() => {
            // The caller receives the failure; keep no detached rejection from bookkeeping.
          });
        return work;
      };
      ctx.tools.executor("skill_read", async (context, call, requestSignal) => {
        const { name } = skillReferenceTools.skill_read.schema.parse(call.input);
        const text = await track(() =>
          readSkillReference(
            services.effectiveFor(context.botId, context.groupId),
            context.botId,
            name,
            context.language,
            AbortSignal.any([signal, requestSignal]),
          ),
        );
        return { text, untrustedContent: true };
      });
      const port: SkillsPort = {
        commandEntries(botId, groupId, requestSignal) {
          const service = services.effectiveFor(botId, groupId);
          const rows: { name: string; description: string }[] = [];
          let before: string | undefined;
          for (;;) {
            requestSignal.throwIfAborted();
            const page = service.list({ botId, enabled: true, builtin: false, limit: 50, before });
            rows.push(...page.filter((skill) => skill.botId === botId && skill.enabled));
            if (page.length < 50) return rows;
            before = page.at(-1)?.id;
          }
        },
        readReference: (botId, name, groupId, language, requestSignal) =>
          track(() =>
            readSkillReference(
              services.effectiveFor(botId, groupId),
              botId,
              name,
              language,
              AbortSignal.any([signal, requestSignal]),
            ),
          ),
        // A group's member gets the methods in the group's own skills too, so the
        // group tab lists and manages them; runs still follow the group override (see BuiltinSkillsRepo.hasOwn).
        ensureBuiltin: (botId, input, signal, groupId) =>
          track(() => services.skillsFor(groupId).builtins.install(botId, input, signal)),
        // Runs read the member's effective set; management RPCs keep the exact scope.
        copyAsOwn: (id, botId, signal, groupId) =>
          track(() => services.skillsFor(groupId).copyAsOwn(id, botId, signal)),
        root: (botId, groupId) => services.effectiveFor(botId, groupId).root(botId),
        roots: (botId, groupId) => services.effectiveFor(botId, groupId).roots(botId),
        packageIds: (botId, groupId) => services.effectiveFor(botId, groupId).packageIds(botId),
        commandRuntime: async (botId, groupId, paths, interpreter) => {
          if (!paths.length) return undefined;
          const effective = services.effectiveFor(botId, groupId);
          const matches = effective.repo.enabledForPrompt(botId).filter((record) => {
            if (record.packageId && !effective.packages.has(record.packageId)) return false;
            const { folder } = effective.runtimeTarget(record.id);
            return paths.some((path) => {
              const child = relative(folder, path);
              return child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
            });
          });
          const match = matches[0];
          if (!match) return undefined;
          const target = effective.runtimeTarget(match.id);
          const copies = matches.slice(1).map(({ id }) => effective.runtimeTarget(id));
          if (copies.length) {
            if (matches.some(({ id }) => effective.secretBindings(id).length))
              return { secretBindingsAmbiguous: true };
            if (copies.some(({ folder }) => relative(target.folder, folder))) return undefined;
          }
          // A single literal interpreter also covers extensionless scripts. For compound
          // commands, infer only when every recognized script in this skill uses the same runtime.
          const runtimes = new Set(
            paths
              .filter((path) => {
                const child = relative(target.folder, path);
                return (
                  child && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
                );
              })
              .flatMap((path) =>
                /\.pyw?$/i.test(path)
                  ? ["python" as const]
                  : /\.[cm]?js$/i.test(path)
                    ? ["node" as const]
                    : [],
              ),
          );
          const selected = interpreter ?? (runtimes.size === 1 ? [...runtimes][0] : undefined);
          let runtime = await services.runtime.commandRuntime(target, selected);
          if (copies.length) {
            for (const copy of copies) {
              if (!runtime?.missing) break;
              const candidate = await services.runtime.commandRuntime(copy, selected);
              if (candidate?.environment) runtime = candidate;
            }
            return matches.some(({ id }) => effective.secretBindings(id).length)
              ? { secretBindingsAmbiguous: true }
              : runtime;
          }
          const bindings = effective.secretBindings(match.id);
          return {
            ...runtime,
            ...(bindings.length
              ? {
                  secretBindings: {
                    folder: target.folder,
                    skillId: match.id,
                    name: match.name,
                    consent: {
                      zh: skillsZh["skills.secrets.approval"],
                      en: skillsEn["skills.secrets.approval"],
                    },
                    uses: bindings.map(({ variable, secretName }) => ({
                      variable,
                      name: secretName,
                      revision: ctx.local.userSecrets.metadata(secretName)?.revision ?? 0,
                    })),
                  },
                }
              : {}),
          };
        },
        commandSecretsCurrent: (botId, groupId, skillId, uses) => {
          const effective = services.effectiveFor(botId, groupId);
          const current = effective.repo.get(skillId);
          if (current?.botId !== botId || !current.enabled) return false;
          const bindings = effective.secretBindings(skillId);
          return (
            bindings.length === uses.length &&
            bindings.every(
              ({ variable, secretName }, index) =>
                uses[index]?.variable === variable && uses[index]?.name === secretName,
            )
          );
        },
        promptEntries: (botId, groupId, _language, requestSignal) =>
          track(async () => {
            const work = AbortSignal.any([signal, requestSignal]);
            await services.effectiveFor(botId, groupId).preparePromptPackages(botId, work);
            work.throwIfAborted();
            return services.effectiveFor(botId, groupId).promptEntries(botId);
          }),
        waitForPackageMaintenance: (requestSignal) =>
          abortable(maintenance, AbortSignal.any([signal, requestSignal])),
        copyImported: (...args) => track(() => copyImportedSkill(services, ...args)),
        markUsedAt: (botId, path, groupId) => {
          const service = services.effectiveFor(botId, groupId);
          const record = service.skillAt(botId, path);
          if (record) service.markUsed(record);
          return record?.name;
        },
        create: (...args) => track(() => services.skills.create(...args)),
        bringOver: (botId, folder, origin, requestSignal) =>
          track(() =>
            bringOverSkill(
              services,
              catalog,
              botId,
              folder,
              origin,
              AbortSignal.any([signal, requestSignal]),
            ),
          ),
        previewBringOver: (botId, folder, origin, requestSignal) =>
          track(() =>
            services.skills.imports.previewPath(
              botId,
              folder,
              "folder",
              AbortSignal.any([signal, requestSignal]),
              {
                rename: (name) => catalog.freeName(name),
                // One batch holds at most 100 keys (connections.previewBringOver), all previewed
                // before the person confirms; discovery runs one batch at a time.
                maxPending: 100,
                create: {
                  enabled: false,
                  afterInsert: (record) => catalog.setOrigin(record.id, origin),
                },
              },
            ),
          ),
        // A cancelled batch never reached the renderer with these ids, so it cannot send
        // `skills.cancelPreview` itself; the brain drops them and waits for the release here.
        cancelPreview: (previewId) =>
          track(() => services.skills.imports.cancel(previewId)).then(() => undefined),
        knownSkills: () => catalog.known(),
        freeSkillName: (name) => catalog.freeName(name),
        exportDocuments: (...args) => track(() => services.skills.exportDocuments(...args)),
        exportPackages: (botId, requestSignal, budget, options) =>
          track(() =>
            services.skills.exportPackages(
              botId,
              AbortSignal.any([signal, requestSignal]),
              budget,
              options,
            ),
          ),
        propose: (...args) => track(() => services.skills.proposals.propose(...args)),
        inventory: (botId, requestSignal, options) =>
          track(() =>
            services.skills.inventory(botId, AbortSignal.any([signal, requestSignal]), options),
          ),
        replace: (...args) => track(() => services.skills.replace(...args)),
        remove: (...args) => track(() => services.skills.removeOwn(...args)),
        workflowSkill: (botId, skillId, groupId) =>
          track(() => workflowSkill(services.effectiveFor(botId, groupId), botId, skillId)),
        findWorkflow: (botId, name, groupId) =>
          track(() => findWorkflow(services.effectiveFor(botId, groupId), botId, name)),
        planMethodKeys: (botId, groupId, requestSignal) =>
          track(() =>
            planMethodKeys(
              services.effectiveFor(botId, groupId),
              botId,
              AbortSignal.any([signal, requestSignal, AbortSignal.timeout(20_000)]),
            ),
          ),
        workflowForFiles: (botId, files, groupId, signal) =>
          track(() =>
            workflowForFiles(services.effectiveFor(botId, groupId), botId, files, signal),
          ),
      };
      const teach = createTeach({ ctx, skills: services.skills, shutdown: signal });
      try {
        await teach.recover();
      } catch (error) {
        await teach.dispose();
        await services.stop();
        throw error;
      }
      const links = new SkillLinks(ctx, services, signal, mainBot.id);
      const updates = new SkillUpdates(ctx, services, signal);
      const stop = async () => {
        closed = true;
        teach.quiesce();
        shutdown.abort();
        await Promise.allSettled([...pending]);
        const results = await Promise.allSettled([teach.dispose(), links.stop()]);
        results.push(...(await Promise.allSettled([services.stop()])));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      };
      // Queue startup collection before publishing ports so it cannot race a new reference commit.
      // Registration returns while hashes run; has() stays false for each unverified package.
      const maintenance = withProgressDeadline(signal, (deadline, touch) =>
        services.packages.maintain(deadline, touch),
      ).catch(() => {
        if (!signal.aborted)
          ctx.logger.warn(
            JSON.stringify({ module: "skills", event: "skill_packages_maintenance_incomplete" }),
          );
      });
      void track(() => maintenance);
      try {
        port.previewLink = (...args) => track(() => links.previewTeamSource(...args));
        ctx.skills.provide(port);
        ctx.ports.provide("imported-skills", {
          copyImported: port.copyImported,
          bringOver: port.bringOver,
          previewBringOver: port.previewBringOver,
          knownSkills: port.knownSkills,
          freeSkillName: port.freeSkillName,
        });
        ctx.ports.provide("plugin-skills", pluginSkills);
        const handle: RegisterRpc = (method, action) =>
          ctx.rpc.handle(method, (params, context) => track(() => action(params, context)));
        links.register(handle);
        registerSkillRpc(handle, services, signal);
        updates.register(handle);
        registerSkillCatalogRpc(
          handle,
          services,
          catalog,
          () => ctx.ports.get<BuiltinMethodsPort>("builtin-methods"),
          signal,
        );
        registerWorkflowRpc(handle, services, ctx, signal);
        registerTeachRpc(handle, teach);
        ctx.sleep.participate({ idle: () => !pending.size && !links.retained && teach.isIdle() });
      } catch (error) {
        // Registration failure also owns the already scheduled background validation.
        await stop().catch(() =>
          ctx.logger.warn(
            JSON.stringify({ module: "skills", event: "skill_capability_cleanup_failed" }),
          ),
        );
        throw error;
      }
      return { stop };
    },
  };
}
