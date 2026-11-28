import {
  ExtensionEventSchema,
  type ExtensionMethodName,
  ExtensionMethods,
  ExtensionRequestSchema,
  ExtensionResponseSchema,
  ExtensionStopSchema,
  parseExtensionParams,
} from "@pibot/browser-contract";
import { browserScreenshotErrors } from "@pibot/browser-contract/i18n";

const GROUP_COLOR = "purple";
/** The toolbar badge while a Bot works: Chrome takes a literal colour, not a theme token. */
const BADGE_COLOR = "#9159FE";
const workingBots = new Set<string>();
/** Display names the desktop sent with open, for the popup (it otherwise knows only ids). */
const botNames = new Map<string, string>();
/** Why the native host went away, for the popup: never registered, or Pi Bot closed. */
let nativeProblem: "host_missing" | "disconnected" | undefined;
const botGroups = new Map<string, number>();
const botTabs = new Map<string, Set<number>>();
let piBotWindow: number | undefined;
const fallbackWindows = new Map<string, number>();
let nativePort: BrowserPort | undefined;
let previousWindow: number | undefined;

function error(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function botIdOf(params: Record<string, unknown>): string {
  return String(params.botId ?? error("browser_invalid_request", "botId is required"));
}
async function ensureWindow(): Promise<number> {
  let windowId = piBotWindow;
  if (windowId !== undefined) {
    try {
      const window = await chrome.windows.get(windowId);
      if (window.id !== undefined) return window.id;
    } catch {
      piBotWindow = undefined;
    }
  }
  const last = await chrome.windows.getLastFocused();
  previousWindow = last.id;
  const created = await chrome.windows.create({ focused: false, type: "normal" });
  const createdId = created.id;
  if (createdId === undefined) error("browser_window_unavailable", "Pi Bot window was not created");
  windowId = createdId;
  piBotWindow = createdId;
  if (previousWindow !== undefined) await chrome.windows.update(previousWindow, { focused: true });
  return createdId;
}
/**
 * Chrome's tab ids are large; Pi Bot's protocol names a tab "t" plus at most six digits, as the
 * built-in browser does. A tab keeps its short name for this browser session.
 */
const tabRefs = new Map<number, string>();
const tabIds = new Map<string, number>();
let nextRef = 1;
function refOf(tabId: number): string {
  let ref = tabRefs.get(tabId);
  if (!ref) {
    ref = `t${nextRef++}`;
    tabRefs.set(tabId, ref);
    tabIds.set(ref, tabId);
  }
  return ref;
}
chrome.tabs.onRemoved.addListener((tabId: number) => {
  const ref = tabRefs.get(tabId);
  tabRefs.delete(tabId);
  if (ref) tabIds.delete(ref);
  for (const ids of botTabs.values()) ids.delete(tabId);
});
async function ensureGroup(
  botId: string,
  botName?: string,
): Promise<{ windowId: number; groupId: number }> {
  const group = chrome.tabs.group;
  const tabGroups = chrome.tabGroups;
  const supportsGroups = typeof group === "function" && tabGroups !== undefined;
  const windowId = supportsGroups ? await ensureWindow() : await ensureFallbackWindow(botId);
  if (!supportsGroups) {
    const tracked = botTabs.get(botId) ?? new Set<number>();
    botTabs.set(botId, tracked);
    const tabs = await chrome.tabs.query({ windowId });
    if (!tabs.some((tab) => tab.id !== undefined && tracked.has(tab.id))) {
      const tab = await chrome.tabs.create({ windowId, active: true });
      if (tab.id !== undefined) tracked.add(tab.id);
    }
    return { windowId, groupId: -1 };
  }
  const title = botName ? `Pi Bot · ${botName}` : undefined;
  const existing = botGroups.get(botId);
  if (existing !== undefined) {
    try {
      const current = await tabGroups.get(existing);
      if (title && current.title !== title) await tabGroups.update(existing, { title });
      return { windowId, groupId: existing };
    } catch {
      // The user closed the group's last tab: start a new one below.
      botGroups.delete(botId);
    }
  }
  const tabs = await chrome.tabs.query({ windowId });
  const free = tabs.find((tab) => tab.groupId === -1);
  const tab = free ?? (await chrome.tabs.create({ windowId, active: true }));
  if (tab.id === undefined) error("browser_tab_not_found", "Pi Bot window has no tab");
  const groupId = await group({ tabIds: [tab.id], createProperties: { windowId } });
  await tabGroups.update(groupId, {
    title: title ?? "Pi Bot",
    color: GROUP_COLOR,
    collapsed: false,
  });
  botGroups.set(botId, groupId);
  return { windowId, groupId };
}
async function ensureFallbackWindow(botId: string): Promise<number> {
  const existing = fallbackWindows.get(botId);
  if (existing !== undefined) {
    try {
      await chrome.windows.get(existing);
      return existing;
    } catch {
      fallbackWindows.delete(botId);
    }
  }
  const created = await chrome.windows.create({ focused: false, type: "normal" });
  if (created.id === undefined)
    error("browser_window_unavailable", "Pi Bot window was not created");
  fallbackWindows.set(botId, created.id);
  // The new window's own blank tab is the Bot's first tab, so no stray tab is left behind.
  const first = created.tabs?.[0]?.id;
  if (first !== undefined) {
    const tracked = botTabs.get(botId) ?? new Set<number>();
    tracked.add(first);
    botTabs.set(botId, tracked);
  }
  return created.id;
}
async function groupTabs(windowId: number, groupId: number, botId?: string) {
  if (groupId < 0) {
    const ids = botId ? botTabs.get(botId) : undefined;
    return (await chrome.tabs.query({ windowId })).filter(
      (tab) => tab.id !== undefined && ids?.has(tab.id),
    );
  }
  return (await chrome.tabs.query({ windowId })).filter((tab) => tab.groupId === groupId);
}
async function selectTab(
  botId: string,
  botName: string | undefined,
  tabRef?: string,
): Promise<{ windowId: number; groupId: number; tab: BrowserTab }> {
  const { windowId, groupId } = await ensureGroup(botId, botName);
  const tabs = await groupTabs(windowId, groupId, botId);
  if (tabRef) {
    const tab = tabs.find((candidate) => candidate.id === tabIds.get(tabRef));
    if (!tab || tab.id === undefined) error("browser_tab_not_found", "Bot tab was not found");
    await chrome.tabs.update(tab.id, { active: true });
    return { windowId, groupId, tab };
  }
  const tab = tabs.find((candidate) => candidate.active) ?? tabs.at(-1);
  if (!tab || tab.id === undefined) error("browser_tab_not_found", "No Bot tab is open");
  return { windowId, groupId, tab };
}
/** Resolves once the tab finished loading, or after `ms` (a page that never settles still answers). */
async function settled(tabId: number, ms = 15_000): Promise<BrowserTab> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      void chrome.tabs.get(tabId).then(resolve, () => resolve(current));
    };
    const listener = (id: number, change: { status?: string }) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function pageOf(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  return {
    tab: refOf(tabId),
    url: tab.url ?? "",
    title: (tab.title ?? "").slice(0, 1000),
    loading: tab.status === "loading",
    blocked: [],
  };
}
async function callContent(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await settled(tabId);
  const send = () => chrome.tabs.sendMessage(tabId, { method, ...params });
  let reply: unknown;
  try {
    reply = await send();
  } catch {
    // Tabs that existed before the extension (or were restored) have no content script yet.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      reply = await send();
    } catch {
      // Firefox keeps an MV3 extension's site access off until the user allows it (popup).
      if (!(await siteAccess()))
        error(
          "browser_site_access_needed",
          "Allow Pi Bot to access websites from its toolbar button",
        );
      error("browser_page_unavailable", "This page cannot be read (browser or store page)");
    }
  }
  const value = (reply ?? {}) as Record<string, unknown>;
  const failure = value.error as { code?: string; message?: string } | undefined;
  if (failure)
    error(failure.code ?? "browser_internal", failure.message ?? "Page operation failed");
  return value;
}
async function snapshotOf(tabId: number, maxChars = 100_000) {
  const content = await callContent(tabId, "snapshot", {});
  const text = String(content.text ?? "");
  return {
    page: await pageOf(tabId),
    tree: String(content.tree ?? "").slice(0, 200_000),
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    refs: Number(content.refs ?? 0),
  };
}
async function handle(method: string, raw: unknown): Promise<unknown> {
  if (method === "stop") {
    const params = ExtensionStopSchema.parse(raw);
    workingBots.delete(params.botId);
    if (!workingBots.size) await chrome.action.setBadgeText({ text: "" });
    emit({ event: "stop", payload: params });
    return null;
  }
  if (!Object.hasOwn(ExtensionMethods, method))
    error("browser_invalid_method", "Unsupported browser method");
  const name = method as ExtensionMethodName;
  const params = parseExtensionParams(name, raw) as Record<string, unknown>;
  const botId = botIdOf(params);
  const botName = typeof params.botName === "string" ? params.botName : undefined;
  if (botName) botNames.set(botId, botName);
  workingBots.add(botId);
  await chrome.action.setBadgeText({ text: "•" });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  const selected = await selectTab(botId, botName, params.tab as string | undefined);
  const tabId = selected.tab.id ?? error("browser_tab_not_found", "Bot tab was not found");
  if (name === "open") {
    const url = String(params.url);
    let target = tabId;
    if (params.newTab) {
      const created = await chrome.tabs.create({ windowId: selected.windowId, url, active: true });
      target = created.id ?? error("browser_tab_not_found", "Tab was not created");
      // Without tab groups (groupId -1) the Bot's tabs are tracked per Bot instead.
      if (selected.groupId >= 0 && chrome.tabs.group)
        await chrome.tabs.group({ tabIds: [target], groupId: selected.groupId });
      else botTabs.get(botId)?.add(target);
    } else await chrome.tabs.update(tabId, { url, active: true });
    await settled(target);
    return pageOf(target);
  }
  if (name === "snapshot") return snapshotOf(tabId, Number(params.maxChars ?? 100_000));
  if (name === "tabs" || name === "close") {
    if (name === "close") await chrome.tabs.remove(tabIds.get(String(params.tab)) ?? tabId);
    const tabs = await groupTabs(selected.windowId, selected.groupId, botId);
    return {
      tabs: tabs
        .filter((tab) => tab.id !== undefined)
        .slice(0, 16)
        .map((tab) => ({
          tab: refOf(tab.id as number),
          title: (tab.title ?? "").slice(0, 1000),
          url: tab.url ?? "",
          active: !!tab.active,
        })),
    };
  }
  if (name === "screenshot") {
    await chrome.tabs.update(tabId, { active: true });
    const active = await chrome.tabs.query({ windowId: selected.windowId, active: true });
    if (active[0]?.id !== tabId)
      error(
        "browser_screenshot_tab_inactive",
        browserScreenshotErrors.en.browser_screenshot_tab_inactive,
      );
    const window = await chrome.windows.get(selected.windowId);
    // A minimized window paints nothing: restore it without focus, give it a frame, then capture.
    if (window.state === "minimized") {
      await chrome.windows.update(selected.windowId, { state: "normal", focused: false });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const data = await captureVisibleTab(selected.windowId, tabId);
    const size = jpegSize(Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
    if (!size) error("browser_screenshot_unavailable", "The screenshot could not be read");
    return { image: { type: "image", data, mimeType: "image/jpeg" }, ...size };
  }
  if (name === "back") {
    const before = (await chrome.tabs.get(tabId)).url;
    try {
      await chrome.tabs.goBack(tabId);
    } catch {
      // Chrome skips entries an extension navigated to without a user gesture; the page's own
      // history still has them.
      await callContent(tabId, "back", {});
    }
    for (let waited = 0; waited < 5000; waited += 100) {
      if ((await chrome.tabs.get(tabId)).url !== before) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await settled(tabId);
    return pageOf(tabId);
  }
  if (name === "inspect") return callContent(tabId, "inspect", params);
  const content = await callContent(tabId, name, params);
  if (name === "wait") return { page: await pageOf(tabId), matched: content.matched === true };
  return pageOf(tabId);
}

const MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2;
let captureTimes: number[] = [];
async function captureVisibleTab(windowId: number, tabId: number): Promise<string> {
  const now = Date.now();
  captureTimes = captureTimes.filter((time) => now - time < 1000);
  if (captureTimes.length >= MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)
    await new Promise((resolve) => setTimeout(resolve, 1000 - (now - (captureTimes[0] ?? now))));
  captureTimes = captureTimes.filter((time) => Date.now() - time < 1000);
  for (let attempt = 0; attempt < 2; attempt++) {
    captureTimes.push(Date.now());
    try {
      return (
        await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 75 })
      ).replace(/^data:image\/jpeg;base64,/, "");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const lower = message.toLowerCase();
      if (
        /^(?:chrome|edge|about|moz-extension|chrome-extension):|chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org|\.pdf(?:$|[?#])/.test(
          (await chrome.tabs.get(tabId)).url ?? "",
        )
      )
        error(
          "browser_screenshot_restricted",
          browserScreenshotErrors.en.browser_screenshot_restricted,
        );
      if (/rate|quota|throttle|max.*second/.test(lower) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (/visible|obscur|focus|window/.test(lower))
        error(
          "browser_screenshot_window_obscured",
          browserScreenshotErrors.en.browser_screenshot_window_obscured,
        );
      error(
        "browser_screenshot_unavailable",
        browserScreenshotErrors.en.browser_screenshot_unavailable,
      );
    }
  }
  error(
    "browser_screenshot_unavailable",
    browserScreenshotErrors.en.browser_screenshot_unavailable,
  );
}
/** Width and height from a JPEG's start-of-frame marker, without decoding the image. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const at = (index: number) => bytes[index] ?? 0;
  if (at(0) !== 0xff || at(1) !== 0xd8) return undefined;
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (at(offset) !== 0xff) return undefined;
    const marker = at(offset + 1);
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (at(offset + 2) << 8) + at(offset + 3);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        height: (at(offset + 5) << 8) + at(offset + 6),
        width: (at(offset + 7) << 8) + at(offset + 8),
      };
    if (marker === 0xda || length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}
function emit(event: unknown) {
  const parsed = ExtensionEventSchema.safeParse(event);
  if (parsed.success) {
    try {
      connectNative().postMessage(parsed.data);
    } catch {
      /* disconnect is reported by the next request */
    }
  }
}
function connectNative(): BrowserPort {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative("com.pibot.browser");
  const openedAt = Date.now();
  nativePort.onMessage.addListener((message: unknown) => {
    void receive(message);
  });
  nativePort.onDisconnect.addListener(() => {
    // Reading lastError here is what keeps Chrome from logging it as unchecked.
    const message = chrome.runtime.lastError?.message ?? "";
    nativeProblem =
      /not found|not registered|forbidden|no such native application|attempt to postmessage/i.test(
        message,
      )
        ? "host_missing"
        : "disconnected";
    nativePort = undefined;
    // A connection that held means Pi Bot itself restarted: come back quickly.
    if (Date.now() - openedAt > 10_000) reconnectDelay = 2_000;
    scheduleReconnect();
  });
  nativeProblem = undefined;
  return nativePort;
}
async function receive(message: unknown) {
  const parsed = ExtensionRequestSchema.safeParse(message);
  if (!parsed.success) return;
  try {
    const result = await handle(parsed.data.method, parsed.data.params);
    connectNative().postMessage(ExtensionResponseSchema.parse({ id: parsed.data.id, result }));
  } catch (caught) {
    const failure = caught as { code?: string; message?: string };
    connectNative().postMessage({
      id: parsed.data.id,
      error: {
        code: failure.code ?? "browser_internal",
        message: failure.message ?? "Browser operation failed",
      },
    });
  }
}
/**
 * Pi Bot can only reach the extension over a connection the extension opens, so it keeps one:
 * at browser start, whenever the worker starts, and again after every disconnect (Pi Bot
 * restarted or quit), backing off to a minute, or five minutes while Pi Bot is not installed.
 * An alarm retries too, because Chrome stops an idle worker and its timers with it.
 */
