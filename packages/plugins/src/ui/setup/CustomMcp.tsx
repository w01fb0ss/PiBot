import {
  CONNECTOR_IMPORT_MAX_BYTES,
  CONNECTOR_STARTUP_MAX_SECONDS,
  ConnectorAllowedSiteSchema,
  ConnectorEnvNameSchema,
  ConnectorNetworkSiteSchema,
  connectorEndpointSite,
} from "@pibot/plugins-contract/full";
import { SettingsFold, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, SegmentedControl } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../page/connectors.module.css";

type Row = { id: string; key: string; value: string };
const makeRow = (key = "", value = "") => ({ id: crypto.randomUUID(), key, value });

/** Parse argv literals. Preserve Windows path separators and never interpret shell syntax. */
function commandWords(input: string) {
  if (/[\r\n\0]/.test(input)) return undefined;
  const words: string[] = [];
  let quote = "";
  let word = "";
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (char === "\\" && quote !== "'" && /["'\s]/.test(next)) {
      word += next;
      index++;
    } else if (char === quote) {
      quote = "";
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && /\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    } else if (
      (!quote && /[;&|<>()]/.test(char)) ||
      char === "`" ||
      (char === "$" && next === "(")
    ) {
      return undefined;
    } else word += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words[0] ? words : undefined;
}

function executableName(command: string) {
  return (
    command
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/\.(?:exe|cmd|bat)$/i, "") ?? command
  );
}

function parseCommand(input: string) {
  const words = commandWords(input);
  if (!words?.[0]) return;
  const [command, ...args] = words;
  const executable = executableName(command);
  if (/^(?:claude|codex)$/i.test(executable) && args[0] === "mcp") {
    // A setup command is documentation for launching a server, never a server itself.
    const [verb, name, separator, server, ...serverArgs] = args.slice(1);
    if (verb !== "add" || !name || name.startsWith("-") || separator !== "--" || !server) return;
    return { name, command: server, args: serverArgs };
  }
  const launcher = executable.toLowerCase();
  let packageName: string | undefined;
  if (["npx", "bunx", "uvx"].includes(launcher))
    packageName = args.find((arg) => !arg.startsWith("-"));
  if ((launcher === "pnpm" && args[0] === "dlx") || (launcher === "npm" && args[0] === "exec"))
    packageName = args.slice(1).find((arg) => !arg.startsWith("-"));
  if (launcher === "uv" && args[0] === "tool" && args[1] === "run")
    packageName = args.slice(2).find((arg) => !arg.startsWith("-"));
  return {
    command,
    args,
    name:
      packageName
        ?.replace(/@[^@/]+$/, "")
        .split("/")
        .at(-1) || executable,
  };
}

const pasteTarget = (input: string) =>
  input
    .trim()
    .replace(/^\s*```(?:json|bash|sh|shell|powershell)?\s*\n([\s\S]*?)\n```\s*$/i, "$1")
    .trim();

function remoteUrl(input: string) {
  if (!/^https?:/i.test(input) || !URL.canParse(input)) return;
  const url = new URL(input);
  if (url.username || url.password) return;
  return url;
}

