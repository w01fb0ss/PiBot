import { isAbsolute } from "node:path";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js";
import { z } from "zod";

export const SANDBOX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const path = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => isAbsolute(value) && !/[\0\r\n]/.test(value));
// SRT accepts an explicit empty parentProxy to disable ambient fallback, although its schema
// only permits URLs. Validate every other field, then restore only this exact trusted sentinel.
const normalizeConfig = (value: unknown) => {
  if (!value || typeof value !== "object" || !("network" in value)) return value;
  const network = value.network;
  if (!network || typeof network !== "object" || !("parentProxy" in network)) return value;
  const proxy = network.parentProxy;
  if (
    proxy &&
    typeof proxy === "object" &&
    Object.keys(proxy).length === 3 &&
    "http" in proxy &&
    proxy.http === "" &&
    "https" in proxy &&
    proxy.https === "" &&
    "noProxy" in proxy &&
    proxy.noProxy === ""
  )
    return { ...value, network: { ...network, parentProxy: undefined } };
  return value;
};
const config = z.unknown().transform((value) => {
  const parsed = SandboxRuntimeConfigSchema.parse(normalizeConfig(value));
  parsed.network.parentProxy ??= { http: "", https: "", noProxy: "" };
  return parsed;
});

export const SandboxHostPayloadSchema = z.strictObject({
  hostSsh: z
    .strictObject({
      hostname: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
      user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/),
      port: z.number().int().min(1).max(65535),
      identity: path,
      knownHosts: path,
      remoteCommand: z
        .string()
        .min(1)
        .max(16_384)
        .refine((value) => !/[\0\r\n]/.test(value) && !value.trimStart().startsWith("-")),
      connectTimeout: z.number().int().min(1).max(120).optional(),
      quiet: z.boolean().optional(),
    })
    .optional(),
  config,
  allowAll: z.boolean(),
  privateNetworkHosts: z.array(z.string().min(1).max(512)).max(200).optional(),
  command: z
    .string()
    .min(1)
    .max(256 * 1024)
    .refine((value) => !value.includes("\0")),
  commandId: z.string().min(1).max(128),
  cwd: path,
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(131_072))
    .refine((value) => Object.keys(value).length <= 256),
  foreground: z.boolean().optional(),
  isolationProbe: z.literal(true).optional(),
  waitForDispatch: z.boolean().optional(),
  /** MCP stdio server: the command's stdin/stdout are pipe fds 4/5, not the job log. */
  stdioServer: z.boolean().optional(),
  connectorNetwork: z.literal(true).optional(),
  stdinPipe: z.boolean().optional(),
  commandText: z
    .string()
    .min(1)
    .max(256 * 1024)
    .optional(),
});

export function parseSandboxPayload(line: string) {
  if (Buffer.byteLength(line) > SANDBOX_PAYLOAD_BYTES) throw new Error("invalid_payload");
  return SandboxHostPayloadSchema.parse(JSON.parse(line));
}
