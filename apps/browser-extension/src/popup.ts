// Explains the desktop connection and website access from the extension toolbar.
interface PopupState {
  connected: boolean;
  siteAccess?: boolean;
  problem?: "host_missing" | "disconnected";
  bots: { id: string; name: string | null }[];
}

const zh = navigator.language.toLowerCase().startsWith("zh");
const t = zh
  ? {
      checking: "检查中",
      connected: "已连接",
      missing: "未找到 Pi Bot",
      closed: "未连接",
      idle: "现在没有 Bot 在这个浏览器里工作。",
      missingTitle: "没有找到 Pi Bot",
      missingBody:
        "请把 Pi Bot 更新到 0.1.0 或更新版本并打开，在「设置 › 浏览器」选「优先用你的浏览器」，然后重试连接。",
      closedTitle: "还没连上 Pi Bot",
      closedBody: "请确认 Pi Bot 已打开，然后重试连接。",
      bot: "Bot",
      stop: "停止",
      stopping: "已停止",
      accessTitle: "需要允许访问网站",
      accessBody:
        "Firefox 默认不让扩展读取网页。允许后，Bot 才能在这个浏览器里读页面、点击和填写。",
      allow: "允许",
      retry: "重试连接",
    }
  : {
      checking: "Checking",
      connected: "Connected",
      missing: "Pi Bot not found",
      closed: "Disconnected",
      idle: "No Bot is working in this browser right now.",
      missingTitle: "Pi Bot was not found",
      missingBody:
        "Open Pi Bot 0.1.0 or later, choose “Prefer your browser” in Settings › Browser, then retry.",
      closedTitle: "Pi Bot is not connected",
      closedBody: "Make sure Pi Bot is open, then retry the connection.",
      bot: "Bot",
      stop: "Stop",
      stopping: "Stopped",
      accessTitle: "Allow access to websites",
      accessBody:
        "Firefox keeps extensions from reading pages until you allow it. Bots need it to read, click and type in this browser.",
      allow: "Allow",
      retry: "Retry connection",
    };

// The app's tokens switch on data-theme; the popup follows the system setting.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => {
  document.documentElement.dataset.theme = dark.matches ? "dark" : "light";
};
applyTheme();
dark.addEventListener("change", applyTheme);
document.documentElement.lang = zh ? "zh" : "en";

const statusNode = document.querySelector<HTMLElement>("[data-status]");
const statusText = document.querySelector<HTMLElement>("[data-status-text]");
const content = document.querySelector<HTMLElement>("[data-content]");

function note(title: string, body: string) {
  const box = document.createElement("p");
  box.className = "note";
  const strong = document.createElement("b");
  strong.textContent = title;
  box.append(strong, body);
  return box;
}

function render(state: PopupState) {
  if (!statusNode || !statusText || !content) return;
  const key = state.connected
    ? "connected"
    : state.problem === "host_missing"
      ? "missing"
      : "closed";
  statusNode.dataset.status = key;
  statusText.textContent = t[key];
  content.replaceChildren();
  if (!state.connected) {
    const box =
      key === "missing" ? note(t.missingTitle, t.missingBody) : note(t.closedTitle, t.closedBody);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "allow";
    retry.textContent = t.retry;
    retry.onclick = () => {
      retry.disabled = true;
      refresh(true);
    };
    box.append(retry);
    content.append(box);
    return;
  }
  if (state.siteAccess === false) {
    const box = note(t.accessTitle, t.accessBody);
    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "allow";
    allow.textContent = t.allow;
    // permissions.request must run inside the click itself.
    allow.onclick = () => {
      void chrome.permissions.request({ origins: ["<all_urls>"] }).then((granted) => {
        if (granted) render({ ...state, siteAccess: true });
      });
    };
    box.append(allow);
    content.append(box);
  }
  if (!state.bots.length) {
    const idle = document.createElement("p");
    idle.className = "note";
    idle.textContent = t.idle;
    content.append(idle);
    return;
  }
  const list = document.createElement("ul");
  for (const bot of state.bots) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = bot.name ?? t.bot;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = t.stop;
    button.onclick = () => {
      button.disabled = true;
      button.textContent = t.stopping;
      void chrome.runtime.sendMessage({
        id: crypto.randomUUID(),
        method: "stop",
        params: { botId: bot.id },
      });
    };
    item.append(name, button);
    list.append(item);
  }
  content.append(list);
}

function refresh(retry = false) {
  if (statusText) statusText.textContent = t.checking;
  void chrome.runtime
    .sendMessage({ type: retry ? "retry_connection" : "working" })
    .then((raw: unknown) => render(raw as PopupState))
    .catch(() => render({ connected: false, problem: "disconnected", bots: [] }));
}
refresh();
