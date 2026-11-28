import type { BrainCapability } from "@pibot/brain/kit";
import { type DirectDiagnostic, DirectDiagnosticSchema } from "@pibot/link";
import { OFFICIAL_RELAY_URL, PHONE_DATA_PORT, type PhoneDataPort } from "@pibot/remote-contract";
import { endpointDevices } from "../devices/endpoints.ts";
import { createLanRemoteLink } from "../lan/link.ts";
import { createRemoteLink } from "../link/adapter.ts";
import { phoneDataPort } from "../phone-data/port.ts";
import { phoneDataTools } from "../phone-data/tools.ts";
import { runnerWorkplaceTools } from "../runners/tools.ts";
import { remoteResources } from "./context.ts";
import { type RemoteOptions, RemoteService } from "./service.ts";

export function remoteCapability(options: RemoteOptions = {}): BrainCapability {
  return {
    id: "remote",
    register(ctx) {
      const onDirectDiagnostic = (event: DirectDiagnostic) => {
        const parsed = DirectDiagnosticSchema.safeParse(event);
        if (parsed.success)
          ctx.logger.info(JSON.stringify({ module: "remote-direct", ...parsed.data }));
      };
      const relay =
        options.link ??
        createRemoteLink({
          proxy: ctx.local.deps.proxy,
          officialRelayUrl: OFFICIAL_RELAY_URL,
          createRtcPeer: options.createRtcPeer,
          onDirectDiagnostic,
        });
      const service = new RemoteService(remoteResources(ctx), {
        ...options,
        link: !options.link
          ? createLanRemoteLink(relay, {
              createPeer: options.createRtcPeer,
              onDirectDiagnostic,
              warn: (reason, suppressed) =>
                ctx.logger.warn(
                  JSON.stringify({
                    module: "remote.lan",
                    code: reason ?? "lan_discovery_unavailable",
                    ...(suppressed ? { suppressed } : {}),
                  }),
                ),
            })
          : relay,
      });
      ctx.ports.provide("interactive-client", service.interactivePort());
      ctx.ports
        .get<import("@pibot/protocol-base").EndpointRegistrySource>("endpoints.registry")
        ?.source(() => {
          const devices: import("@pibot/protocol-base").EndpointPresence[] = [];
          let after: string | undefined;
          do {
            const page = service.list({ after, limit: 100 });
            devices.push(...page.items.filter((d) => !d.revokedAt));
            after = page.nextAfter ?? undefined;
          } while (after);
          return devices;
        });
      ctx.ports
        .get<import("@pibot/protocol-base").EndpointRegistrySource>("endpoints.registry")
        ?.refresh();
      ctx.rpc.handle("remote.settings.get", async () => service.r.settings.get());
      ctx.rpc.handle("remote.settings.set", ({ expectedVersion, patch, disclosureAccepted }) =>
        service.setSettings(expectedVersion, patch, disclosureAccepted),
      );
      ctx.rpc.handle("remote.runnerControl.get", ({ phoneId, after, runnerDeviceId }) =>
        service.phoneAuthorizations.view(phoneId, after, runnerDeviceId),
      );
      ctx.rpc.handle(
        "remote.runnerControl.set",
        ({ phoneId, runnerDeviceId, enabled, expectedRevision }, { signal }) =>
          service.phoneAuthorizations.set(
            phoneId,
            runnerDeviceId,
            enabled,
            expectedRevision,
            signal,
          ),
      );
      ctx.rpc.handle("remote.status", async () => service.state());
      ctx.rpc.handle("devices.pairStart", (params) =>
        service.pairStart(params && "kind" in params ? params.kind : undefined),
      );
      ctx.rpc.handle("devices.runnerPair", ({ code }, { signal }) =>
        service.pairRunner(code, signal),
      );
      ctx.rpc.handle("devices.pairStatus", async ({ id }) => service.pairing.status(id));
      ctx.rpc.handle("devices.pairCancel", async ({ id }) => {
        await service.pairing.cancel(id);
        return { ok: true };
      });
      ctx.rpc.handle("devices.endpoints", async (params) => endpointDevices(service, params));
      ctx.rpc.handle("devices.list", (params) => service.listWithCodes(params));
      ctx.rpc.handle("devices.rename", ({ id, name }) => service.rename(id, name));
      ctx.rpc.handle("devices.revoke", ({ id, removeAnyway }) => service.revoke(id, removeAnyway));
      // Which models and Bots each phone may use while the computer is unreachable.
      ctx.rpc.handle("remote.offline.get", ({ deviceId }) => service.offline.view(deviceId));
      ctx.rpc.handle("remote.offline.set", (params) =>
        service.offline.set(params.deviceId, params),
      );
      // Bots reach the paired phone through this port and the phone tools built on it.
      ctx.ports
        .get<import("@pibot/protocol-base").EndpointRegistrySource>("endpoints.registry")
        ?.wake?.((id, signal) => service.wakePhone(id, signal));
      const phoneData = phoneDataPort(service.connections);
      ctx.ports.provide<PhoneDataPort>(PHONE_DATA_PORT, phoneData);
      phoneDataTools(ctx, phoneData);
      runnerWorkplaceTools(ctx, service);
      // Device identity/session updates are installed only on the authenticated phone gateway.
      ctx.sleep.participate({
        idle: () => service.idle(),
        pause: (signal) => service.pause(signal),
        resume: () => service.resume(),
      });
      return { start: () => service.start(), stop: () => service.stop() };
    },
  };
}
