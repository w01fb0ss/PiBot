import { z } from "zod";
import type { CapabilityToolSpec } from "./capability-tools.ts";

export const EndpointKindSchema = z.enum(["desktop", "runner", "phone"]);
export type EndpointKind = z.infer<typeof EndpointKindSchema>;
export const EndpointCapabilityIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/);
export type EndpointCapabilityId = z.infer<typeof EndpointCapabilityIdSchema>;
export const CapabilityAvailabilitySchema = z.enum([
  "available",
  "local_switch_off",
  "unsupported",
]);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;
export const EndpointAttributesSchema = z.strictObject({
  readOnly: z.boolean(),
  writesFile: z.boolean(),
  egress: z.boolean(),
  privacy: z.boolean(),
});
export const CapabilityManifestSchema = z.strictObject({
  endpointKind: EndpointKindSchema,
  platform: z.enum(["darwin", "win32", "linux", "android", "ios"]),
  appVersion: z.string().min(1).max(80),
  capabilities: z
    .array(
      z.strictObject({
        id: EndpointCapabilityIdSchema,
        version: z.number().int().positive().safe(),
        availability: CapabilityAvailabilitySchema,
        reason: z.string().max(80).optional(),
      }),
    )
    .max(64)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export interface EndpointCapabilityDefinition {
  id: EndpointCapabilityId;
  version: number;
  kind: EndpointKind;
  name: { zh: string; en: string };
  attributes: z.infer<typeof EndpointAttributesSchema>;
  tools: Readonly<Record<string, CapabilityToolSpec>>;
  toolNames: readonly string[];
}
export const EndpointScopeSchema = z.strictObject({
  botIds: z.array(z.string().uuid()).max(1000).nullable(),
  groupIds: z.array(z.string().uuid()).max(1000).nullable(),
});
export const EndpointCapabilityRowSchema = z.strictObject({
  endpointId: z.string().min(1).max(100),
  capabilityId: EndpointCapabilityIdSchema,
  version: z.number().int().positive(),
  state: z.enum(["auto_on", "user_on", "off"]),
  availability: CapabilityAvailabilitySchema,
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  lastCalledAt: z.iso.datetime().nullable(),
  scope: EndpointScopeSchema,
});
export type EndpointCapabilityRow = z.infer<typeof EndpointCapabilityRowSchema>;
export interface EndpointToolScope {
  capabilities?: { get(key: "browser"): string | undefined };
  botId: string;
  groupId?: string;
  runWorkplace?: { boundary: { location?: { target: string } } };
  endpointPhoneId?: string;
}
export interface EndpointCapabilityPort {
  phoneOnline?(id: string): boolean;
  prepare?(tool: string, context: EndpointToolScope, signal: AbortSignal): Promise<void>;
  allows(tool: string, context: EndpointToolScope): boolean;
  check(tool: string, context: EndpointToolScope): void;
  called(tool: string, context: EndpointToolScope): void;
}

export interface EndpointPresence {
  id: string;
  name?: string;
  target?: string;
  kind: "runner" | "phone";
  online: boolean;
  phoneData?: { platform: "android" | "ios"; media: boolean; smsCode: boolean };
  isolation?: { available: boolean };
}
export interface EndpointRegistrySource {
  wake?(callback: (id: string, signal: AbortSignal) => Promise<void>): void;
  source(read: () => EndpointPresence[]): void;
  refresh(): void;
  receive(endpointId: string, input: unknown): void;
  enabled(endpointId: string): readonly string[];
  subscribe(endpointId: string, listener: (ids: readonly string[]) => void): () => void;
}

export const EndpointSessionEvents = {
  "endpoint.manifest": CapabilityManifestSchema,
  "endpoint.enabled": z.strictObject({
    capabilities: z.array(EndpointCapabilityIdSchema).max(64),
  }),
} as const;
