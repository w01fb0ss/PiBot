import type { BrowserExtensionStatusSchema } from "@pibot/protocol";
import type { z } from "zod";

type BrowserId = NonNullable<z.infer<typeof BrowserExtensionStatusSchema>["defaultBrowser"]>["id"];

const CHROME_STORE =
  "https://chromewebstore.google.com/detail/pi-bot-browser/pnjdgninncjgoedhbaiollbhkhfmlngl";

export const browserExtensionStores: Partial<Record<BrowserId, string>> = {
  chrome: CHROME_STORE,
  edge: CHROME_STORE,
  brave: CHROME_STORE,
  chromium: CHROME_STORE,
  firefox: "https://addons.mozilla.org/firefox/addon/pibot-browser/",
};
