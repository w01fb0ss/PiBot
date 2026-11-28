import { type CapabilityToolSpec, ModelPreferenceSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { piSettingsPrompts } from "./prompts/pi-settings.ts";

const scope = z.string().trim().min(1).max(100);
const key = z.string().trim().min(1).max(100);

export const piSettingsTools = {
  settings_read: {
    mainBotOnly: true,
    rule: piSettingsPrompts.rule,
    schema: z.strictObject({
      scope: scope.optional(),
      mediaModels: z.enum(["video", "image"]).optional(),
      videoModel: ModelPreferenceSchema.optional(),
      offset: z.number().int().nonnegative().safe().optional(),
    }),
    description:
      "Read Settings fields, supported keys and named targets. Scope: app (default), bot:<id>, connection:<id>, permissions:<bot id>, or permissions:global. The yolo field is YOLO for this Pi topic only. YOLO is per topic and cannot be switched for another Bot or globally from here; the person switches it in that topic's header. Credentials are never returned. Use group:<id> to read a group's automatic round limit. Set mediaModels to video or image to list media models and known prices. The video list includes disabled options. For a specific video model, set mediaModels to video and pass its exact {provider,id} as videoModel to show its enable card if needed. Use nextOffset as offset to get more models.",
    policy: { category: "settings_change", operation: "read" },
    attributes: { readOnly: true },
  },
  settings_change: {
    mainBotOnly: true,
    schema: z.strictObject({
      changes: z
        .array(z.strictObject({ scope, key, value: z.json() }))
        .min(1)
        .max(16),
    }),
    description:
      "Propose changes to the fields listed by settings_read, with their exact scope and key. The yolo field changes YOLO for Pi's current topic only. YOLO is per topic. For another Bot's topic, direct the person to its header and offer changes to that Bot's permission levels. There is no global YOLO switch. Each security change needs its own card. Never put credentials in this tool.",
    // Preparation classifies the explicit allowlist. The static fallback always asks.
    policy: { category: "settings_change", operation: "security" },
    attributes: { readOnly: false },
  },
} as const satisfies Record<string, CapabilityToolSpec>;
