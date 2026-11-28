import type { Bot, Group, Message, MethodResults } from "@pibot/protocol";
import {
  BotAvatar,
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useT,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button, GroupAvatar } from "@pibot/ui";
import { type ReactNode, useMemo } from "react";
import { Highlight, searchSnippet, searchText } from "./search-snippet.tsx";
import styles from "./sidebar.module.css";

type Results = MethodResults["search.query"];
type Owner = NonNullable<Results["conversations"]>[number];

function OwnerAvatar({ bot, group, bots }: { bot?: Bot; group?: Group; bots: Map<string, Bot> }) {
  return group ? (
    <GroupAvatar size={36}>
      {group.members.map((member) => (
        <BotAvatar
          key={member.botId}
          bot={bots.get(member.botId)}
          unknown={!bots.has(member.botId)}
        />
      ))}
    </GroupAvatar>
  ) : (
    <BotAvatar bot={bot} size={36} />
  );
}

function SearchRow({
  avatar,
  title,
  time,
  children,
  disabled,
  open,
}: {
  avatar: ReactNode;
  title: ReactNode;
  time?: string;
  children?: ReactNode;
  disabled: boolean;
  open(): void;
}) {
  const { language } = useSettings();
  const date = time ? new Date(time) : undefined;
  return (
    <button
      type="button"
      className={`${styles.bot} ${styles.searchRow}`}
      disabled={disabled}
      onClick={open}
    >
      <span className={styles.avatar}>{avatar}</span>
      <span className={styles.summary}>
        <span className={styles.nameLine}>
          <strong>{title}</strong>
          {date && time && (
            <time dateTime={time} title={date.toLocaleString(language)}>
              {date.toDateString() === new Date().toDateString()
                ? date.toLocaleTimeString(language, {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })
                : date.toLocaleDateString(language, { month: "short", day: "numeric" })}
            </time>
          )}
        </span>
        {children}
      </span>
    </button>
  );
}

export function SearchResults({
  query,
  results,
  searching,
  error,
  searchingMore,
  searchOlder,
  busy,
  open,
  openMessage,
}: {
  query: string;
  results?: Results;
  searching: boolean;
  error: boolean;
  searchingMore: boolean;
  searchOlder(): void;
  busy: boolean;
  open(key: string): void;
  openMessage(message: Message): void;
}) {
  const t = useT(),
    { peer } = useRpc(),
    { navigate } = useNavigation(),
    data = useWorkspace(),
    action = useAction();
  const bots = useMemo(() => new Map(data.bots.map((bot) => [bot.id, bot])), [data.bots]);
  const groups = useMemo(
    () => new Map(data.groups.map((group) => [group.id, group])),
    [data.groups],
  );
  const groupByConversation = useMemo(
    () => new Map(data.groups.map((group) => [group.conversationId, group])),
    [data.groups],
  );
  const owners = useMemo(
    () => new Map((results?.conversations ?? []).map((owner) => [owner.id, owner])),
    [results?.conversations],
  );
  const openTopic = (id: string) =>
    void action.run(async (signal) => {
      if (!peer) return;
      const target = await locateConversation(peer, id, signal, data.bots, data.groups);
      signal.throwIfAborted();
      navigate(target);
    });
  const resolve = (owner: Partial<Owner> | undefined, conversationId: string, botId?: string) => {
    const group = owner?.groupId
      ? groups.get(owner.groupId)
      : groupByConversation.get(conversationId);
    // In a group the message's botId is the speaker, not the chat; never show it as the owner.
    if (group || owner?.groupId) return { group, bot: undefined };
    return { group, bot: bots.get(owner?.botId ?? botId ?? "") };
  };
  // Bot / group / topic names share one heading so every row reads "who · which topic".
  const heading = (bot: Bot | undefined, group: Group | undefined, title?: string) => (
    <>
      <Highlight
        text={group?.name ?? bot?.name ?? t("workspace.searchUnknownChat")}
        query={query}
      />
      {title && (
        <span className={styles.topicTitle}>
          {" · "}
          <Highlight text={title} query={query} />
        </span>
      )}
    </>
  );
  const chatCount =
    (results?.bots.length ?? 0) + (results?.groups.length ?? 0) + (results?.topics?.length ?? 0);
  return (
    <>
      <p className={styles.note}>{t("workspace.searchNote")}</p>
      {searching && <p role="status">{t("common.loading")}</p>}
      {error && <p role="alert">{t("workspace.failed")}</p>}
      {!!chatCount && (
        <div role="presentation" className={styles.searchHead}>
          {t("workspace.searchChats", { count: chatCount })}
        </div>
      )}
      {results?.bots.map((bot) => (
        <SearchRow
          key={bot.id}
          avatar={<BotAvatar bot={bot} size={36} />}
          title={heading(bot, undefined)}
          disabled={busy}
          open={() => open(`dm:${bot.id}`)}
        />
      ))}
      {results?.groups.map((group) => (
        <SearchRow
          key={group.id}
          avatar={<OwnerAvatar group={group} bots={bots} />}
          title={heading(undefined, group)}
          disabled={busy}
          open={() => open(`group:${group.id}`)}
        />
      ))}
      {results?.topics?.map((topic) => {
        const { bot, group } = resolve(topic, topic.id);
        return (
          <SearchRow
            key={topic.id}
            avatar={<OwnerAvatar bot={bot} group={group} bots={bots} />}
            title={heading(bot, group, topic.title || t("workspace.openChat"))}
            disabled={busy || action.busy}
            open={() => openTopic(topic.id)}
          />
        );
      })}
      {!!results?.messages.length && (
        <div role="presentation" className={styles.searchHead}>
          {t("workspace.searchMessages", { count: results.messages.length })}
        </div>
      )}
      {results?.messages.map((message) => {
        const owner = owners.get(message.conversationId);
        const { bot, group } = resolve(owner, message.conversationId, message.botId ?? undefined);
        return (
          <SearchRow
            key={message.id}
            avatar={<OwnerAvatar bot={bot} group={group} bots={bots} />}
            title={heading(bot, group, owner?.title)}
            time={message.createdAt}
            disabled={busy}
            open={() => openMessage(message)}
          >
            <span className={styles.snippet}>
              <Highlight
                text={message.snippet ?? searchSnippet(searchText(message.content), query)}
                query={query}
              />
            </span>
          </SearchRow>
        );
      })}
      {results?.nextCursor && (
        <Button variant="ghost" disabled={searchingMore} onClick={searchOlder}>
          {searchingMore ? t("common.loading") : t("workspace.searchOlder")}
        </Button>
      )}
      {results &&
        !results.nextCursor &&
        !results.bots.length &&
        !results.groups.length &&
        !results.messages.length &&
        !results.topics?.length && <p className={styles.searchEmpty}>{t("workspace.noMatch")}</p>}
      {busy && <p role="status">{t("common.loading")}</p>}
    </>
  );
}
