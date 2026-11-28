ObjC.import("Cocoa");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const zh = ObjC.unwrap($.NSLocale.preferredLanguages.firstObject).startsWith("zh");
const l = (a, b) => (zh ? a : b);
const input = $.NSFileHandle.fileHandleWithStandardInput;
const output = $.NSFileHandle.fileHandleWithStandardOutput;
const events = [];
let partial = "",
  paired = false,
  connecting = false,
  window,
  field,
  status,
  timer,
  lastIcon,
  lastTasks = -1;
function emit(action) {
  output.writeData($(action + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}
function setting(name) {
  $.NSWorkspace.sharedWorkspace.openURL(
    $.NSURL.URLWithString(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_" + name,
    ),
  );
}
function item(title, selector, target) {
  const value = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, selector || null, "");
  if (target) value.target = target;
  return value;
}
ObjC.registerSubclass({
  name: "PiRunnerTrayActions",
  superclass: "NSObject",
  methods: {
    pair: {
      types: ["void", []],
      implementation: () => {
        if (connecting) return;
        if (paired) {
          const alert = $.NSAlert.alloc.init;
          alert.messageText = l("更换已配对的电脑？", "Replace the paired computer?");
          alert.addButtonWithTitle(l("更换", "Replace"));
          alert.addButtonWithTitle(l("取消", "Cancel"));
          if (alert.runModal !== $.NSAlertFirstButtonReturn) return;
        }
        const prompt = $.NSAlert.alloc.init;
        prompt.messageText = l(
          "在主电脑的「设置 › 设备 › 添加设备 › 另一台电脑 / 服务器」复制配对码，再粘贴到这里。",
          "On your main computer, go to Settings › Devices › Add device › Another computer / server. Copy the pairing code and paste it here.",
        );
        const input = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 420, 26));
        prompt.accessoryView = input;
        prompt.addButtonWithTitle(l("配对", "Pair"));
        prompt.addButtonWithTitle(l("取消", "Cancel"));
        prompt.addButtonWithTitle(l("显示本机配对码", "Show code from this computer"));
        const result = prompt.runModal;
        if (result === $.NSAlertFirstButtonReturn)
          emit("pair-code:" + ObjC.unwrap(input.stringValue));
        else if (result === $.NSAlertThirdButtonReturn) emit("pair");
      },
    },
    unpair: {
      types: ["void", []],
      implementation: () => {
        const alert = $.NSAlert.alloc.init;
        if (!paired || connecting) return;
        alert.messageText = l("解除配对？", "Unpair this computer?");
        alert.informativeText = l(
          "这台执行端会停止接收已配对设备的任务。要再次使用，请重新配对。",
          "Pi Bot Runner will stop accepting work from paired devices. Pair again to use it.",
        );
        alert.addButtonWithTitle(l("解除配对", "Unpair"));
        alert.addButtonWithTitle(l("取消", "Cancel"));
        if (alert.runModal === $.NSAlertFirstButtonReturn) emit("unpair");
      },
    },
    login: {
      types: ["void", []],
      implementation: () => {
        emit("login");
      },
    },
    logs: {
      types: ["void", []],
      implementation: () => {
        emit("logs");
      },
    },
    quit: {
      types: ["void", []],
      implementation: () => {
        emit("quit");
      },
    },
    // Not "copy": NSObject already has -copy returning id, and redefining it as void makes
    // registerSubclass throw ("method types do not match"), so the menu bar icon never appeared.
    copyCode: {
      types: ["void", []],
      implementation: () => {
        $.NSPasteboard.generalPasteboard.clearContents;
        $.NSPasteboard.generalPasteboard.setStringForType(
          field.stringValue,
          $.NSPasteboardTypeString,
        );
      },
    },
    accessibility: {
      types: ["void", []],
      implementation: () => {
        setting("Accessibility");
      },
    },
    screen: {
      types: ["void", []],
      implementation: () => {
        setting("ScreenCapture");
      },
    },
    automation: {
      types: ["void", []],
      implementation: () => {
        setting("Automation");
      },
    },
    tick: {
      types: ["void", []],
      implementation: () => {
        while (events.length) apply(events.shift());
      },
    },
  },
});
const actions = $.PiRunnerTrayActions.alloc.init;
status = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
const menu = $.NSMenu.alloc.init;
const state = item("Pi Bot Runner");
state.enabled = false;
menu.addItem(state);
const pairItem = item(l("配对…", "Pair…"), "pair", actions);
const unpairItem = item(l("解除配对…", "Unpair…"), "unpair", actions);
unpairItem.hidden = true;
menu.addItem(pairItem);
menu.addItem(unpairItem);
menu.addItem(item(l("打开日志", "Open logs"), "logs", actions));
const permissions = item(l("权限", "Permissions"));
const permissionsMenu = $.NSMenu.alloc.init;
const accessItem = item(l("辅助功能", "Accessibility"), "accessibility", actions);
const screenItem = item(l("屏幕录制", "Screen recording"), "screen", actions);
permissionsMenu.addItem(accessItem);
permissionsMenu.addItem(screenItem);
const automationItem = item(
  l("自动化：按目标应用授权", "Automation: permission per target app"),
  "automation",
  actions,
);
permissionsMenu.addItem(automationItem);
permissions.submenu = permissionsMenu;
menu.addItem(permissions);
const loginItem = item(l("登录时启动", "Start at login"), "login", actions);
menu.addItem(loginItem);
menu.addItem(item(l("退出", "Quit"), "quit", actions));
status.menu = menu;
function apply(value) {
  if (value.statusUnavailable) {
    state.title = l("状态暂不可用", "Status temporarily unavailable");
    status.button.toolTip = state.title;
  }
  if (value.permissions) {
    const labels = {
      granted: l("已授权", "Allowed"),
      denied: l("未授权", "Not allowed"),
      unknown: l("状态未知", "Unknown"),
      ask_per_app: l("按目标应用授权", "Per target app"),
    };
    accessItem.title =
      l("辅助功能：", "Accessibility: ") +
      (labels[value.permissions.accessibility] || labels.unknown);
    screenItem.title =
      l("屏幕录制：", "Screen recording: ") +
      (labels[value.permissions.screenRecording] || labels.unknown);
    automationItem.title =
      l("自动化：", "Automation: ") + (labels[value.permissions.automation] || labels.unknown);
  }
  if (typeof value.loginEnabled === "boolean")
    loginItem.state = value.loginEnabled ? $.NSControlStateValueOn : $.NSControlStateValueOff;
  if (value.close) {
    app.terminate(null);
    return;
  }
  if (value.error) {
    const alert = $.NSAlert.alloc.init;
    alert.messageText = l(value.error.zh, value.error.en);
    alert.runModal;
  }
  if (typeof value.connecting === "boolean") {
    connecting = value.connecting;
    if (connecting) {
      state.title = l("正在连接…", "Connecting…");
      status.button.toolTip = state.title;
    }
  }
  if (value.status) {
    const s = value.status;
    paired = s.paired;
    unpairItem.hidden = !paired;
    const tasks = (s.runningCommands || 0) + (s.backgroundTasks || 0);
    const paths = {
      lan: l("同一网络直连", "Direct on the same network"),
      address: l("直连", "Direct"),
      punched: l("跨网络直连", "Direct across networks"),
      relay: l("经中继转发", "Via relay"),
    };
    const label = connecting
      ? l("正在连接…", "Connecting…")
      : !paired
        ? l("未配对", "Unpaired")
        : [
            s.name,
            s.connection === "online"
              ? l("在线", "Online")
              : s.connection === "connecting" || s.connection === "reconnecting"
                ? l("正在连接…", "Connecting…")
                : l("离线", "Offline"),
            s.connection === "online" ? paths[s.path] : "",
            l("任务：", "Tasks: ") + tasks,
          ]
            .filter(Boolean)
            .join(" · ");
    state.title = label;
    status.button.toolTip = label;
    if (value.icon && (lastIcon !== value.icon || lastTasks !== tasks)) {
      const image = $.NSImage.alloc.initWithContentsOfFile(value.icon);
      image.setSize($.NSMakeSize(18, 18));
      if (tasks > 0) {
        image.lockFocus;
        $.NSColor.blackColor.setFill;
        $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(13, 0, 5, 5)).fill;
        image.unlockFocus;
      }
      image.setTemplate(true);
      status.button.image = image;
      lastIcon = value.icon;
      lastTasks = tasks;
    }
  }
  if (Object.hasOwn(value, "pairing")) {
    if (!value.pairing) {
      if (window) window.orderOut(null);
      window = null;
      return;
    }
    if (!window) {
      window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
        $.NSMakeRect(0, 0, 480, 130),
        $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable,
        $.NSBackingStoreBuffered,
        false,
      );
      window.releasedWhenClosed = false;
      window.title = l("配对执行端", "Pair runner");
      window.center;
      field = $.NSTextField.alloc.initWithFrame($.NSMakeRect(20, 75, 440, 28));
      field.editable = false;
      field.selectable = true;
      window.contentView.addSubview(field);
      const copy = $.NSButton.alloc.initWithFrame($.NSMakeRect(20, 25, 100, 32));
      copy.title = l("复制", "Copy");
      copy.target = actions;
      copy.action = "copyCode";
      window.contentView.addSubview(copy);
    }
    field.stringValue = value.pairing;
    window.makeKeyAndOrderFront(null);
    app.activateIgnoringOtherApps(true);
  }
}
input.setReadabilityHandler((handle) => {
  const data = handle.availableData;
  if (data.length === 0) {
    events.push({ close: true });
    return;
  }
  partial += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
  if (partial.length > 32768) {
    events.push({ close: true });
    return;
  }
  let end = partial.indexOf("\n");
  while (end >= 0) {
    const line = partial.slice(0, end);
    partial = partial.slice(end + 1);
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      /* Only framed parent messages enter UI state. */
    }
    end = partial.indexOf("\n");
  }
});
timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(
  0.1,
  actions,
  "tick",
  null,
  true,
);
app.run;
timer.invalidate;
input.setReadabilityHandler(null);
$.NSStatusBar.systemStatusBar.removeStatusItem(status);
