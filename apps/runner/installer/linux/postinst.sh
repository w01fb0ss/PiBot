#!/bin/sh
# deb 与 rpm 的 %post 共用；只用 POSIX sh。安装时不替任何人启用用户单元，只打印该怎么用。

cat <<'MESSAGE'
Pi Bot Runner 已安装到 /opt/pibot-runner （/usr/bin/pibot）。
Pi Bot Runner installed to /opt/pibot-runner (/usr/bin/pibot).

启用执行端（systemd 用户单元，没有替你启用）/ enable the per-user service:
  systemctl --user daemon-reload
  systemctl --user enable --now pibot-runner.service
状态 / status:
  systemctl --user status pibot-runner.service
  pibot runner status
配对（先停单元，配对完再起）/ pair (stop the unit first, then start it again):
  systemctl --user stop pibot-runner.service
  pibot runner pair
  systemctl --user start pibot-runner.service

没有 Secret Service 的机器（无桌面会话 / 无 keyring）需要口令。写进
~/.config/pibot-runner/env （权限 0600），单元通过 EnvironmentFile 读它：
  mkdir -p ~/.config/pibot-runner && chmod 700 ~/.config/pibot-runner
  echo 'PIBOT_RUNNER_PASSPHRASE=<口令>' > ~/.config/pibot-runner/env
  chmod 600 ~/.config/pibot-runner/env
不要写进单元文件的 Environment=：那是明文，本机任何用户都能读到。

Headless machines without a Secret Service need the passphrase in
~/.config/pibot-runner/env (mode 0600), never in the unit file's Environment=.
MESSAGE

# Only the live probe as the service user can tell whether the installed policy permits isolation.
restrict=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
if [ -r "$restrict" ] && [ "$(cat "$restrict")" = "1" ]; then
  cat <<'MESSAGE'

本机启用了 AppArmor 的非特权用户命名空间限制。启动执行端后，
运行 pibot runner status 查看实际隔离探测的结果和失败时的处理方法。

AppArmor restricts unprivileged user namespaces on this host. After starting the
runner, run pibot runner status for the live isolation result and any remedy.
MESSAGE
fi

exit 0
