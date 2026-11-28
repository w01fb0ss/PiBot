import { isDeepStrictEqual } from "node:util";
import { type CapabilityContext, requireImageModel, type ToolRunContext } from "@pibot/brain/kit";
import { createTranslator } from "@pibot/i18n";
import {
  IdSchema,
  isPiManagerCategory,
  looksLikeCredentialName,
  looksLikeCredentialValue,
  type MethodParams,
  type MethodResults,
  Methods,
  ModelPreferenceSchema,
  piSettingsTools,
  type ToolSettingsAction,
} from "@pibot/protocol";
import { BotsRepo, ConversationsRepo, GroupsRepo } from "@pibot/storage";
import { fieldsFor, type ScopeKind, type SettingsField } from "./fields.ts";

type Rpc = NonNullable<CapabilityContext["rpc"]["settings"]>;
type Method = Parameters<Rpc>[0];
type Write = { method: Method; params: unknown };
type Source = SettingsField["source"];
type Change = ReturnType<typeof piSettingsTools.settings_change.schema.parse>["changes"][number];
type Scope = { kind: ScopeKind; id?: string };

export type SettingsRow = {
  scope: string;
  key: string;
  field: SettingsField;
  target?: string;
  label?: string;
  before: unknown;
  after: unknown;
  names?: Record<string, string>;
  strictIsolation?: boolean;
};
export type SettingsPlan = {
  security: boolean;
  operations: { write: Write; rows: SettingsRow[] }[];
};

export class SettingsRefusal extends Error {
  constructor(
    readonly code: string,
    readonly action?: ToolSettingsAction,
  ) {
    super(code);
  }
}

function scopeOf(scope: string): Scope {
  if (scope === "app") return { kind: "app" };
  if (scope === "permissions:global") return { kind: "permissions" };
  const [kind, id, extra] = scope.split(":");
  if (
    extra !== undefined ||
    (kind !== "bot" && kind !== "group" && kind !== "connection" && kind !== "permissions") ||
    !IdSchema.safeParse(id).success
  )
    throw new SettingsRefusal("settings_unknown_scope");
  return { kind, id };
}

function credentialName(key: string) {
  return (
    looksLikeCredentialName(key) ||
    /secret|apikey|token|password|oauth/i.test(key.replace(/[^a-z0-9]/gi, ""))
  );
}

function credentialValue(ctx: CapabilityContext, value: unknown): boolean {
  if (typeof value === "string")
    return (
      looksLikeCredentialValue(value) ||
      ctx.redactor.contains(value).length > 0 ||
      /\b(?:bearer|basic)\s+\S+|\$\{secret:|:\/\/[^\s/]*@/i.test(value)
    );
  if (Array.isArray(value)) return value.some((part) => credentialValue(ctx, part));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, part]) => credentialName(key) || credentialValue(ctx, part),
    );
  return false;
}

function publicValue(ctx: CapabilityContext, value: unknown): unknown {
  if (typeof value === "string")
    return credentialValue(ctx, value) ? "[redacted]" : ctx.redactor.redact(value);
  if (Array.isArray(value)) return value.map((part) => publicValue(ctx, part));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !credentialName(key))
        .map(([key, part]) => [key, publicValue(ctx, part)]),
    );
  return value ?? null;
}

