import type { SearchConfig } from "@pibot/protocol";
import {
  layoutStyles,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useRpcEvent,
  useT,
  useTask,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import { requirePeer, writeCredential } from "./operations.ts";
import css from "./search-settings.module.css";

type SearchProvider = SearchConfig["provider"];
const PROVIDERS = [
  "keyless",
  "duckduckgo",
  "bing",
  "brave",
  "tavily",
  "keenable",
  "searxng",
] as const;
const keyFree = (provider: SearchProvider): provider is "keyless" | "duckduckgo" | "bing" =>
  provider === "keyless" || provider === "duckduckgo" || provider === "bing";

/**
 * Choosing a service saves it. Services that need a key or an address save when that field
 * loses focus (or on Enter); there is no separate save button.
 *
 * Maintainers 2026-11-13: no separate 「确认接收方并启用」 step either. Each option card says what is sent
 * (the search terms) and to whom, so choosing it is the consent: a service that needs a key or an
 * address is disclosed in the same step that saves it, like the remote STUN setting.
 */
export function SearchSettings() {
  const { peer } = useRpc();
  const t = useT();
  const task = useTask();
  const name = useId();
  const [config, setConfig] = useState<SearchConfig | null>(null);
  const [provider, setProvider] = useState<SearchProvider>("keyless");
  const scope = useRef({ peer, active: true });
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  useEffect(() => {
    let active = true;
    const current = { peer, active: true };
    scope.current = current;
    void peer
      ?.call("search.getConfig", undefined)
      .then((cfg) => {
        if (!active) return;
        setConfig(cfg);
        if (cfg) {
          setProvider(cfg.provider);
          if (cfg.provider === "searxng") setBaseUrl(cfg.baseUrl);
        }
      })
      .catch(() => {
        /* Display the editable form while disconnected. */
      });
    return () => {
      active = false;
      current.active = false;
    };
  }, [peer]);
  useRpcEvent("providers.changed", () => {
    void peer
      ?.call("search.getConfig", undefined)
      .then((value) => {
        if (scope.current.active && scope.current.peer === peer) setConfig(value);
      })
      .catch(() => {
        /* A reconnect reloads authoritative config. */
      });
  });
  const disabled = task.busy || task.blocked || !peer;
  const save = (next: SearchProvider, values: { apiKey?: string; baseUrl?: string } = {}) =>
    void task.run(async () => {
      const current = scope.current;
      try {
        const cfg = await writeCredential(() =>
          requirePeer(peer).call(
            "search.setConfig",
            next === "duckduckgo" || next === "bing" || next === "keyless"
              ? { provider: next }
              : next === "searxng"
                ? { provider: next, baseUrl: values.baseUrl ?? "" }
                : { provider: next, ...(values.apiKey ? { apiKey: values.apiKey } : {}) },
          ),
        );
        const final = await consent(cfg);
        if (current.active && current === scope.current) setConfig(final);
      } finally {
        if (current.active && current === scope.current) setKey("");
      }
    });
  /** The person chose this recipient on a card that names it; record that as the disclosure. */
  const consent = async (cfg: SearchConfig): Promise<SearchConfig> => {
    if (keyFree(cfg.provider) || cfg.disclosed) return cfg;
    await requirePeer(peer).call("search.disclose", {
      provider: cfg.provider,
      ...(cfg.provider === "searxng" ? { expectedEndpoint: cfg.baseUrl } : {}),
    });
    return (await requirePeer(peer).call("search.getConfig", undefined)) ?? cfg;
  };
  const savedHere = config?.configured && config.provider === provider;
  const choose = (next: SearchProvider) => {
    setProvider(next);
    setKey("");
    if (keyFree(next)) save(next);
  };
  // A service saved before this change may still be undisclosed; choosing its card again consents.
  const rechoose = (next: SearchProvider) => {
    const saved = config;
    if (next !== provider || !saved?.configured || saved.provider !== next) return;
    if (keyFree(saved.provider) || saved.disclosed) return;
    void task.run(async () => {
      const final = await consent(saved);
      if (scope.current.active && scope.current.peer === peer) setConfig(final);
    });
  };
  const commitKey = () => {
    if (key) save(provider, { apiKey: key });
  };
  const commitUrl = () => {
    const value = baseUrl.trim();
    if (value && !(config?.provider === "searxng" && config.baseUrl === value))
      save("searxng", { baseUrl: value });
  };
  return (
    <SettingsSection title={t("search.title")}>
      <SettingsRow
        icon="search"
        tone="green"
        label={t("search.provider")}
        note={t("search.noteChoice")}
        stacked
      >
        <fieldset className={css.options} disabled={disabled}>
          <legend className={css.hidden}>{t("search.provider")}</legend>
          {PROVIDERS.map((value) => (
            <label key={value} className={css.option}>
              <input
                type="radio"
                name={name}
                value={value}
                checked={provider === value}
                onChange={() => choose(value)}
                onClick={() => rechoose(value)}
              />
              <span className={css.text}>
                <strong>{t(`search.${value}`)}</strong>
                <small>{t(`search.sends.${value}`)}</small>
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsRow>
      {(provider === "brave" || provider === "tavily" || provider === "keenable") && (
        <form
          className={layoutStyles.row}
          onSubmit={(event) => {
            event.preventDefault();
            commitKey();
          }}
        >
          <input
            className={layoutStyles.input}
            aria-label={t("models.apiKey")}
            type="password"
            autoComplete="new-password"
            placeholder={savedHere ? t("search.keySaved") : t("models.apiKey")}
            value={key}
            disabled={disabled}
            onChange={(e) => setKey(e.target.value)}
            onBlur={commitKey}
          />
        </form>
      )}
      {provider === "searxng" && (
        <form
          className={layoutStyles.row}
          onSubmit={(event) => {
            event.preventDefault();
            commitUrl();
          }}
        >
          <input
            className={layoutStyles.input}
            aria-label={t("auth.endpoint")}
            placeholder={t("auth.endpoint")}
            value={baseUrl}
            disabled={disabled}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={commitUrl}
          />
        </form>
      )}
      <SettingsLine
        action={
          config?.configured && (
            <Button
              variant="secondary"
              className={layoutStyles.small}
              disabled={disabled}
              aria-label={t("search.remove")}
              onClick={() =>
                void task.run(async () => {
                  await requirePeer(peer).call("search.removeConfig", undefined);
                  const cfg = await requirePeer(peer).call("search.getConfig", undefined);
                  if (scope.current.active && scope.current.peer === peer) {
                    setConfig(cfg);
                    setProvider("keyless");
                  }
                  setKey("");
                })
              }
            >
              {t("search.removeShort")}
            </Button>
          )
        }
      >
        {t(`search.detail.${provider}`)}
      </SettingsLine>
      {config?.configured && !config.disclosed && !keyFree(config.provider) && (
        <SettingsLine tone="warn" dot="warn">
          {t("search.rechoose", {
            provider:
              config.provider === "searxng" ? config.baseUrl : t(`search.${config.provider}`),
          })}
        </SettingsLine>
      )}
      {task.error && (
        <SettingsLine role="alert" tone="danger" dot="danger">
          {task.error}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
