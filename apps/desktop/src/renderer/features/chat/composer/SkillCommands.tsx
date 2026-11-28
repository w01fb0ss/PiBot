import { type ConnectorCommand, type Skill, slashHelpRequest } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./skill-commands.module.css";

type Owner = { id: string; name: string };
type Entry =
  | { kind: "skill"; skill: Skill; owner: Owner }
  | { kind: ConnectorCommand["kind"]; connection: ConnectorCommand; owner: Owner };

const sections = [
  { kind: "skill", label: "skillCommands.skills", icon: "puzzle", tone: "violet" },
  { kind: "app", label: "skillCommands.apps", icon: "box", tone: "blue" },
  { kind: "mcp", label: "skillCommands.mcp", icon: "plug", tone: "violet" },
] as const;
const PAGE = 50;
const entryToken = (entry: Entry) =>
  entry.kind === "skill" ? entry.skill.name : entry.connection.token;

/** Slash menu selection only edits the draft. */
export function useSkillCommands(options: {
  owners: Owner[];
  groupId?: string;
  connectionOwners: Owner[];
  defaultConnectionOwnerId?: string;
  readOnly?: boolean;
  text: string;
  edit(text: string): void;
  disabled: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const { peer } = useRpc();
  const t = useT();
  const id = useId();
  const key = JSON.stringify([
    options.groupId,
    options.readOnly,
    options.owners.map(({ id, name }) => ({ id, name })),
    options.connectionOwners.map(({ id, name }) => ({ id, name })),
  ]);
  const [dismissed, setDismissed] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{
    key: string;
    peer: typeof peer;
    rows: Entry[];
    more: boolean;
    failed: boolean;
  }>();
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ key, pages: 1 });
  const pages = pagination.key === key ? pagination.pages : 1;
  const caret = useRef<string | undefined>(undefined);
  const pattern = /^\/([^\r\n]*)$/u.exec(options.text);
  const helpRequest = !!slashHelpRequest(options.text);
  const enabled = !options.disabled && options.owners.length > 0;
  const load = !!pattern && !helpRequest && enabled;
  useEffect(() => {
    setSelected(0);
    setDismissed((current) => (current === options.text ? current : undefined));
  }, [options.text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision refreshes after skill changes or Retry.
  useEffect(() => {
    if (!load || !peer) return;
    const controller = new AbortController();
    setLoading(true);
    const [rawGroupId, rawReadOnly, owners, connectionOwners] = JSON.parse(key) as [
      string | null,
      boolean | null,
      Owner[],
      Owner[],
    ];
    const groupId = rawGroupId ?? undefined;
    const readOnly = rawReadOnly ?? undefined;
    const refresh = () => setRevision((value) => value + 1);
    void Promise.allSettled([
      ...owners.map(async (owner) => {
        const rows: Entry[] = [];
        let before: string | undefined;
        let more = false;
        for (let page = 0; page < pages; page++) {
          const skills = await peer.call(
            "skills.list",
            {
              botId: owner.id,
              groupId,
              effective: true,
              enabled: true,
              // Built-in methods are the Bot's planning references, not a user menu.
              builtin: false,
              limit: PAGE,
              before,
            },
            { signal: controller.signal },
          );
          rows.push(
            ...skills
              .filter((skill) => skill.botId === owner.id && skill.enabled)
              .map((skill): Entry => ({ kind: "skill", skill, owner })),
          );
          more = skills.length === PAGE;
          before = skills.at(-1)?.id;
          if (!more) break;
        }
        return { rows, more };
      }),
      ...connectionOwners.map(async (owner) => {
        const rows: Entry[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < pages; page++) {
          const result: { items: ConnectorCommand[]; nextCursor: string | null } = await peer.call(
            "connections.commands",
            { botId: owner.id, groupId, readOnly, limit: PAGE, cursor: cursor ?? undefined },
            { signal: controller.signal },
          );
          const { items, nextCursor } = result;
          rows.push(
            ...items.map((connection): Entry => ({ kind: connection.kind, connection, owner })),
          );
          cursor = nextCursor;
          if (!cursor) break;
        }
        return { rows, more: !!cursor };
      }),
    ])
      .then((results) => {
        if (controller.signal.aborted) return;
        const loaded = results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const seen = new Set<string>();
        const rows = loaded
          .flatMap((result) => result.rows)
          .filter((entry) => {
            if (entry.kind === "skill") return true;
            if (seen.has(entry.connection.id)) return false;
            seen.add(entry.connection.id);
            return true;
          });
        setData({
          key,
          peer,
          rows,
          more: loaded.some((result) => result.more),
          failed: loaded.length !== results.length,
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const off = peer.on("skills.changed", (event) => {
      if (event.groupId === groupId && owners.some((owner) => owner.id === event.botId)) refresh();
    });
    const offConnections = connectionOwners.length
      ? peer.on("connectors.changed", refresh)
      : undefined;
    const offPlugins = connectionOwners.length ? peer.on("plugins.changed", refresh) : undefined;
    const offCapabilities = connectionOwners.length
      ? peer.on("capabilities.changed", refresh)
      : undefined;
    const offPermissions = connectionOwners.length
      ? peer.on("permissions.changed", refresh)
      : undefined;
    return () => {
      controller.abort();
      off();
      offConnections?.();
      offPlugins?.();
      offCapabilities?.();
      offPermissions?.();
    };
  }, [load, peer, key, pages, revision]);
  const current = data?.key === key && data.peer === peer ? data : undefined;
  const commandText = (entry: Entry) =>
    `/${entryToken(entry)}${options.groupId && entry.owner.id !== options.defaultConnectionOwnerId ? ` @${entry.owner.name}` : ""}`;
  const usableEntries = (current?.rows ?? []).filter((entry) => {
    const token = entryToken(entry);
    return !/^(?:help|帮助)$/iu.test(token) && !/[\p{Cc}\p{Cf}]/u.test(token);
  });
  const text = options.text.trimEnd().toLowerCase();
  const matching =
    enabled &&
    (usableEntries.some((entry) => commandText(entry).toLowerCase() === text) ||
      usableEntries.filter((entry) => `/${entryToken(entry).toLowerCase()}` === text).length === 1);
  const afterCommand = usableEntries.some((entry) =>
    text.startsWith(`${commandText(entry).toLowerCase()} `),
  );
  const open = load && !matching && !afterCommand && dismissed !== options.text;
  const helpCompletion = matching
    ? (/\s$/u.test(options.text) ? "" : " ") + t("skillCommands.helpToken")
    : undefined;
  const query = (pattern?.[1] ?? "").trim().toLocaleLowerCase();
  const grouped = sections.map((section) => ({
    ...section,
    entries: usableEntries.filter((entry) => {
      if (entry.kind !== section.kind) return false;
      const text =
        entry.kind === "skill"
          ? `${entry.skill.name} ${entry.skill.description}`
          : entry.connection.token;
      return `${entry.owner.name} ${text}`.toLocaleLowerCase().includes(query);
    }),
  }));
  const entries = grouped.flatMap((section) => section.entries);
  const entryIndexes = new Map(entries.map((entry, index) => [entry, index]));
  const active = Math.min(selected, Math.max(0, entries.length - 1));
  useLayoutEffect(() => {
    if (caret.current !== undefined && caret.current === options.text) {
      options.textarea.current?.focus();
      options.textarea.current?.setSelectionRange(options.text.length, options.text.length);
      caret.current = undefined;
    }
  }, [options.text, options.textarea]);
  const pick = (entry: Entry) => {
    const text = `${commandText(entry)} `;
    caret.current = text;
    options.edit(text);
    setDismissed(text);
    setSelected(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => {
    if (
      !open ||
      composing ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return false;
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return false;
    if (!entries.length && (event.key === "Tab" || (event.key === "Enter" && !loading)))
      return false;
    event.preventDefault();
    if (event.key === "Escape") setDismissed(options.text);
    else if (event.key === "Enter" || event.key === "Tab") {
      const entry = entries[active];
      if (entry) pick(entry);
    } else {
      const next =
        (active + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
        Math.max(1, entries.length);
      setSelected(next);
      if (entries.length)
        document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: "nearest" });
    }
    return true;
  };
  const popup = open ? (
    <div className={styles.anchor}>
      <div className={styles.menu}>
        <div id={id} role="listbox" aria-label={t("skillCommands.title")}>
          {grouped.map(({ kind, label, icon, tone, entries: rows }) =>
            rows.length ? (
              <fieldset key={kind} className={styles.section}>
                <legend className={styles.heading}>{t(label)}</legend>
                {rows.map((entry) => {
                  const index = entryIndexes.get(entry);
                  const skill = entry.kind === "skill" ? entry.skill : undefined;
                  const name = entry.kind === "skill" ? entry.skill.name : entry.connection.name;
                  const token = entry.kind === "skill" ? undefined : entry.connection.token;
                  return (
                    <button
                      type="button"
                      role="option"
                      tabIndex={-1}
                      id={`${id}-${index}`}
                      key={entry.kind === "skill" ? entry.skill.id : entry.connection.id}
                      aria-selected={index === active}
                      className={styles.option}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pick(entry)}
                    >
                      <IconTile icon={icon} tone={tone} className={styles.tile} />
                      <span>
                        {name}
                        {options.groupId && <small> · {entry.owner.name}</small>}
                      </span>
                      <small>{skill?.description ?? `/${token}`}</small>
                    </button>
                  );
                })}
              </fieldset>
            ) : null,
          )}
        </div>
        {loading ? (
          <p role="status">{t("common.loading")}</p>
        ) : current?.failed ? (
          <p role="alert">{t("skillCommands.failed")}</p>
        ) : (
          !entries.length &&
          (query ? (
            <p className={styles.empty}>
              {t("skillCommands.noMatch", { query: pattern?.[1] ?? "" })}
            </p>
          ) : (
            // Maintainers 2026-11-13: an empty list said only "no match"; say what to do instead.
            <div className={styles.none}>
              <IconTile icon="puzzle" tone="violet" />
              <span>
                <b>{t("skillCommands.none")}</b>
                <small>{t("skillCommands.noneHint")}</small>
              </span>
            </div>
          ))
        )}
        {current?.failed && (
          <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        )}
        {current?.more && pages < 4 && (
          <Button variant="ghost" onClick={() => setPagination({ key, pages: pages + 1 })}>
            {t("skillCommands.more")}
          </Button>
        )}
        {current?.more && pages === 4 && <p>{t("skillCommands.limit")}</p>}
      </div>
    </div>
  ) : null;
  return {
    popup,
    helpCompletion,
    onKeyDown,
    open,
    id,
    activeId: entries.length ? `${id}-${active}` : undefined,
  };
}
