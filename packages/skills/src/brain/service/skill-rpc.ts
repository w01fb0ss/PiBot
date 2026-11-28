import type { RegisterRpc } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/skills-contract/full";
import type { SkillRuntimeService, SkillRuntimeTarget } from "./skill-runtime.ts";
import type { SkillService } from "./skill-service.ts";

/** The optional scope selects a separate repository; a missing scope always means DM. */
export function registerSkillRpc(
  handle: RegisterRpc,
  owner: {
    skills: SkillService;
    runtime: SkillRuntimeService;
    skillsFor(groupId?: string): SkillService;
    effectiveFor(botId: string, groupId?: string): SkillService;
    idempotentWrite<T>(
      requestId: string,
      input: unknown,
      signal: AbortSignal,
      action: (queueSignal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  },
  signal: AbortSignal,
) {
  /** Every runtime call resolves the skill first: the folder and group come from its own row. */
  const runtimeTarget = (groupId: string | undefined, skillId: string): SkillRuntimeTarget =>
    owner.skillsFor(groupId).runtimeTarget(skillId);
  const measure = async <T>(
    method: "skills.list" | "skills.get" | "skills.runtime",
    view: "list" | "summary" | "resources" | "runtime",
    read: () => T | Promise<T>,
  ) => {
    const started = performance.now();
    let outcome = "failed";
    try {
      const value = await read();
      outcome = "ok";
      return value;
    } finally {
      owner.skills.deps.logger.info(
        JSON.stringify({
          module: "skills",
          event: "detail_read",
          method,
          view,
          durationMs: Math.round(performance.now() - started),
          outcome,
        }),
      );
    }
  };
  handle("skills.list", async ({ groupId, effective, ...params }) =>
    measure("skills.list", "list", () =>
      (effective ? owner.effectiveFor(params.botId, groupId) : owner.skillsFor(groupId)).list(
        params,
      ),
    ),
  );
  handle("skills.get", ({ groupId, skillId, includeResources }, context) =>
    measure("skills.get", includeResources === false ? "summary" : "resources", () =>
      owner
        .skillsFor(groupId)
        .get(skillId, AbortSignal.any([signal, context.signal]), includeResources),
    ),
  );
  handle("skills.readFile", async (params, context) =>
    "uploadId" in params
      ? owner.skillsFor(params.groupId).uploads.file(params.uploadId, params.path)
      : owner
          .skillsFor(params.groupId)
          .readFile(params.skillId, params.path, AbortSignal.any([signal, context.signal])),
  );
  handle("skills.pickFiles", async ({ groupId, botId, from, dropId }, context) => {
    const skills = owner.skillsFor(groupId);
    if (from === "drop" && dropId) {
      if (context.source === "acp")
        throw new RpcError(RpcErrorCodes.unsupported, "skill_picker_unavailable");
      context.signal.throwIfAborted();
      skills.activeBot(botId);
      return skills.uploads.drop(
        dropId,
        AbortSignal.any([signal, context.signal, AbortSignal.timeout(30_000)]),
      );
    }
    if (from === "drop") throw new RpcError(RpcErrorCodes.invalidParams, "skill_files_invalid");
    return skills.pickFiles(
      botId,
      from,
      AbortSignal.any([signal, context.signal, AbortSignal.timeout(660_000)]),
    );
  });
  handle("skills.create", ({ botId, requestId, document, enabled, files }, context) =>
    owner.idempotentWrite(
      requestId,
      { method: "skills.create", botId, document, enabled, files },
      context.signal,
      (queueSignal) =>
        owner.skills.create(botId, document, "taught", {
          enabled,
          queueSignal,
          fileChanges: files,
        }),
    ),
  );
  handle("skills.update", ({ groupId, skillId, requestId, patch, files }, context) =>
    owner.idempotentWrite(
      requestId,
      { method: "skills.update", groupId, skillId, patch, files },
      context.signal,
      (queueSignal) => owner.skillsFor(groupId).update(skillId, patch, queueSignal, files),
    ),
  );
  handle("skills.delete", ({ groupId, skillId }) => owner.skillsFor(groupId).remove(skillId));
  handle("skills.setEnabled", async ({ groupId, skillId, enabled }) =>
    owner.skillsFor(groupId).setEnabled(skillId, enabled),
  );
  /**
   * A picker or a first copy runs before any preview id exists, so a dialog that stops
   * during this call has nothing to cancel by. The caller names the batch before dispatch and
   * `skills.cancelPreviewBatch` then waits until this call — including its cleanup — has ended.
   */
  const previewBatches = new Map<
    string,
    { abort: AbortController; done: Promise<unknown>; releasePreview: () => Promise<unknown> }
  >();
  handle("skills.preview", ({ groupId, botId, from, batchId }, context) => {
    if (batchId && previewBatches.has(batchId))
      throw new RpcError(RpcErrorCodes.busy, "skill_picker_busy");
    const imports = owner.skillsFor(groupId).imports;
    const batch = batchId ? new AbortController() : undefined;
    const stop = AbortSignal.any(
      batch ? [signal, context.signal, batch.signal] : [signal, context.signal],
    );
    let previewId: string | undefined;
    const forget = () => {
      if (batchId && previewBatches.get(batchId)?.abort === batch) previewBatches.delete(batchId);
    };
    const releasePreview = async () => {
      if (previewId) await imports.cancel(previewId);
    };
    const work = Promise.resolve().then(async () => {
      try {
        stop.throwIfAborted();
        const details = await imports.preview(botId, from ?? "file", stop);
        previewId = details?.previewId;
        // The transport may discard a successful response. Keep the exact slot reachable by
        // batch id until import, explicit cancellation, expiry or service disposal releases it.
        if (batchId && previewId) imports.onPreviewRelease(previewId, forget);
        if (stop.aborted) {
          await releasePreview();
          stop.throwIfAborted();
        }
        return details;
      } finally {
        if (!previewId) forget();
      }
    });
    if (batchId && batch) previewBatches.set(batchId, { abort: batch, done: work, releasePreview });
    return work;
  });
  handle("skills.cancelPreviewBatch", async ({ batchId }) => {
    const batch = previewBatches.get(batchId);
    // No active picker or retained preview belongs to this batch.
    if (!batch) return { ok: true as const };
    batch.abort.abort();
    await batch.done.catch(() => undefined);
    await batch.releasePreview();
    return { ok: true as const };
  });
  handle("skills.previewFile", async ({ groupId, previewId, path }, context) =>
    owner
      .skillsFor(groupId)
      .imports.file(previewId, path, AbortSignal.any([signal, context.signal])),
  );
  handle("skills.cancelPreview", async ({ groupId, previewId }) =>
    owner.skillsFor(groupId).imports.cancel(previewId),
  );
  handle("skills.secretChoices", async ({ botId }, context) => {
    if (context.source === "acp")
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_secret_invalid");
    await owner.skills.deps.local?.userSecrets.ready(context.signal);
    return owner.skills.secretChoices(botId);
  });
  handle("skills.secretBindings", async ({ groupId, skillId }, context) => {
    if (context.source === "acp")
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_secret_invalid");
    const skills = owner.skillsFor(groupId);
    const record = skills.require(skillId);
    await skills.deps.local?.userSecrets.ready(context.signal);
    const names = new Map<string, string | null>(
      skills.secretBindings(skillId).map(({ variable, secretName }) => [variable, secretName]),
    );
    for (const variable of await skills.secretVariables(skillId, context.signal)) {
      if (names.size === 64) break;
      if (!names.has(variable)) names.set(variable, null);
    }
    return {
      bindings: [...names].map(([variable, secretName]) => ({ variable, secretName })),
      available: skills.secretChoices(record.botId),
    };
  });
  handle("skills.setSecretBindings", async ({ groupId, skillId, bindings }, context) => {
    if (context.source === "acp")
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_secret_invalid");
    const skills = owner.skillsFor(groupId);
    await skills.deps.local?.userSecrets.ready(context.signal);
    const variables = await skills.secretVariables(skillId, context.signal);
    context.signal.throwIfAborted();
    skills.bindSecrets(skills.require(skillId), bindings, variables);
    return { ok: true };
  });
  handle("skills.import", ({ groupId, previewId, bindings }, context) => {
    if (context.source === "acp" && bindings?.length)
      throw new RpcError(RpcErrorCodes.invalidParams, "skill_secret_invalid");
    const work = AbortSignal.any([signal, context.signal]);
    return owner.skillsFor(groupId).imports.import(previewId, work, bindings);
  });
  handle("skills.proposals", async (params) => owner.skills.proposals.list(params));
  handle("skills.propose.resolve", (params) => owner.skills.proposals.resolve(params));
  // The plan hash makes the run idempotent the way the card does — a retry installs the
  // exact plan the user approved, and a changed plan is rejected instead of slipping through.
  handle("skills.runtime", ({ groupId, skillId, runtime }, context) =>
    measure("skills.runtime", "runtime", async () => {
      const skills = owner.skillsFor(groupId);
      const work = AbortSignal.any([signal, context.signal]);
      await skills.readLocation(skills.require(skillId), work);
      work.throwIfAborted();
      const status = await owner.runtime.status(runtimeTarget(groupId, skillId), work, runtime);
      work.throwIfAborted();
      return status;
    }),
  );
  handle(
    "skills.runtime.prepare",
    (
      { groupId, skillId, runtime, requestId, planHash, confirmWithoutIsolation, useMirror },
      context,
    ) => {
      if (context.source === "acp")
        throw new RpcError(RpcErrorCodes.invalidParams, "skill_runtime_confirmation_required");
      return owner.idempotentWrite(
        requestId,
        {
          method: "skills.runtime.prepare",
          groupId,
          skillId,
          runtime,
          planHash,
          confirmWithoutIsolation,
          useMirror,
        },
        context.signal,
        (queueSignal) =>
          owner.runtime.prepare(
            runtimeTarget(groupId, skillId),
            planHash,
            AbortSignal.any([signal, queueSignal, AbortSignal.timeout(30 * 60_000)]),
            confirmWithoutIsolation,
            useMirror,
            runtime,
          ),
      );
    },
  );
  handle("skills.runtime.cancel", ({ groupId, skillId, runtime }) =>
    owner.runtime.cancel(runtimeTarget(groupId, skillId), runtime),
  );
  handle("skills.runtime.remove", ({ groupId, skillId, runtime }) =>
    owner.runtime.remove(runtimeTarget(groupId, skillId), runtime),
  );
  handle("skills.runtime.log", ({ groupId, skillId, runtime }) =>
    owner.runtime.log(runtimeTarget(groupId, skillId), runtime),
  );
}
