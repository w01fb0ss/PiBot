export const networkZh = {
  "audit.permissions.updated": "已修改全局权限设置",
  "network.title": "网络代理",
  "network.enabled": "使用代理",
  "network.note": "只用这里填的代理，不会自动使用系统代理；代理能看到 Bot 访问的域名。",
  "network.systemSuggested": "已填入这台电脑正在使用的代理，打开「使用代理」后才生效。",
  "network.address": "HTTP(S) 代理",
  "network.placeholder": "http://127.0.0.1:7890",
  "network.savedAccount": "已保存账号",
  "network.clearAccount": "移除已保存账号",
  "network.saved": "代理设置已保存",
  "network.test": "测试连接",
  "network.socks": "暂不支持 SOCKS，请填 HTTP 代理地址",
  "network.invalid": "请填写有效的 HTTP(S) 代理地址，不含路径、查询或片段",
  "network.connected": "连接成功",
  "network.proxy_auth_failed": "代理账号或密码未通过验证，请更新已保存账号",
  "errors.proxy_auth_failed": "代理（{address}）拒绝了账号或密码，请在网络代理设置中更新账号",
  "network.disabled": "请先开启代理",
  "network.proxy_unavailable": "连不上你设置的代理（{address}），请检查代理软件是否在运行",
  "network.destination_unavailable": "代理已配置，但无法连接测试网站，请检查代理的网络出口",
  "network.timeout": "测试连接超时",
  "network.credentials_unavailable": "代理账号暂时无法解密，请解锁系统密钥库或移除代理账号",
  "errors.proxy_credentials_unavailable": "代理账号暂时无法解密，请解锁系统密钥库或移除代理账号",
  "network.unknown": "已保存的地址",
  "errors.proxy_unavailable": "连不上你设置的代理（{address}），请检查代理软件是否在运行",
  "errors.proxy_unavailable_no_address": "连不上你设置的代理，请检查代理软件是否在运行。",
  "errors.proxy_auth_failed_no_address": "代理拒绝了账号或密码，请在网络代理设置中更新账号。",
  // Reachable only for Bedrock / Vertex when the route through the proxy cannot be guaranteed.
  "errors.proxy_unsupported":
    "这次连接无法保证经过你设置的代理，为免绕过代理已停止发送（只会出现在 Amazon Bedrock 或 Google Vertex AI）。请为这个 Bot 换用其他厂商的模型，或在「设置 → 通用 → 网络代理」中关闭代理。",
  "audit.describe.proxy": "网络代理设置已更改",
  "audit.proxy.enabled": "已开启网络代理",
  "audit.proxy.disabled": "已关闭网络代理",
  "audit.proxy.updated": "已修改网络代理",
} as const;
export const networkEn = {
  "audit.permissions.updated": "Global permissions updated",
  "network.title": "Network proxy",
  "network.enabled": "Use proxy",
  "network.note":
    "Only this proxy is used; the system proxy is never used on its own. The proxy can see which domains Bots visit.",
  "network.systemSuggested":
    "Filled in with the proxy this computer uses. It takes effect only after you turn on Use proxy.",
  "network.address": "HTTP(S) proxy",
  "network.placeholder": "http://127.0.0.1:7890",
  "network.savedAccount": "Account saved",
  "network.clearAccount": "Remove saved account",
  "network.saved": "Proxy settings saved",
  "network.test": "Test connection",
  "network.socks": "SOCKS is not supported yet; enter an HTTP proxy address",
  "network.invalid": "Enter a valid HTTP(S) proxy address without a path, query or fragment",
  "network.connected": "Connection successful",
  "network.proxy_auth_failed":
    "The proxy rejected your account or password. Update the saved account.",
  "errors.proxy_auth_failed":
    "The proxy ({address}) rejected your account or password. Update the account in Network proxy settings.",
  "network.disabled": "Turn the proxy on first",
  "network.proxy_unavailable":
    "Cannot connect to your proxy ({address}); check that your proxy software is running.",
  "network.destination_unavailable":
    "The proxy is configured, but the test site is unreachable. Check the proxy's outbound network.",
  "network.timeout": "Connection test timed out",
  "network.credentials_unavailable":
    "Proxy credentials could not be decrypted. Unlock the system key store or remove the saved account.",
  "errors.proxy_credentials_unavailable":
    "Proxy credentials could not be decrypted. Unlock the system key store or remove the saved account.",
  "network.unknown": "the saved address",
  "errors.proxy_unavailable":
    "Cannot connect to your proxy ({address}); check that your proxy software is running.",
  "errors.proxy_unavailable_no_address":
    "Cannot connect to your proxy. Check that your proxy software is running.",
  "errors.proxy_auth_failed_no_address":
    "The proxy rejected your account or password. Update the account in Network proxy settings.",
  "errors.proxy_unsupported":
    "This connection could not be guaranteed to use your proxy, so nothing was sent (only Amazon Bedrock or Google Vertex AI can hit this). Switch this Bot to another provider's model, or turn the proxy off in Settings → General → Network proxy.",
  "audit.describe.proxy": "Network proxy settings changed",
  "audit.proxy.enabled": "Network proxy enabled",
  "audit.proxy.disabled": "Network proxy disabled",
  "audit.proxy.updated": "Network proxy updated",
} as const;
