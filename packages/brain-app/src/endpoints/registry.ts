import type { CapabilityContext } from "@pibot/brain/kit";
import type { EndpointPresence } from "@pibot/protocol-base";
import {
  CapabilityManifestSchema,
  type EndpointCapabilityDefinition,
  type EndpointCapabilityPort,
  type EndpointCapabilityRow,
  type EndpointToolScope,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import {
  AuditRepo,
  BotsRepo,
  EndpointCapabilitiesRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";
import { legacyEndpoint } from "./legacy.ts";
import { EndpointCapabilityUpdates } from "./updates.ts";
import { endpointCapabilityView } from "./view.ts";

export class EndpointCapabilityRegistry implements EndpointCapabilityPort {
  private readonly repo;
  private readonly audit;
  private readonly bots;
  private readonly groups;
  private readonly updates;
  private readonly declared = new Set<string>();
  private snapshot: () => EndpointPresence[] = () => [];
  private presence: EndpointPresence[] = [];
  private online = new Set(["local"]);
  private targets = new Map<string, string>();
  private readonly definitions;
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly endpointCapabilityCatalog: readonly EndpointCapabilityDefinition[],
  ) {
    this.updates = new EndpointCapabilityUpdates(() =>
      ctx.logger.warn("endpoint_enable_delivery_failed"),
    );
    this.definitions = new Map(endpointCapabilityCatalog.map((d) => [d.id, d]));
    this.repo = new EndpointCapabilitiesRepo(ctx.db);
    this.audit = new AuditRepo(ctx.db, ctx.redactor);
    this.bots = new BotsRepo(ctx.db);
    this.groups = new GroupsRepo(ctx.db);
  }
  dispose() {
    this.updates.dispose();
    this.snapshot = () => [];
    this.presence = [];
    this.online.clear();
    this.targets.clear();
    this.declared.clear();
  }
  phoneOnline(id: string) {
    return this.snapshot().some(
      (entry) => entry.kind === "phone" && entry.online && entry.id === id,
    );
  }
  enabled(endpointId: string) {
    return [...this.definitions.keys()].filter((id) => {
      const row = this.repo.get(endpointId, id)?.row;
      return row && row.state !== "off" && row.availability === "available";
    });
  }
  subscribe(endpointId: string, listener: (ids: readonly string[]) => void) {
    return this.updates.subscribe(endpointId, listener);
  }
  source(read: () => EndpointPresence[]) {
    this.snapshot = read;
  }
  private record(outcome: string, endpointId: string, capabilityId: string, botId?: string) {
    this.audit.append({
      botId: botId ?? this.bots.getMain()?.id ?? "",
      kind: "remote.changed",
      summary: "Endpoint capability / 设备能力",
      detail: {
        target: capabilityId,
        reasonCode: outcome,
        ...(endpointId === "local" || endpointId === "missing" || endpointId.startsWith("runner:")
          ? {}
          : { deviceId: endpointId }),
      },
    });
  }
  /** Identity comes from the authenticated owner, never from the manifest. */
  receive(endpointId: string, input: unknown, legacy?: ReadonlyMap<string, boolean>) {
    const manifest = CapabilityManifestSchema.parse(input);
    const owner =
      endpointId === "local"
        ? "desktop"
        : this.snapshot().find((d) => d.id === endpointId && (legacy || d.online))?.kind;
    if (owner !== manifest.endpointKind)
      throw new RpcError(RpcErrorCodes.invalidParams, "endpoint_identity_mismatch");
    transaction(this.ctx.db, () => {
      const present = new Set(manifest.capabilities.map((item) => item.id));
      for (const def of this.definitions.values()) {
        const previous = this.repo.get(endpointId, def.id);
        if (previous && !present.has(def.id))
          this.repo.put({ ...previous.row, availability: "unsupported" }, previous.attributes);
      }
      for (const item of manifest.capabilities) {
        const def = this.definitions.get(item.id);
        if (!def || def.version !== item.version || def.kind !== manifest.endpointKind) {
          const old = this.repo.get(endpointId, item.id);
          if (old) this.repo.put({ ...old.row, availability: "unsupported" }, old.attributes);
          this.record("endpoint_capability_unknown", endpointId, "unknown");
          continue;
        }
        const previous = this.repo.get(endpointId, item.id);
        const a = def.attributes;
        const widened =
          previous &&
          ((!a.readOnly && previous.attributes.readOnly) ||
            (a.writesFile && !previous.attributes.writesFile) ||
            (a.egress && !previous.attributes.egress) ||
            (a.privacy && !previous.attributes.privacy));
        const auto = a.readOnly && !a.writesFile && !a.egress && !a.privacy;
        const legacyState = legacy?.get(item.id) === true ? "user_on" : auto ? "auto_on" : "off";
        const state = widened
          ? "off"
          : previous && (previous.managed || !legacy)
            ? previous.row.state
            : legacyState;
        const now = new Date().toISOString();
        const row: EndpointCapabilityRow = {
          endpointId,
          capabilityId: item.id,
          version: item.version,
          state,
          // A phone capability with no trusted tool (phone.ui / phone.shell until their operation
          // contract exists) stays unsupported whatever the phone reports.
          availability:
            def.kind === "phone" && def.toolNames.length === 0 ? "unsupported" : item.availability,
          firstSeenAt: previous?.row.firstSeenAt ?? now,
          lastSeenAt: now,
          lastCalledAt: previous?.row.lastCalledAt ?? null,
          scope: previous?.row.scope ?? { botIds: null, groupIds: null },
        };
        this.repo.put(row, a, widened ? true : previous?.managed);
        const attributesChanged =
          previous &&
          Object.keys(a).some(
            (key) => a[key as keyof typeof a] !== previous.attributes[key as keyof typeof a],
          );
        if (previous && previous.row.state !== state)
          this.record(state === "off" ? "endpoint_off" : "endpoint_user_on", endpointId, item.id);
        if (!previous || attributesChanged)
          this.record(
            attributesChanged ? "endpoint_attributes_changed" : "endpoint_first_seen",
            endpointId,
            item.id,
          );
      }
    });
    if (!legacy) {
      this.declared.add(endpointId);
      this.online.add(endpointId);
    }
    this.updates.publish(endpointId, this.enabled(endpointId));
    this.ctx.peer.emit("endpoints.changed", {});
  }
  refresh() {
    this.sync();
  }
  private sync() {
    const devices = this.snapshot();
    this.presence = devices;
    this.online = new Set([
      "local",
      ...devices
        .filter((d) => d.online && (d.kind !== "phone" || d.phoneData || this.declared.has(d.id)))
        .map((d) => d.id),
    ]);
    this.targets = new Map(devices.flatMap((d) => (d.target ? [[d.target, d.id]] : [])));
    for (const d of devices) {
      if (this.declared.has(d.id) || (d.kind === "phone" && !d.phoneData)) continue;
      if (!d.online && this.repo.get(d.id, "runner.exec")) continue;
      const { manifest, legacy } = legacyEndpoint(d, this.endpointCapabilityCatalog);
      const changed = manifest.capabilities.some((c) => {
        const old = this.repo.get(d.id, c.id);
        const definition = this.definitions.get(c.id);
        return (
          !old ||
          old.row.version !== c.version ||
          old.row.availability !== c.availability ||
          (definition && JSON.stringify(old.attributes) !== JSON.stringify(definition.attributes))
        );
      });
      if (changed) this.receive(d.id, manifest, legacy);
    }
  }
  private wakePhone?: (id: string, signal: AbortSignal) => Promise<void>;
  wake(callback: (id: string, signal: AbortSignal) => Promise<void>) {
    this.wakePhone = callback;
  }
  async prepare(tool: string, context: EndpointToolScope, signal: AbortSignal) {
    const target = this.resolve(tool, context);
    if (
      target &&
      !this.online.has(target.id) &&
      target.def.kind === "phone" &&
      this.permittedOrMissing(target.id, target.def.id, context)
    ) {
      await this.wakePhone?.(target.id, signal);
      signal.throwIfAborted();
      this.refresh();
    }
  }
  private resolve(
    tool: string,
    context: EndpointToolScope,
  ): { id: string; def: EndpointCapabilityDefinition } | undefined {
    let capability: string | undefined;
    if (this.definitions.get("desktop.computer")?.toolNames.includes(tool))
      capability = "desktop.computer";
    else if (tool.startsWith("browser_")) capability = "desktop.browser";
    else if (this.definitions.get("desktop.office-render")?.toolNames.includes(tool))
      capability = "desktop.office-render";
    else if (tool.startsWith("phone_"))
      capability =
        tool === "phone_sms_code"
          ? "phone.sms"
          : tool === "phone_calls"
            ? "phone.calls"
            : tool === "phone_notifications"
              ? "phone.notifications"
              : "phone.media";
    if (
      capability === "desktop.browser" &&
      context.capabilities?.get("browser")?.startsWith("connector:")
    )
      return;
    let id = "local";
    const computerTarget = context.runWorkplace?.boundary.location?.target;
    if (capability === "desktop.computer" && computerTarget?.startsWith("runner:")) {
      capability = "runner.computer";
      id = this.targets.get(computerTarget) ?? computerTarget;
    }
    if (capability?.startsWith("phone.")) {
      const phoneCapability = capability;
      const phones = this.presence
        .filter((d) => d.kind === "phone")
        .sort((a, b) => Number(this.online.has(b.id)) - Number(this.online.has(a.id)));
      const selected =
        context.endpointPhoneId ??
        phones.find((d) => {
          const row = this.repo.get(d.id, phoneCapability)?.row;
          return row && this.permitted(row, context);
        })?.id ??
        phones[0]?.id ??
        "missing";
      context.endpointPhoneId = selected;
      id = selected;
    } else if (!capability) {
      const target = context.runWorkplace?.boundary.location?.target;
      if (!target?.startsWith("runner:")) return;
      const def = this.endpointCapabilityCatalog.find(
        (d) => d.kind === "runner" && d.toolNames.includes(tool),
      );
      if (!def) return;
      capability = def.id;
      id = this.targets.get(target) ?? target;
    }
    const def = capability && this.definitions.get(capability);
    return def ? { id, def } : undefined;
  }
  private permitted(row: EndpointCapabilityRow, context: EndpointToolScope) {
    return (
      row.state !== "off" &&
      row.availability === "available" &&
      (row.scope.botIds === null || row.scope.botIds.includes(context.botId)) &&
      (!context.groupId ||
        row.scope.groupIds === null ||
        row.scope.groupIds.includes(context.groupId))
    );
  }
  allows(tool: string, context: EndpointToolScope) {
    const target = this.resolve(tool, { ...context });
    if (!target) return true;
    const row = this.repo.get(target.id, target.def.id)?.row;
    return (
      (this.online.has(target.id) || (target.def.kind === "phone" && !!this.wakePhone)) &&
      !!row &&
      this.permitted(row, context)
    );
  }
  check(tool: string, context: EndpointToolScope) {
    const target = this.resolve(tool, context);
    if (!target) return;
    const code = !this.online.has(target.id)
      ? "endpoint_offline"
      : !this.permittedOrMissing(target.id, target.def.id, context)
        ? "capability_off"
        : undefined;
    if (code) {
      this.record(code, target.id, target.def.id, context.botId);
      throw new RpcError(RpcErrorCodes.unsupported, code);
    }
  }
  private permittedOrMissing(id: string, capability: string, context: EndpointToolScope) {
    const row = this.repo.get(id, capability)?.row;
    return !!row && this.permitted(row, context);
  }
  called(tool: string, context: EndpointToolScope) {
    const target = this.resolve(tool, context);
    if (!target) return;
    const value = this.repo.get(target.id, target.def.id);
    if (value)
      this.repo.put({ ...value.row, lastCalledAt: new Date().toISOString() }, value.attributes);
  }
  list(after = "", limit = 50, endpointId?: string) {
    this.sync();
    const presence = new Map(this.presence.map((device) => [device.id, device]));
    const rows = this.repo.page(
      after,
      limit + 1,
      ["local", ...presence.keys()].filter((id) => !endpointId || id === endpointId),
    );
    const last = rows[limit - 1]?.row;
    return {
      items: rows
        .slice(0, limit)
        .map(({ row }) =>
          endpointCapabilityView(
            row,
            this.definitions.get(row.capabilityId),
            this.online.has(row.endpointId),
            presence.get(row.endpointId),
          ),
        ),
      nextAfter: rows.length > limit && last ? `${last.endpointId}:${last.capabilityId}` : null,
    };
  }
  set(
    input: {
      endpointId: string;
      capabilityId: string;
      enabled: boolean;
      scope: EndpointCapabilityRow["scope"];
      expected?: Pick<EndpointCapabilityRow, "version" | "state" | "scope">;
    },
    fromPhone: boolean,
  ) {
    this.sync();
    if (input.endpointId !== "local" && !this.presence.some((d) => d.id === input.endpointId))
      throw new RpcError(RpcErrorCodes.unsupported, "endpoint_unavailable");
    const result = transaction(this.ctx.db, () => {
      if (
        input.scope.botIds?.some((id) => !this.bots.get(id)) ||
        input.scope.groupIds?.some((id) => !this.groups.get(id))
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "endpoint_scope_invalid");
      const previous = this.repo.get(input.endpointId, input.capabilityId);
      if (!previous) throw new RpcError(RpcErrorCodes.invalidParams, "capability_off");
      const { expected } = input;
      if (
        (fromPhone && !expected) ||
        (expected &&
          (expected.version !== previous.row.version ||
            expected.state !== previous.row.state ||
            JSON.stringify(expected.scope) !== JSON.stringify(previous.row.scope)))
      )
        throw new RpcError(RpcErrorCodes.invalidParams, "endpoint_snapshot_changed");
      if (fromPhone) {
        const broadens = (before: string[] | null, after: string[] | null) => {
          if (before === null) return false;
          const allowed = new Set(before);
          return after === null || after.some((id) => !allowed.has(id));
        };
        const grants =
          (input.enabled && previous.row.state === "off") ||
          broadens(previous.row.scope.botIds, input.scope.botIds) ||
          broadens(previous.row.scope.groupIds, input.scope.groupIds);
        // The authenticated phone is a manager. It cannot grant a missing or unavailable capability.
        // The app's local biometric prompt never enters this authorization decision.
        if (
          grants &&
          (this.definitions.get(input.capabilityId)?.version !== previous.row.version ||
            !this.online.has(input.endpointId) ||
            previous.row.availability !== "available")
        )
          throw new RpcError(RpcErrorCodes.unsupported, "endpoint_unavailable");
      }
      const row: EndpointCapabilityRow = {
        ...previous.row,
        state: input.enabled ? "user_on" : "off",
        scope: input.scope,
      };
      this.repo.put(row, previous.attributes, true);
      this.record(
        input.enabled ? "endpoint_user_on" : "endpoint_off",
        input.endpointId,
        input.capabilityId,
      );
      return row;
    });
    this.ctx.peer.emit("endpoints.changed", {});
    this.updates.publish(input.endpointId, this.enabled(input.endpointId));
    return result;
  }
}