let reconnectDelay = 2_000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function connect() {
  if (nativePort) return;
  try {
    emit({ event: "hello", payload: { version: __PIBOT_VERSION__, browser: __PIBOT_BROWSER__ } });
  } catch {
    // A failed start reports through onDisconnect, which schedules the next try.
  }
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = nativeProblem === "host_missing" ? 300_000 : reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  reconnectTimer = setTimeout(connect, delay);
}
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
void chrome.alarms.create("pibot-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pibot-reconnect") connect();
});
connect();
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender: { id?: string; tab?: BrowserTab },
    sendResponse: (value: unknown) => void,
  ) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      (message.type === "working" || message.type === "retry_connection")
    ) {
      if (sender.id !== chrome.runtime.id || sender.tab) return false;
      void popupState(message.type === "retry_connection").then(sendResponse);
      return true;
    }
    if (sender.id !== chrome.runtime.id) return false;
    void receive(message).then(() => sendResponse({ ok: true }));
    return true;
  },
);

const ALL_SITES = { origins: ["<all_urls>"] };
/** Chrome grants declared site access at install; Firefox leaves it to the user. */
async function siteAccess() {
  try {
    return await chrome.permissions.contains(ALL_SITES);
  } catch {
    // An engine without the permissions API grants what the manifest declares.
    return true;
  }
}

/** What the toolbar popup shows: the connection to Pi Bot and the Bots working here. */
async function popupState(retry: boolean) {
  if (retry) {
    clearTimeout(reconnectTimer);
    reconnectDelay = 2_000;
  }
  if (!nativePort) {
    try {
      emit({ event: "hello", payload: { version: __PIBOT_VERSION__, browser: __PIBOT_BROWSER__ } });
    } catch {
      // A missing host is reported through onDisconnect, read below.
    }
    // A host that is not registered disconnects right away; give it a moment to say so.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return {
    type: "working",
    connected: nativePort !== undefined,
    siteAccess: await siteAccess(),
    problem: nativePort ? undefined : (nativeProblem ?? "disconnected"),
    bots: [...workingBots].map((id) => ({ id, name: botNames.get(id) ?? null })),
  };
}