function fieldValue(value: unknown, path: string): unknown {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function readValue(row: SettingsField, data: unknown, key: string) {
  return fieldValue(data, row.path ?? key) ?? row.fallback ?? null;
}

function validate<M extends Method>(method: M, params: unknown) {
  const parsed = Methods[method].params.safeParse(params);
  if (!parsed.success) throw new SettingsRefusal("settings_invalid_value");
  return parsed.data;
}

function checkedWrite(method: Method, params: unknown): Write {
  return { method, params: validate(method, params) };
}

export async function settingsCall<M extends Method>(
  rpc: Rpc,
  method: M,
  params: MethodParams[M],
  signal: AbortSignal,
): Promise<MethodResults[M]> {
  return (await rpc(method, params, signal)) as MethodResults[M];
}

function botFor(ctx: CapabilityContext, id?: string) {
  const bot = id && new BotsRepo(ctx.db).get(id);
  if (!bot || bot.archivedAt) throw new SettingsRefusal("settings_target_unavailable");
  return bot;
}

export function settingsRequests(ctx: CapabilityContext, input: Record<string, unknown>) {
  const args = piSettingsTools.settings_change.schema.parse(input);
  for (const { scope, key, value } of args.changes)
    if (credentialName(key) || credentialValue(ctx, value))
      throw new SettingsRefusal("settings_secret_refused", {
        kind: "open_settings",
        page: scope.startsWith("connection:")
          ? "connections"
          : /pass(?:word|wd)/i.test(key)
            ? "passwords"
            : "models",
      });
  const changes = args.changes.map((change) => {
    const scope = scopeOf(change.scope);
    const fields = fieldsFor(scope.kind);
    if (!Object.hasOwn(fields, change.key)) throw new SettingsRefusal("settings_unknown_key");
    return { change, scope, field: fields[change.key] as SettingsField };
  });
  const security = changes.some(({ field }) => field.security);
  if (security && changes.length !== 1) throw new SettingsRefusal("settings_security_single");
  if (
    new Set(changes.map(({ change }) => JSON.stringify([change.scope, change.key]))).size !==
    changes.length
  )
    throw new SettingsRefusal("settings_duplicate_key");
  return { changes, security };
}
type Requested = ReturnType<typeof settingsRequests>["changes"][number];

function sourceReader(
  ctx: CapabilityContext,
  rpc: Rpc,
  context: ToolRunContext,
  signal: AbortSignal,
) {
  return async (source: Source, scope: Scope) => {
    const id = scope.id ?? "";
    switch (source) {
      case "app":
        return { data: await settingsCall(rpc, "settings.get", undefined, signal) };
      case "routine":
        return { data: await settingsCall(rpc, "routines.settings.get", undefined, signal) };
      case "browser":
        return { data: await settingsCall(rpc, "browserExtension.status", undefined, signal) };
      case "remote":
        return { data: await settingsCall(rpc, "remote.settings.get", undefined, signal) };
      case "yolo":
        return {
          data: await settingsCall(
            rpc,
            "conversations.yolo.get",
            { conversationId: context.conversationId as string },
            signal,
          ),
        };
      case "bot": {
        const bot = botFor(ctx, id);
        const model =
          bot.modelProvider && bot.modelId
            ? { provider: bot.modelProvider, id: bot.modelId }
            : null;
        return {
          target: bot.name,
          data: {
            ...bot,
            model,
            ...(bot.category === "image" ? { imageModel: model } : {}),
            thinkingPreference:
              bot.thinkingPreference === undefined ? bot.thinkingLevel : bot.thinkingPreference,
            confirmEverySend: bot.permissionOverrides?.confirmEverySend === true,
          },
        };
      }
      case "group": {
        const group = new GroupsRepo(ctx.db).get(id);
        if (!group || group.archivedAt) throw new SettingsRefusal("settings_target_unavailable");
        return { target: group.name, data: { autoRoundLimit: group.autoRoundLimit } };
      }
      case "folder": {
        const bot = botFor(ctx, id);
        const topicId =
          id === context.botId
            ? (context.conversationId as string)
            : new ConversationsRepo(ctx.db).currentDmIfPresent(id)?.id;
        if (!topicId) return { target: bot.name, data: null };
        const place = await settingsCall(
          rpc,
          "topics.workplace.get",
          { botId: id, topicId },
          signal,
        );
        return { target: bot.name, data: { ...place, folder: place.folderId ?? "home" } };
      }
      case "permission": {
        const bot = scope.id ? botFor(ctx, id) : undefined;
        const permissions = await settingsCall(
          rpc,
          "permissions.get",
          bot ? { botId: id } : undefined,
          signal,
        );
        return { target: bot?.name, data: permissions.effective ?? permissions };
      }
      case "grant": {
        const bot = scope.id ? botFor(ctx, id) : undefined;
        const grants = await settingsCall(
          rpc,
          "grants.list",
          { ...(bot && { botId: id }), limit: 100 },
          signal,
        );
        return {
          target: bot?.name,
          data: {
            revokeGrant: grants.filter(
              (grant) => !grant.revokedAt && grant.scope.kind !== "secret",
            ),
          },
        };
      }
      case "connection":
      case "plugin": {
        const details = await settingsCall(rpc, "connectors.get", { id }, signal);
        const target = details.connector.name;
        if (source === "plugin") {
          const form = await settingsCall(
            rpc,
            "plugins.settings",
            { installationId: details.connector.pluginInstallationId },
            signal,
          );
          const fields = form.fields.filter(
            (field) => !field.sensitive && !credentialName(field.key),
          );
          return {
            target,
            data: {
              ...form,
              fields,
              config: Object.fromEntries(fields.map(({ key }) => [key, form.values[key] ?? null])),
            },
          };
        }
        const tools = await settingsCall(rpc, "connectors.tools", { id, limit: 50 }, signal);
        return {
          target,
          data: {
            ...details.connector,
            access: details.access,
            networkDomains: details.networkDomains,
            tools: tools.items.map(({ tool, title, enabled, readOnly, readOnlyLocked }) => ({
              tool,
              title,
              enabled,
              readOnly,
              readOnlyLocked,
            })),
          },
        };
      }
    }
  };
}

type SourceData = Awaited<ReturnType<ReturnType<typeof sourceReader>>>;
function requireValue(value: boolean, code = "settings_invalid_value"): asserts value {
  if (!value) throw new SettingsRefusal(code);
}

function paramsFor(
  ctx: CapabilityContext,
  context: ToolRunContext,
  source: Source,
  state: SourceData,
  scope: Scope,
  patch: Record<string, unknown>,
): Write {
  const id = scope.id ?? "";
  const data = state.data;
  switch (source) {
    case "app":
      if (ctx.local.deps.platform === "win32")
        requireValue(
          !Object.keys(patch).some((key) => key === "strictSandbox" || key.startsWith("sandbox")),
          "settings_unsupported_platform",
        );
      if (Object.hasOwn(patch, "yoloUnisolatedCommands"))
        requireValue(
          ctx.local.deps.platform === "win32" && patch.yoloUnisolatedCommands === false,
          "settings_unsupported_platform",
        );
      return checkedWrite("settings.set", patch);
    case "routine":
      return checkedWrite("routines.settings.set", patch);
    case "group":
      return checkedWrite("groups.update", { groupId: id, ...patch });
    case "bot": {
      const bot = botFor(ctx, id);
      const { model, imageModel, confirmEverySend, ...rest } = patch;
      if (imageModel !== undefined) {
        requireValue(bot.category === "image");
        requireValue(model === undefined, "settings_duplicate_key");
      }
      if (rest.defaultVideoModel !== undefined) requireValue(!bot.kind);
      const selection = imageModel === undefined ? model : imageModel;
      if (selection !== undefined) {
        const parsed = ModelPreferenceSchema.nullable().safeParse(selection);
        requireValue(parsed.success && (bot.category !== "image" || parsed.data !== null));
        rest.modelProvider = parsed.data?.provider ?? null;
        rest.modelId = parsed.data?.id ?? null;
      }
      if (rest.imageMode !== undefined) requireValue(bot.category === "image");
      if (confirmEverySend !== undefined) {
        requireValue(typeof confirmEverySend === "boolean");
        const { confirmEverySend: _before, ...overrides } = bot.permissionOverrides ?? {};
        rest.permissionOverrides = {
          ...overrides,
          ...(confirmEverySend ? { confirmEverySend: true } : {}),
        };
      }
      return checkedWrite("bots.update", { botId: id, ...rest });
    }
    case "folder": {
      requireValue(!!data, "settings_target_unavailable");
      const place = data as MethodResults["topics.workplace.get"];
      requireValue(!place.busy, "settings_folder_busy");
      requireValue(
        patch.folder === "home" ||
          place.workplace.folders.some(
            (folder) => folder.id === patch.folder && !folder.location?.startsWith("runner:"),
          ),
      );
      return checkedWrite("topics.workplace.set", {
        botId: id,
        topicId: place.topicId,
        folderId: patch.folder,
      });
    }
    case "yolo":
      return checkedWrite("conversations.yolo.set", {
        conversationId: context.conversationId,
        ...patch,
      });
    case "remote": {
      const remote = data as MethodResults["remote.settings.get"];
      const direct = { ...remote.direct };
      if (Object.hasOwn(patch, "direct.mode")) {
        Object.assign(direct, { mode: patch["direct.mode"] });
        patch = { direct };
      } else if (Object.hasOwn(patch, "direct.stunUrl")) {
        Object.assign(direct, { stunUrl: patch["direct.stunUrl"] });
        patch = { direct };
      }
      // The security card repeats the disclosure before this argument is used.
      return checkedWrite("remote.settings.set", {
        expectedVersion: remote.version,
        patch,
        disclosureAccepted: true,
      });
    }
    case "browser": {
      const browser = data as MethodResults["browserExtension.status"];
      requireValue(browser.supported, "settings_unsupported_platform");
      if (Object.hasOwn(patch, "registration")) {
        requireValue(patch.registration === true && browser.registration === "other_instance");
        return checkedWrite("browserExtension.setPreference", {
          preference: "user",
          takeOver: true,
        });
      }
      return checkedWrite("browserExtension.setPreference", patch);
    }
    case "permission": {
      const [path, value] = Object.entries(patch)[0] ?? [];
      const [field, key] = path?.split(".") ?? [];
      requireValue(!!field && !!key && (scope.id !== undefined || value !== null));
      if (field === "levels" && isPiManagerCategory(key))
        requireValue(!!scope.id && botFor(ctx, id).isMain, "settings_target_unavailable");
      return checkedWrite("permissions.set", {
        ...(scope.id && { botId: id }),
        [field]: { [key]: value },
      });
    }
    case "grant": {
      const grants = fieldValue(data, "revokeGrant") as MethodResults["grants.list"];
      requireValue(
        grants.some(
          (grant) =>
            grant.id === patch.revokeGrant &&
            grant.botId === id &&
            !grant.groupId &&
            !grant.revokedAt,
        ),
      );
      return checkedWrite("grants.revoke", { id: patch.revokeGrant });
    }
    case "connection": {
      const { revision } = data as MethodResults["connectors.update"];
      if (Object.hasOwn(patch, "tools"))
        requireValue(
          Array.isArray(patch.tools) &&
            patch.tools.length === 1 &&
            patch.tools.every(
              (tool) => !!tool && typeof tool === "object" && !Object.hasOwn(tool, "draftBinding"),
            ),
        );
      return checkedWrite("connectors.update", { id, expectedRevision: revision, ...patch });
    }
    case "plugin": {
      const form = data as MethodResults["plugins.settings"];
      const config = patch.config;
      requireValue(
        form.editable &&
          !!config &&
          typeof config === "object" &&
          !Array.isArray(config) &&
          Object.keys(config).length > 0,
      );
      requireValue(
        Object.entries(config).every(([key, value]) => {
          const field = form.fields.find((item) => item.key === key);
          if (!field || field.sensitive) return false;
          const type = field.type === "directory" || field.type === "file" ? "string" : field.type;
          return (
            typeof value === type &&
            (!field.required || typeof value !== "string" || value.trim().length > 0) &&
            (!field.options?.length || field.options.some((item) => item.value === value))
          );
        }),
      );
      return checkedWrite("plugins.updateSettings", {
        installationId: form.installationId,
        expectedRevision: form.revision,
        config,
      });
    }
  }
}

function rowsFor(
  ctx: CapabilityContext,
  change: Change,
  field: SettingsField,
  state: SourceData,
): SettingsRow[] {
  const { key, scope, value } = change;
  const data = state.data;
  const target = state.target ? ctx.redactor.redact(state.target) : undefined;
  const before = readValue(field, data, key);
  const row = { scope, key, field, target, before, after: value };
  if (key === "sandboxAutoOutsideCommands") {
    const settings = data as MethodResults["settings.get"];
    return [{ ...row, strictIsolation: settings.strictSandbox === true }];
  }
  if (field.source === "plugin") {
    const form = data as MethodResults["plugins.settings"];
    return Object.entries(value as Record<string, unknown>).map(([name, after]) => ({
      ...row,
      key: `config.${name}`,
      label: ctx.redactor.redact(form.fields.find((item) => item.key === name)?.title || name),
      before: fieldValue(before, name) ?? null,
      after,
    }));
  }
  if (field.source === "folder") {
    const { workplace } = data as MethodResults["topics.workplace.get"];
    return [
      {
        ...row,
        names: Object.fromEntries(
          workplace.folders.map((folder) => [folder.id, ctx.redactor.redact(folder.name)]),
        ),
      },
    ];
  }
  if (key === "access") {
    const names = new Map([
      ...new BotsRepo(ctx.db).list().map((bot) => [bot.id, ctx.redactor.redact(bot.name)] as const),
      ...new GroupsRepo(ctx.db)
        .list()
        .map((group) => [group.id, ctx.redactor.redact(group.name)] as const),
    ]);
    const ids = [before, value].flatMap((access) =>
      ["bots", "groups"].flatMap((kind) => {
        const members = fieldValue(access, kind);
        return Array.isArray(members) ? (members as string[]) : [];
      }),
    );
    return [{ ...row, names: Object.fromEntries(ids.map((id) => [id, names.get(id) ?? id])) }];
  }
  if (key === "tools" && Array.isArray(value) && Array.isArray(before)) {
    const current = before as Pick<
      MethodResults["connectors.tools"]["items"][number],
      "tool" | "title" | "enabled" | "readOnly" | "readOnlyLocked"
    >[];
    const changes = value as NonNullable<MethodParams["connectors.update"]["tools"]>;
    return changes.map((next) => {
      const prior = current.find(({ tool }) => tool === next.tool);
      requireValue(!!prior && (!prior.readOnlyLocked || next.readOnly));
      return {
        ...row,
        label: ctx.redactor.redact(prior.title || prior.tool),
        before: { tool: prior.tool, enabled: prior.enabled, readOnly: prior.readOnly },
        after: next,
      };
    });
  }
  if (field.source === "grant") {
    const grant = (before as MethodResults["grants.list"]).find((entry) => entry.id === value);
    return [
      {
        ...row,
        before: grant ? { category: grant.category, scope: grant.scope } : null,
        after: null,
      },
    ];
  }
  if (key === "browserExtensionTakeOver") return [{ ...row, after: "here" }];
  return [row];
}

function botModelValue({ modelProvider, modelId }: MethodParams["bots.update"]) {
  return modelProvider && modelId ? { provider: modelProvider, id: modelId } : null;
}

export async function prepareSettings(
  ctx: CapabilityContext,
  rpc: Rpc,
  context: ToolRunContext,
  requests: ReturnType<typeof settingsRequests>,
  signal: AbortSignal,
): Promise<SettingsPlan> {
  const read = sourceReader(ctx, rpc, context, signal);
  const groups = new Map<string, Requested[]>();
  for (const request of requests.changes) {
    const key = JSON.stringify([request.change.scope, request.field.source]);
    const group = groups.get(key) ?? [];
    group.push(request);
    groups.set(key, group);
  }
  const operations = [];
  const pluginWrites = new Set<string>();
  for (const group of groups.values()) {
    const first = group[0] as Requested;
    const { source } = first.field;
    const state = await read(source, first.scope);
    const patch = Object.fromEntries(
      group.map(({ change, field }) => [field.path ?? change.key, change.value]),
    );
    for (const { change, field } of group) {
      if (!field.removeOnly || typeof change.value === "boolean") continue;
      const before = readValue(field, state.data, change.key);
      requireValue(
        Array.isArray(change.value) &&
          Array.isArray(before) &&
          change.value.every((item) => before.some((entry) => isDeepStrictEqual(entry, item))),
      );
    }
    const write = paramsFor(ctx, context, source, state, first.scope, patch);
    if (write.method === "plugins.updateSettings") {
      const { installationId } = write.params as MethodParams["plugins.updateSettings"];
      requireValue(!pluginWrites.has(installationId), "settings_duplicate_key");
      pluginWrites.add(installationId);
    }
    if (write.method === "bots.update") {
      const parsed = write.params as MethodParams["bots.update"];
      const bot = botFor(ctx, parsed.botId);
      if (parsed.defaultVideoModel) {
        const { provider, id } = parsed.defaultVideoModel;
        const videos = ctx.local.models?.videoProviders() ?? [];
        if (
          !videos.some(
            (entry) => entry.id === provider && entry.videoModels.some((model) => model.id === id),
          )
        ) {
          const action = ctx.local.models
            ?.videoModelsToEnable?.()
            .find(({ providerId, model }) => providerId === provider && model.id === id);
          throw new SettingsRefusal(
            action
              ? "video_enable_needed"
              : videos.length
                ? "video_model_unavailable"
                : "video_no_models",
            action ?? { kind: "open_settings", page: "models" },
          );
        }
      }
      if (parsed.modelProvider && parsed.modelId) {
        const { modelProvider: provider, modelId: id } = parsed;
        if (bot.category === "image")
          parsed.modelId = (
            await requireImageModel(ctx.local.images, { provider, id }, parsed.imageMode, signal)
          ).id;
        else {
          const models = await ctx.agent.listModels({ availableOnly: true });
          signal.throwIfAborted();
          requireValue(models.some((model) => model.provider === provider && model.id === id));
        }
      }
    }
    const rows = group
      .flatMap(({ change, field }) => {
        const path = field.path ?? change.key;
        const normalized =
          write.method === "bots.update" && (change.key === "model" || change.key === "imageModel")
            ? botModelValue(write.params as MethodParams["bots.update"])
            : field.source === "remote"
              ? fieldValue(write.params, `patch.${path}`)
              : fieldValue(write.params, path);
        return rowsFor(
          ctx,
          normalized === undefined ? change : { ...change, value: normalized as Change["value"] },
          field,
          state,
        );
      })
      .map((row) => ({
        ...row,
        before: publicValue(ctx, row.before),
        after: publicValue(ctx, row.after),
      }));
    operations.push({ write, rows });
  }
  return { security: requests.security, operations };
}

export async function readSettings(
  ctx: CapabilityContext,
  rpc: Rpc,
  context: ToolRunContext,
  scopeName: string,
  signal: AbortSignal,
) {
  const scope = scopeOf(scopeName);
  const read = sourceReader(ctx, rpc, context, signal);
  const t = createTranslator(context.language);
  const sources = new Map<Source, SourceData | null>();
  const fields: Record<string, unknown> = {};
  const bot =
    (scope.kind === "permissions" || scope.kind === "bot") && scope.id
      ? botFor(ctx, scope.id)
      : undefined;
  for (const [key, field] of Object.entries(fieldsFor(scope.kind))) {
    if (
      scope.kind === "bot" &&
      ((key === "model" && bot?.category === "image") ||
        ((key === "imageModel" || key === "imageMode") && bot?.category !== "image") ||
        (key === "videoModel" && bot?.kind))
    )
      continue;
    if (
      scope.kind === "permissions" &&
      ((!bot?.isMain &&
        key.startsWith("levels.") &&
        isPiManagerCategory(key.slice("levels.".length))) ||
        (!bot && field.source === "grant"))
    )
      continue;
    if (!sources.has(field.source)) {
      try {
        sources.set(field.source, await read(field.source, scope));
      } catch (error) {
        // Optional integrations can be absent in this product composition.
        if (!(error instanceof Error) || error.message !== "settings_unavailable") throw error;
        sources.set(field.source, null);
      }
    }
    const source = sources.get(field.source);
    if (!source?.data) continue;
    const value = readValue(field, source.data, key);
    fields[key] = {
      tier: field.security ? "security" : "ordinary",
      value: publicValue(ctx, value),
      ...(field.description ? { description: t(field.description) } : {}),
    };
  }
  if (scope.kind !== "app") return { scope: scopeName, fields };
  const bots = new BotsRepo(ctx.db)
    .list()
    .map(({ id, name }) => ({ id, name: ctx.redactor.redact(name) }));
  const groups = new GroupsRepo(ctx.db)
    .list({ limit: 50 })
    .map(({ id, name }) => ({ id, name: ctx.redactor.redact(name) }));
  const connections = await settingsCall(rpc, "connectors.list", { limit: 50 }, signal)
    .then(({ items }) => items.map(({ id, name }) => ({ id, name: ctx.redactor.redact(name) })))
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "settings_unavailable") return [];
      throw error;
    });
  const credentials = await settingsCall(rpc, "providers.list", undefined, signal)
    .then((providers) =>
      providers
        .filter(({ auth }) => auth === "apiKey" || auth === "oauth" || auth === "cloud")
        .map(({ name, configured, envDetected, authState }) => ({
          provider: ctx.redactor.redact(name),
          isSet: authState === "connected" || configured || envDetected,
        })),
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === "settings_unavailable") return [];
      throw error;
    });
  return { scope: scopeName, fields, bots, groups, connections, credentials };
}
