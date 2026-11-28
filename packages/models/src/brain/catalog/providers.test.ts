import { createRedactor, type SecretCipher } from "@pibot/secrets";
import { openDatabase, runMigrations, SecretStore } from "@pibot/storage";
import { expect, it, vi } from "vitest";
import { ProviderStore } from "./providers.ts";

it("keeps verified models, rates and disable choices across an empty startup catalog", async () => {
  using db = openDatabase(":memory:");
  runMigrations(db);
  const redactor = createRedactor();
  const cipher: SecretCipher = {
    isAvailable: async () => true,
    encrypt: async (value) => Buffer.from(value),
    decrypt: async (value) => Buffer.from(value).toString(),
  };
  const secrets = new SecretStore(db, cipher, redactor);
  const mini = { id: "bytedance/seedance-2.0-mini", priceUsdPerSecond: 0.03 };
  const flash = { id: "bytedance/seedance-2.5-flash", priceUsdPerSecond: 0.05 };
  const fetchCatalog = vi.fn<typeof fetch>();
  const others = Array.from({ length: 200 }, (_, i) => ({ id: `fixtures/video-${i}` }));
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [] }));
  const signal = new AbortController().signal;
  const store = new ProviderStore(db, cipher, redactor, secrets, {}, fetchCatalog);

  await store.setKey("openrouter", "test-openrouter-credential", signal);
  await store.refreshVideoCatalogForKey("openrouter", signal);
  expect(await store.listVideoModels("openrouter", false, signal)).toMatchObject({
    fallback: true,
  });
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [...others, mini, flash] }));
  const recovered = await store.listVideoModels("openrouter", true, signal);
  expect(recovered.models.slice(0, 2)).toEqual([
    { ...mini, enabled: true },
    { ...flash, enabled: true },
  ]);
  expect(recovered.models).toHaveLength(200);
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [mini, flash] }));
  await store.listVideoModels("openrouter", true, signal);
  await expect(
    store.setVideoModel("openrouter", mini.id, false, signal, () => {
      throw new Error("fixture audit failure");
    }),
  ).rejects.toThrow("fixture audit failure");
  expect(store.videoOptions("openrouter").find(({ id }) => id === mini.id)?.enabled).toBe(true);
  await store.setVideoModel("openrouter", mini.id, false, signal);

  const restarted = new ProviderStore(db, cipher, redactor, secrets, {}, fetchCatalog);
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [] }));
  await restarted.refreshVideoCatalogs(signal);
  expect(await restarted.listVideoModels("openrouter", false, signal)).toEqual({
    models: [
      { ...mini, enabled: false, cachedPricing: true },
      { ...flash, enabled: true, cachedPricing: true },
    ],
    fallback: false,
    unavailable: true,
  });
  expect(restarted.videoProviders()[0]?.videoModels).toEqual([{ ...flash, cachedPricing: true }]);

  const updatedFlash = { ...flash, priceUsdPerSecond: 0.06 };
  fetchCatalog.mockResolvedValueOnce(Response.json({ data: [mini, updatedFlash] }));
  expect(await restarted.listVideoModels("openrouter", true, signal)).toEqual({
    models: [
      { ...mini, enabled: false },
      { ...updatedFlash, enabled: true },
    ],
    fallback: false,
    unavailable: false,
  });
});
