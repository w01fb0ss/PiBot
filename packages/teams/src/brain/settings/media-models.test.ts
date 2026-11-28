import type { CapabilityContext, ToolRunContext } from "@pibot/brain/kit";
import { createRedactor } from "@pibot/secrets";
import { expect, it } from "vitest";
import { readMediaModels } from "./media-models.ts";

it.each([false, true])(
  "offers the requested disabled model when Mini enabled is %s",
  async (miniEnabled) => {
    const mini = { id: "bytedance/seedance-2.0-mini", priceUsdPerSecond: 0.03 };
    const flash = { id: "bytedance/seedance-2.5-flash", priceUsdPerSecond: 0.05 };
    const enable = (model: typeof mini) => ({
      kind: "enable_video_model",
      providerId: "openrouter",
      model,
    });
    const ctx = {
      redactor: createRedactor(),
      local: {
        models: {
          videoProviders: () =>
            miniEnabled ? [{ id: "openrouter", name: "OpenRouter", videoModels: [mini] }] : [],
          videoModelsToEnable: () =>
            miniEnabled ? [enable(flash)] : [enable(mini), enable(flash)],
        },
      },
    } as CapabilityContext;
    const run = { language: "en" } as ToolRunContext;
    const signal = new AbortController().signal;
    const list = await readMediaModels(ctx, run, "video", undefined, 0, signal);
    expect(JSON.parse(list.text).models).toMatchObject([
      { ...mini, provider: "openrouter", enabled: miniEnabled },
      { ...flash, provider: "openrouter", enabled: false },
    ]);
    expect(list.details).toBeUndefined();

    const result = await readMediaModels(
      ctx,
      run,
      "video",
      { provider: "openrouter", id: flash.id },
      0,
      signal,
    );
    expect(result.details?.settingsAction).toEqual(enable(flash));
  },
);
