import { z } from "zod";
import { SafeSecretSchema, WebUrlSchema } from "../core/values.ts";

const name = z.string().trim().min(1).max(200);
export const CloudCredentialsSchema = z.discriminatedUnion("providerId", [
  z.strictObject({
    providerId: z.literal("amazon-bedrock"),
    region: name,
    auth: z.union([
      z.strictObject({
        kind: z.literal("keys"),
        accessKeyId: SafeSecretSchema,
        secretAccessKey: SafeSecretSchema,
        sessionToken: SafeSecretSchema.optional(),
      }),
      z.strictObject({ kind: z.literal("profile"), profile: name }),
    ]),
  }),
  z.strictObject({
    providerId: z.literal("google-vertex"),
    project: name,
    location: name,
    auth: z.union([
      z.strictObject({
        kind: z.literal("serviceAccount"),
        serviceAccountJson: SafeSecretSchema.refine(
          (value) => new TextEncoder().encode(value).byteLength <= 1048576,
          "Service account JSON too large",
        ),
      }),
      z.strictObject({ kind: z.literal("adc") }),
    ]),
  }),
  z.strictObject({
    providerId: z.literal("azure"),
    endpoint: WebUrlSchema,
    apiVersion: name,
    deployments: z.record(name, name),
    apiKey: SafeSecretSchema,
  }),
  z.strictObject({
    providerId: z.literal("cloudflare-workers-ai"),
    accountId: name,
    apiToken: SafeSecretSchema,
  }),
  z.strictObject({
    providerId: z.literal("cloudflare-ai-gateway"),
    accountId: name,
    gatewayId: name,
    apiToken: SafeSecretSchema,
  }),
]);
export const CloudConfigSchema = z.discriminatedUnion("providerId", [
  z
    .strictObject({
      providerId: z.literal("amazon-bedrock"),
      region: name,
      mode: z.enum(["keys", "profile"]),
      profile: name.optional(),
    })
    .refine((v) => v.mode !== "profile" || !!v.profile, "Profile name required"),
  z.strictObject({
    providerId: z.literal("google-vertex"),
    project: name,
    location: name,
    mode: z.enum(["serviceAccount", "adc"]),
  }),
  z.strictObject({
    providerId: z.literal("azure"),
    endpoint: WebUrlSchema,
    apiVersion: name,
    deployments: z.record(name, name),
  }),
  z.strictObject({
    providerId: z.literal("cloudflare-workers-ai"),
    accountId: name,
  }),
  z.strictObject({
    providerId: z.literal("cloudflare-ai-gateway"),
    accountId: name,
    gatewayId: name,
  }),
]);
export const ProviderAuthStateSchema = z.strictObject({
  providerId: name,
  state: z.enum(["disconnected", "connecting", "connected", "reauthRequired", "error"]),
  error: z
    .enum([
      "cancelled",
      "timeout",
      "auth_failed",
      "network",
      "internal",
      // Sign in with ChatGPT: another account than the one registered here, or an ID token
      // that failed verification.
      "account_mismatch",
      "verification_failed",
    ])
    .optional(),
});
export const SearchConfigSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    provider: z.literal("keyless"),
    configured: z.boolean(),
    disclosed: z.boolean(),
  }),
  z.strictObject({ provider: z.literal("bing"), configured: z.boolean(), disclosed: z.boolean() }),
  z.strictObject({
    provider: z.literal("duckduckgo"),
    configured: z.boolean(),
    disclosed: z.boolean(),
  }),
  z.strictObject({ provider: z.literal("brave"), configured: z.boolean(), disclosed: z.boolean() }),
  z.strictObject({
    provider: z.literal("tavily"),
    configured: z.boolean(),
    disclosed: z.boolean(),
  }),
  z.strictObject({
    provider: z.literal("keenable"),
    configured: z.boolean(),
    disclosed: z.boolean(),
  }),
  z.strictObject({
    provider: z.literal("searxng"),
    baseUrl: WebUrlSchema,
    configured: z.boolean(),
    disclosed: z.boolean(),
  }),
]);

export type CloudConfig = z.infer<typeof CloudConfigSchema>;
export type ProviderAuthState = z.infer<typeof ProviderAuthStateSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
