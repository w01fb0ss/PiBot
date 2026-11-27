// Offline: the HTTP layer is replaced, so no real network, key or user directory is touched.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SearchStatusError, type searchJson } from "@pibot/execution";
import { createRedactor, type SecretCipher } from "@pibot/secrets";
import { openDatabase, runMigrations } from "@pibot/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failure } from "./search-run.ts";
import { SearchService } from "./search-service.ts";

// A reversible test cipher, deliberately not suitable for production encryption.
const cipher: SecretCipher = {
  isAvailable: async () => true,
  encrypt: async (plain) => Uint8Array.from(Buffer.from(plain), (byte) => byte ^ 0xa5),
  decrypt: async (encrypted) => Buffer.from(encrypted.map((byte) => byte ^ 0xa5)).toString(),
};
const KEY = "opaque-test-credential-1234";

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pibot-keenable-"));
  db = openDatabase(join(dir, "pibot.db"));
  runMigrations(db);
}, 30_000);
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (http: typeof searchJson) =>
  new SearchService(db, cipher, createRedactor(), () => {}, http);
const never = vi.fn(async () => {
  throw new Error("network must not be used");
}) as unknown as typeof searchJson;

describe("Keenable search provider", () => {
  it("is never the default: nothing changes until a key is saved", async () => {
    const search = service(never);
    expect(search.get()?.provider).toBe("keyless");
    // Picking Keenable without a key is not configured, so the keyless default stays in effect.
    await search.set({ provider: "keenable" });
    expect(search.get()?.provider).toBe("keyless");
    expect(never).not.toHaveBeenCalled();
  });

  it("sends a keyed POST with only the app name as identification", async () => {
    const http = vi.fn(async (_input: Parameters<typeof searchJson>[0]) => ({
      query: "q",
      mode: "pro",
      results: [
        {
          title: "A page",
          url: "https://example.com/a",
          description: "",
          snippet: "Text from the page",
        },
        { title: "Not http", url: "file:///etc/passwd", snippet: "x" },
      ],
    }));
    const search = service(http as unknown as typeof searchJson);
    await search.set({ provider: "keenable", apiKey: KEY });
    search.disclose("keenable");
    const results = await search.query("pi bot", 5, new AbortController().signal);
    expect(results).toEqual([
      expect.objectContaining({
        title: "A page",
        url: "https://example.com/a",
        snippet: "Text from the page",
      }),
    ]);
    const call = http.mock.calls[0]?.[0];
    expect(call?.url).toBe("https://api.keenable.ai/v1/search");
    expect(call?.method).toBe("POST");
    expect(call?.headers).toEqual({
      accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": KEY,
      "X-Keenable-Title": "Pi Bot",
    });
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      query: "pi bot",
      max_results: 5,
      snippet_max_length: 1000,
    });
  });

  it("does not send the Keenable header to other providers", async () => {
    const http = vi.fn(async () => ({ results: [] }));
    const search = service(http as unknown as typeof searchJson);
    await search.set({ provider: "tavily", apiKey: KEY });
    search.disclose("tavily");
    await search.query("q", 3, new AbortController().signal);
    const headers = (http.mock.calls[0] as unknown as [{ headers: Record<string, string> }])[0]
      .headers;
    expect(headers).not.toHaveProperty("X-Keenable-Title");
    expect(headers).not.toHaveProperty("X-API-Key");
  });

  it("removes the stored key with the rest of the search configuration", async () => {
    const search = service(never);
    await search.set({ provider: "keenable", apiKey: KEY });
    expect(search.secrets.has("search:keenable", "apiKey")).toBe(true);
    search.remove();
    expect(search.secrets.has("search:keenable", "apiKey")).toBe(false);
    expect(search.get()?.provider).toBe("keyless");
  });
});

describe("Keenable search errors", () => {
  const text = (status: number) => failure(new SearchStatusError(status), "Keenable").en;

  it("tells the user what to do on a 429", () => {
    expect(text(429)).toMatch(/rate limiting.*switch the search service/);
  });
  it("asks for a different key on 401 and 403", () => {
    expect(text(401)).toMatch(/rejected the API key.*key in settings/);
    expect(text(403)).toMatch(/rejected the API key/);
  });
  it("reports missing credits on 402", () => {
    expect(text(402)).toMatch(/out of credits/);
  });
  it("names the status for any other failure instead of returning an empty result", () => {
    expect(text(500)).toMatch(/HTTP 500/);
    expect(failure(new SearchStatusError(429), "Keenable").zh).toContain("429");
  });
  it("leaves other providers' error text alone", () => {
    expect(failure(new SearchStatusError(429), "Tavily").en).toBe(
      "Search could not complete; check the service configuration",
    );
  });
});