function ValueRows({
  rows,
  change,
  environment = false,
}: {
  rows: Row[];
  change(rows: Row[]): void;
  environment?: boolean;
}) {
  const { t } = useSettings();
  function update(id: string, field: "key" | "value", value: string) {
    change(rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }
  return (
    <div className={styles.stack}>
      {rows.map((row, index) => (
        <div key={row.id} className={styles.field}>
          {environment && (
            <input
              aria-label={t("connectors.paste.variable")}
              value={row.key}
              maxLength={64}
              onChange={(event) => update(row.id, "key", event.currentTarget.value)}
            />
          )}
          <input
            aria-label={
              environment
                ? t("connectors.paste.value")
                : t("connectors.paste.argument", { index: String(index + 1) })
            }
            type={environment ? "password" : "text"}
            autoComplete="off"
            value={row.value}
            maxLength={4096}
            onChange={(event) => update(row.id, "value", event.currentTarget.value)}
          />
          <Button variant="ghost" onClick={() => change(rows.filter(({ id }) => id !== row.id))}>
            {t("connectors.remove")}
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        disabled={rows.length >= 64}
        onClick={() => change([...rows, makeRow()])}
      >
        {t(environment ? "connectors.paste.addVariable" : "connectors.paste.addArgument")}
      </Button>
    </div>
  );
}

type InputError = "command" | "url" | "variables" | "timeout" | "sites" | "key" | "folder";

export function CustomMcp({
  busy,
  edited,
  preview,
}: {
  busy: boolean;
  edited(): void;
  preview(json: string): void;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [manualMode, setManualMode] = useState<"stdio" | "http">("stdio");
  const [manualTarget, setManualTarget] = useState("");
  const [auth, setAuth] = useState<"none" | "bearer" | "oauth">("none");
  const key = useRef("");
  const [savedKeyName, setSavedKeyName] = useState("");
  const [savedKeys, setSavedKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!peer || auth !== "bearer") return;
    const owner = new AbortController();
    void peer
      .call("secrets.list", { limit: 50 }, { signal: owner.signal })
      .then((page) => {
        if (!owner.signal.aborted)
          setSavedKeys(page.items.filter(({ hasValue }) => hasValue).map(({ name }) => name));
      })
      .catch(() => {
        // The inline key still works if the saved-name list is unavailable.
        if (!owner.signal.aborted) setSavedKeys([]);
      });
    return () => owner.abort();
  }, [auth, peer]);
  const [args, setArgs] = useState<Row[]>();
  const [env, setEnv] = useState<Row[]>([]);
  const [sites, setSites] = useState("");
  const [cwd, setCwd] = useState("");
  const [timeout, setTimeoutSec] = useState("");
  const [error, setError] = useState<InputError>();
  const [picking, setPicking] = useState(false);
  const picker = useRef<AbortController>(null);
  useEffect(() => () => picker.current?.abort(), []);
  const pasted = pasteTarget(input);
  const json = /^[{[]/.test(pasted) && !manualTarget.trim();
  const target = manualTarget.trim() || pasted;
  const online = manualTarget.trim() || !target ? manualMode === "http" : /^https?:/i.test(target);
  const parsed = !json && !online ? parseCommand(target) : undefined;
  const argumentsToUse =
    args ?? (parsed?.args ?? []).map((value, index) => ({ id: String(index), key: "", value }));
  const endpoint = online ? remoteUrl(target)?.href : undefined;

  function resetLocalSettings() {
    picker.current?.abort();
    picker.current = null;
    setPicking(false);
    setArgs(undefined);
    setEnv([]);
    setSites("");
    setCwd("");
  }

  function resetCredential(nextEndpoint: string | undefined) {
    if (endpoint === nextEndpoint) return;
    setAuth("none");
    setSavedKeyName("");
    key.current = "";
  }

  async function pickFolder() {
    if (!peer || picking) return;
    const owner = new AbortController();
    picker.current = owner;
    setPicking(true);
    setError(undefined);
    try {
      const result = await peer.call(
        "connectors.pickWorkingDirectory",
        {},
        { signal: owner.signal },
      );
      if (result && !owner.signal.aborted) setCwd(result.path);
    } catch {
      if (!owner.signal.aborted) setError("folder");
    } finally {
      if (!owner.signal.aborted) setPicking(false);
    }
  }

  function submit() {
    setError(undefined);
    if (json) return preview(target);
    const seconds = timeout.trim() ? Number(timeout) : undefined;
    if (
      seconds !== undefined &&
      (!Number.isInteger(seconds) || seconds < 1 || seconds > CONNECTOR_STARTUP_MAX_SECONDS)
    ) {
      setError("timeout");
      return;
    }
    const common = {
      id: "custom",
      ...(seconds === undefined ? {} : { startupTimeoutSec: seconds }),
    };
    let server: object;
    let summary: string;
    if (online) {
      const url = remoteUrl(target);
      if (!url) {
        setError("url");
        return;
      }
      const value = key.current.trim();
      const reference = savedKeyName.trim().toUpperCase();
      const bearer =
        value || (/^[A-Z][A-Z0-9_]{0,63}$/.test(reference) ? `\${secret:${reference}}` : "");
      if (auth === "bearer" && (!bearer || /[\s\0]/.test(bearer))) {
        setError("key");
        return;
      }
      server = {
        ...common,
        transport: "http",
        url: url.href,
        auth: { kind: auth, secretNames: [] },
        headers: bearer && auth === "bearer" ? { Authorization: `Bearer ${bearer}` } : {},
        networkDomains: ConnectorNetworkSiteSchema.safeParse(connectorEndpointSite(url)).success
          ? [connectorEndpointSite(url)]
          : [],
      };
      summary = url.host;
    } else {
      if (!parsed) {
        setError("command");
        return;
      }
      const { command } = parsed;
      const entries = env.filter((row) => row.key || row.value);
      if (
        entries.some(({ key }) => !ConnectorEnvNameSchema.safeParse(key).success) ||
        new Set(entries.map(({ key }) => key)).size !== entries.length
      ) {
        setError("variables");
        return;
      }
      const domains = sites.split(/[\s,]+/).filter(Boolean);
      if (
        domains.length > 64 ||
        domains.some((site) => !ConnectorAllowedSiteSchema.safeParse(site).success)
      ) {
        setError("sites");
        return;
      }
      server = {
        ...common,
        transport: "stdio",
        command,
        args: argumentsToUse.map(({ value }) => value),
        env: Object.fromEntries(entries.map(({ key, value }) => [key, value])),
        auth: { kind: "none", secretNames: [] },
        networkDomains: domains,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      };
      summary = parsed.name;
    }
    preview(
      JSON.stringify({
        schemaVersion: 1,
        id: `custom.${crypto.randomUUID()}`,
        version: "1",
        name: { zh: name.trim() || summary, en: name.trim() || summary },
        description: { zh: summary, en: summary },
        servers: [server],
      }),
    );
  }

  return (
    <div className={styles.formCard} onChange={edited}>
      <label className={styles.field}>
        {t("connectors.paste.label")}
        <textarea
          value={input}
          maxLength={CONNECTOR_IMPORT_MAX_BYTES}
          autoComplete="off"
          spellCheck={false}
          rows={4}
          placeholder={t("connectors.paste.placeholder")}
          onChange={(event) => {
            const value = event.currentTarget.value;
            resetCredential(remoteUrl(pasteTarget(value))?.href);
            setManualTarget("");
            setInput(value);
            resetLocalSettings();
            setError(undefined);
          }}
        />
      </label>
      <SettingsFold title={t("connectors.paste.manual")} icon="settings" tone="blue">
        <SegmentedControl
          label={t("connectors.paste.mode")}
          value={target && !json ? (online ? "http" : "stdio") : manualMode}
          options={(["stdio", "http"] as const).map((mode) => ({
            value: mode,
            label: t(`connectors.transport.${mode}`),
          }))}
          onValueChange={(mode) => {
            if (mode !== (online ? "http" : "stdio")) {
              resetCredential(undefined);
              resetLocalSettings();
              setInput("");
              setManualTarget("");
            }
            setManualMode(mode);
          }}
        />
        <label className={styles.field}>
          {t(
            (target && !json ? online : manualMode === "http")
              ? "connectors.paste.manualUrl"
              : "connectors.paste.manualCommand",
          )}
          <input
            value={manualTarget}
            placeholder={!json ? pasted : undefined}
            maxLength={4096}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const mode = target && !json ? (online ? "http" : "stdio") : manualMode;
              resetCredential(mode === "http" ? remoteUrl(value.trim())?.href : undefined);
              setManualMode(mode);
              setManualTarget(value);
              resetLocalSettings();
              setError(undefined);
            }}
          />
        </label>
        {!json && (
          <>
            <label className={styles.field}>
              {t("connectors.customName")}
              <input
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            {online && (
              <>
                <SegmentedControl
                  label={t("connectors.customAuth")}
                  value={auth}
                  options={(["none", "bearer", "oauth"] as const).map((kind) => ({
                    value: kind,
                    label: t(`connectors.auth.${kind}`),
                  }))}
                  onValueChange={(kind) => {
                    if (kind !== "bearer") {
                      setSavedKeyName("");
                      key.current = "";
                    }
                    setAuth(kind);
                  }}
                />
                {auth === "bearer" && (
                  <label className={styles.field}>
                    {t("connectors.paste.key")}
                    <input
                      type="password"
                      autoComplete="new-password"
                      maxLength={4088}
                      defaultValue={key.current}
                      onChange={(event) => {
                        key.current = event.currentTarget.value;
                      }}
                    />
                    <span className={styles.note}>{t("connectors.paste.keyNote")}</span>
                  </label>
                )}
              </>
            )}
            {online && auth === "bearer" && (
              <label className={styles.field}>
                {t("connectors.paste.savedKey")}
                <input
                  list="pibot-mcp-saved-keys"
                  value={savedKeyName}
                  maxLength={64}
                  onChange={(event) => setSavedKeyName(event.currentTarget.value)}
                />
                <datalist id="pibot-mcp-saved-keys">
                  {savedKeys.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
            )}
            {!online && (
              <>
                <ValueRows rows={argumentsToUse} change={setArgs} />
                <ValueRows rows={env} change={setEnv} environment />
                <label className={styles.field}>
                  {t("connectors.paste.cwd")}
                  <input
                    value={cwd}
                    maxLength={4096}
                    onChange={(event) => setCwd(event.currentTarget.value)}
                  />
                </label>
                <Button
                  variant="secondary"
                  disabled={!peer || busy || picking}
                  onClick={() => void pickFolder()}
                >
                  {t("connectors.paste.pickFolder")}
                </Button>
                <label className={styles.field}>
                  {t("connectors.network")}
                  <textarea
                    value={sites}
                    rows={2}
                    maxLength={16384}
                    onChange={(event) => setSites(event.currentTarget.value)}
                  />
                </label>
              </>
            )}
            <label className={styles.field}>
              {t("connectors.paste.timeout")}
              <input
                type="number"
                min={1}
                max={CONNECTOR_STARTUP_MAX_SECONDS}
                value={timeout}
                onChange={(event) => setTimeoutSec(event.currentTarget.value)}
              />
            </label>
          </>
        )}
      </SettingsFold>
      {error && (
        <p role="alert" className={styles.error}>
          {t(`connectors.paste.error.${error}`)}
        </p>
      )}
      <Button disabled={busy || !target || picking} onClick={submit}>
        {t("connectors.preview")}
      </Button>
    </div>
  );
}
