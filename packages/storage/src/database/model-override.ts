import { ModelOverrideSchema } from "@pibot/protocol-base";

export function modelOverrideProjection(value: unknown) {
  return typeof value === "string"
    ? { modelOverride: ModelOverrideSchema.parse(JSON.parse(value)) }
    : {};
}
