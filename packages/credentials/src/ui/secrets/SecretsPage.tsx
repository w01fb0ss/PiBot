import {
  type Bot,
  RpcError,
  RpcErrorCodes,
  type UserSecretMeta,
} from "@pibot/credentials-contract/full";
import type { TranslationKey } from "@pibot/i18n";
import { type Peer, useRpc, useRpcEvent, useSettings, useT } from "@pibot/renderer-kit";
import { Button, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { SecretFeedback, SecretPagination } from "./feedback.tsx";
import { SecretPanelShell } from "./panel.tsx";
import { useSecretPage, useSecretRead } from "./remote.ts";
import styles from "./secrets.module.css";

// Secret names must never collide with environment
// variables commands rely on, so the form refuses them before the backend does.
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_SECRET_NAME_SUFFIX = /_PROXY$/;
const RESERVED_SECRET_NAME_PREFIX = /^(LD_|DYLD_)/;

function reservedSecretName(name: string) {
  return (
    name === "PATH" ||
    name === "HOME" ||
    name === "NODE_OPTIONS" ||
    RESERVED_SECRET_NAME_SUFFIX.test(name) ||
    RESERVED_SECRET_NAME_PREFIX.test(name)
  );
}

function nameProblem(
  name: string,
  editing: boolean,
  existing: readonly UserSecretMeta[],
): TranslationKey | undefined {
  if (!SECRET_NAME_PATTERN.test(name)) return "connectors.secrets.nameHint";
  if (reservedSecretName(name)) return "connectors.secrets.nameReserved";
  // Local hint only; the backend stays authoritative for cross-window duplicates.
  if (!editing && existing.some((secret) => secret.name === name))
    return "connectors.secrets.error.exists";
  return undefined;
}

function isSecretsUnavailable(error: unknown) {
  return error instanceof RpcError && error.code === RpcErrorCodes.secretsUnavailable;
}

function secretWriteError(error: unknown, fallback: TranslationKey): TranslationKey {
  if (error instanceof RpcError) {
    if (error.code === RpcErrorCodes.secretExists) return "connectors.secrets.error.exists";
    if (error.code === RpcErrorCodes.secretStale) return "connectors.secrets.error.stale";
    if (error.code === RpcErrorCodes.secretsUnavailable)
      return "connectors.secrets.error.unavailable";
    if (error.code === RpcErrorCodes.invalidParams) return "connectors.secrets.error.invalid";
    if (error.code === RpcErrorCodes.closed) return "connectors.offline";
  }
  return fallback;
}

type Assignment = UserSecretMeta["assignment"];

type Form =
  | { mode: "create"; initialName?: string }
  | { mode: "edit"; name: string; only?: "value" | "meta" }
  | { mode: "delete"; name: string };

/**
 * 访问令牌: the tokens the person added for connections and commands, listed inside the
 * connections page's tokens dialog. Values are write-only: typed once, submitted, cleared, and
 * never sent back to the renderer. `create` is bumped by the dialog footer's 新建令牌 button;
 * `formOpen` lets the dialog hide its own rows while a form stands in for the list.
 */
export function SecretsPage({
  create = 0,
  formOpen,
  others = 0,
  initialSecret,
}: {
  create?: number;
  formOpen?(open: boolean): void;
  /** Tokens the dialog lists from elsewhere; the empty state shows only when there are none. */
  others?: number;
  /** Opens directly on replacing this secret's value once the list loads. */
  initialSecret?: string;
}) {
  const t = useT();
  const { language } = useSettings();
  const { peer } = useRpc();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors.at(-1);
  const [items, setItems] = useState<UserSecretMeta[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"loadError" | "unavailable">();
  const [missingTarget, setMissingTarget] = useState<string>();
  const generation = useRef(0);
  const openedInitial = useRef<string | undefined>(undefined);
  const skipNextLoad = useRef(false);
  const load = useCallback(async () => {
    if (!peer) return;
    if (skipNextLoad.current) {
      skipNextLoad.current = false;
      return;
    }
    const version = ++generation.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await peer.call(
        "secrets.list",
        { limit: 50, ...(cursor ? { cursor } : {}) },
        { signal: AbortSignal.timeout(15_000) },
      );
      if (version !== generation.current) return;
      if (!cursor && initialSecret && openedInitial.current !== initialSecret) {
        if (result.items.some((secret) => secret.name === initialSecret)) {
          openedInitial.current = initialSecret;
          setMissingTarget(undefined);
          setItems(result.items);
          setNextCursor(result.nextCursor);
          setLoading(false);
          setForm({ mode: "edit", name: initialSecret, only: "value" });
          return;
        }
        // Secrets are ordered by name ASC; walk later pages until we find `initialSecret` or pass it.
        const trail: (string | undefined)[] = [undefined];
        let pageCursor = result.nextCursor;
        let last = result.items.at(-1)?.name ?? "";
        for (let step = 0; step < 200 && pageCursor && last < initialSecret; step += 1) {
          trail.push(pageCursor);
          const page = await peer.call(
            "secrets.list",
            { limit: 50, cursor: pageCursor },
            { signal: AbortSignal.timeout(15_000) },
          );
          if (version !== generation.current) return;
          if (page.items.some((secret) => secret.name === initialSecret)) {
            openedInitial.current = initialSecret;
            skipNextLoad.current = true;
            setMissingTarget(undefined);
            setCursors(trail);
            setItems(page.items);
            setNextCursor(page.nextCursor);
            setLoading(false);
            setForm({ mode: "edit", name: initialSecret, only: "value" });
            return;
          }
          pageCursor = page.nextCursor;
          last = page.items.at(-1)?.name ?? last;
        }
        openedInitial.current = initialSecret;
        setMissingTarget(initialSecret);
      }
      setItems(result.items);
      setNextCursor(result.nextCursor);
      setLoading(false);
    } catch (failure) {
      if (version !== generation.current) return;
      setError(isSecretsUnavailable(failure) ? "unavailable" : "loadError");
      setLoading(false);
    }
  }, [peer, cursor, initialSecret]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      clearTimeout(refreshTimer.current);
      refreshTimer.current = undefined;
    };
  }, [load]);
  // A new value can redact other rows too; only the server's page is authoritative.
  useRpcEvent("secrets.changed", () => {
    generation.current++;
    setLoading(true);
    if (refreshTimer.current !== undefined) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void load();
    }, 150);
  });
  const unavailable = error === "unavailable";
  const readBots = useCallback(
    (readPeer: Peer, signal: AbortSignal) => readPeer.call("bots.list", { limit: 100 }, { signal }),
    [],
  );
  const bots = useSecretRead(readBots);
  const botNames = new Map((bots.value ?? []).map((bot) => [bot.id, bot.name]));
  const assignmentText = (assignment: Assignment) =>
    assignment.kind === "all"
      ? t("connectors.secrets.assignment.all")
      : assignment.bots
          .map((id) => botNames.get(id) ?? t("connectors.unknownBot", { id }))
          .join(t("connectors.secrets.listSeparator"));
  const upsert = useCallback(
    (saved: UserSecretMeta) => {
      if (saved.name === missingTarget) setMissingTarget(undefined);
      void load();
    },
    [load, missingTarget],
  );
  const remove = useCallback((name: string) => {
    setItems((prev) => prev.filter((secret) => secret.name !== name));
  }, []);
  const [form, setForm] = useState<Form>();
  const editing = form && form.mode !== "create" ? form.name : undefined;
  const target = editing ? items.find((secret) => secret.name === editing) : undefined;
  // The footer button bumps `create`; the first value is the mount, not a request.
  const created = useRef(create);
  useEffect(() => {
    if (create === created.current) return;
    created.current = create;
    setForm({ mode: "create" });
  }, [create]);
  useEffect(() => {
    formOpen?.(!!form);
  }, [form, formOpen]);
  // If the secret under edit disappeared elsewhere, the CAS form is meaningless.
  useEffect(() => {
    if (form?.mode === "edit" && !loading && !items.some((secret) => secret.name === form.name))
      setForm(undefined);
  }, [form, items, loading]);
  const formatTime = (value: string | null) =>
    value
      ? t("connectors.secrets.lastUsedAt", {
          time: new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en", {
            dateStyle: "short",
            timeStyle: "short",
          }),
        })
      : t("connectors.secrets.neverUsed");
  if (form?.mode === "delete")
    return (
      <DeleteSecretPanel
        key={form.name}
        secret={target}
        removed={remove}
        refresh={load}
        close={() => setForm(undefined)}
      />
    );
  if (form)
    return (
      <SecretPanel
        key={form.mode === "edit" ? form.name : `create:${form.initialName ?? ""}`}
        secret={form.mode === "edit" ? target : undefined}
        initialName={form.mode === "create" ? form.initialName : undefined}
        only={form.mode === "edit" ? form.only : undefined}
        unavailable={unavailable}
        existing={items}
        upsert={upsert}
        refresh={load}
        close={() => setForm(undefined)}
      />
    );
  return (
    <div className={styles.content}>
      {unavailable && (
        <p role="alert" className={styles.warn}>
          {t("connectors.secrets.unavailable")}
        </p>
      )}
      {missingTarget && !unavailable && (
        <div role="status" className={styles.warn}>
          <p>{t("connectors.secrets.missingTarget", { name: missingTarget })}</p>
          <Button
            variant="secondary"
            disabled={!peer}
            onClick={() => setForm({ mode: "create", initialName: missingTarget })}
          >
            {t("connectors.secrets.createNamed", { name: missingTarget })}
          </Button>
        </div>
      )}
      <SecretFeedback
        loading={loading && !items.length}
        error={error === "loadError" ? "connectors.secrets.loadError" : undefined}
        retry={load}
      />
      {!loading && !error && !items.length && !others && (
        <div className={styles.empty}>
          <b>{t("connectors.secrets.empty")}</b>
          <span>{t("connectors.secrets.emptyHint")}</span>
        </div>
      )}
      {!!items.length && (
        <div className={styles.secretsList}>
          {items.map((secret) => (
            <div className={styles.secretRow} key={secret.name}>
              <IconTile icon="key" tone="violet" />
              <div className={styles.secretText}>
                <span className={styles.mono}>{secret.name}</span>
                <small>
                  {[
                    secret.description || t("connectors.secrets.usedByCommands"),
                    t("connectors.secrets.addedByYou"),
                    secret.hasValue
                      ? formatTime(secret.lastUsedAt)
                      : t("connectors.secrets.noValue"),
                  ].join(" · ")}
                </small>
              </div>
              <span className={styles.who}>{assignmentText(secret.assignment)}</span>
              <RowMenu
                label={t("connectors.secrets.more", { name: secret.name })}
                disabled={!peer || unavailable}
                items={[
                  {
                    label: t("connectors.secrets.replaceValue"),
                    icon: "key",
                    tone: "violet",
                    run: () => setForm({ mode: "edit", name: secret.name, only: "value" }),
                  },
                  {
                    label: t("connectors.secrets.editMeta"),
                    icon: "edit",
                    tone: "blue",
                    run: () => setForm({ mode: "edit", name: secret.name, only: "meta" }),
                  },
                  {
                    label: t("connectors.secrets.deleteMenu"),
                    icon: "trash",
                    tone: "red",
                    danger: true,
                    run: () => setForm({ mode: "delete", name: secret.name }),
                  },
                ]}
              />
            </div>
          ))}
        </div>
      )}
      <SecretPagination
        previous={cursors.length > 1 ? () => setCursors((value) => value.slice(0, -1)) : undefined}
        next={nextCursor ? () => setCursors((value) => [...value, nextCursor]) : undefined}
        disabled={loading || !peer}
      />
    </div>
  );
}

/** The ⋯ menu of a token row (design ③); closes on Escape, outside clicks and after a choice. */
export function RowMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: { label: string; icon: IconName; tone: Tone; run(): void; danger?: boolean }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // Escape closes the menu only; the tokens dialog stays open.
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
  return (
    <div ref={root} className={styles.menuRoot}>
      <button
        type="button"
        className={styles.dots}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onKeyDown={closeOnEscape}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className={styles.menu} onKeyDown={closeOnEscape}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? `${styles.menuItem} ${styles.menuDanger}` : styles.menuItem}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              <IconTile icon={item.icon} tone={item.tone} size="sm" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Add/replace panel (S5 right side): the value is typed once and never echoed. */
function SecretPanel({
  secret,
  initialName,
  only,
  unavailable,
  existing,
  upsert,
  refresh,
  close,
}: {
  secret?: UserSecretMeta;
  initialName?: string;
  /** 更换值 shows only the value; 改说明和谁能用 shows everything but the value. */
  only?: "value" | "meta";
  unavailable: boolean;
  existing: readonly UserSecretMeta[];
  upsert(secret: UserSecretMeta): void;
  refresh(): Promise<void>;
  close(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const editing = !!secret;
  const nameId = useId();
  const valueId = useId();
  const descriptionId = useId();
  const assignId = useId();
  const [name, setName] = useState(secret?.name ?? initialName ?? "");
  // The draft value lives only in this state; it is cleared on submit and never rendered back.
  const [value, setValue] = useState("");
  const [description, setDescription] = useState(secret?.description ?? "");
  // Keep the revision paired with the opened draft: events must not turn stale
  // permission edits into a successful overwrite of a newer restriction.
  const [revision, setRevision] = useState(secret?.revision);
  const [assignment, setAssignment] = useState<Assignment>(secret?.assignment ?? { kind: "all" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const loadBots = useCallback(async (botPeer: Peer, signal: AbortSignal, cursor?: string) => {
    const bots = await botPeer.call("bots.list", { before: cursor, limit: 50 }, { signal });
    return { items: bots, nextCursor: bots.length === 50 ? (bots.at(-1)?.id ?? null) : null };
  }, []);
  const bots = useSecretPage<Bot>(loadBots, 0);
  const nameError = editing ? undefined : nameProblem(name.trim(), editing, existing);
  const toggleBot = (id: string) =>
    setAssignment((current) => {
      if (current.kind !== "bots") return current;
      const bots1 = current.bots.includes(id)
        ? current.bots.filter((bot) => bot !== id)
        : [...current.bots, id];
      return { kind: "bots", bots: bots1 };
    });
  const stale = editing && secret.revision !== revision;
  const emptyAssignment = assignment.kind === "bots" && assignment.bots.length === 0;
  const missingValue = only === "value" && !value;
  const reload = () => {
    if (!secret) return;
    setDescription(secret.description);
    setAssignment(secret.assignment);
    setRevision(secret.revision);
    setValue("");
    setError(undefined);
  };
  const selected = new Set(assignment.kind === "bots" ? assignment.bots : []);
  const visibleIds = new Set((bots.value?.items ?? []).map((bot) => bot.id));
  const save = async () => {
    if (!peer || busy || unavailable || nameError || stale || emptyAssignment || missingValue)
      return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await peer.call(
        "secrets.set",
        {
          name: editing ? secret.name : name.trim(),
          // Absent value keeps the stored one on edit; the field is never pre-filled.
          ...(value ? { value } : {}),
          description,
          assignment,
          ...(editing ? { expectedRevision: revision } : {}),
        },
        { signal: AbortSignal.timeout(30_000) },
      );
      upsert(result.secret);
      setValue("");
      close();
    } catch (failure) {
      setError(secretWriteError(failure, "connectors.secrets.error.save"));
      // A CAS conflict means the row moved on: pull the authoritative revision.
      if (failure instanceof RpcError && failure.code === RpcErrorCodes.secretStale) void refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SecretPanelShell
      title={
        editing
          ? `${t(only === "value" ? "connectors.secrets.replaceValue" : "connectors.secrets.editMeta")} · ${secret.name}`
          : t("connectors.secrets.create")
      }
      close={close}
      busy={busy}
    >
      {!peer && (
        <p role="alert" className={styles.error}>
          {t("connectors.offline")}
        </p>
      )}
      {stale && (
        <div role="alert" className={styles.warn}>
          <p>{t("connectors.secrets.error.stale")}</p>
          <Button variant="secondary" disabled={busy} onClick={reload}>
            {t("connectors.secrets.reload")}
          </Button>
        </div>
      )}
      {!editing && (
        <>
          <label className={styles.field} htmlFor={nameId}>
            {t("connectors.secrets.name")}
            <input
              id={nameId}
              className={styles.mono}
              value={name}
              maxLength={64}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              placeholder={t("connectors.secrets.namePlaceholder")}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          {/* An empty name is only "not yet"; the hint shows until something invalid is typed. */}
          {nameError && name.trim() ? (
            <p role="alert" className={styles.error}>
              {t(nameError)}
            </p>
          ) : (
            <p className={styles.note}>{t("connectors.secrets.nameHint")}</p>
          )}
        </>
      )}
      {only !== "meta" && (
        <label className={styles.field} htmlFor={valueId}>
          {t("connectors.secrets.value")}
          <input
            id={valueId}
            type="password"
            value={value}
            spellCheck={false}
            autoComplete="new-password"
            disabled={busy || unavailable}
            placeholder={t("connectors.secrets.valuePlaceholder")}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </label>
      )}
      {only !== "value" && (
        <>
          <label className={styles.field} htmlFor={descriptionId}>
            {t("connectors.secrets.description")}
            <input
              id={descriptionId}
              value={description}
              maxLength={4096}
              autoComplete="off"
              disabled={busy}
              placeholder={t("connectors.secrets.descriptionPlaceholder")}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <fieldset disabled={busy || unavailable} className={styles.options}>
            <legend className={styles.note}>{t("connectors.secrets.assignment")}</legend>
            <label className={styles.row}>
              <input
                type="radio"
                name={assignId}
                checked={assignment.kind === "all"}
                onChange={() => setAssignment({ kind: "all" })}
              />
              {t("connectors.secrets.assignment.all")}
            </label>
            <label className={styles.row}>
              <input
                type="radio"
                name={assignId}
                checked={assignment.kind === "bots"}
                onChange={() => setAssignment({ kind: "bots", bots: [] })}
              />
              {t("connectors.secrets.assignment.bots")}
            </label>
            {assignment.kind === "bots" && (
              <>
                {bots.value?.items.map((bot) => (
                  <label key={bot.id} className={styles.row}>
                    <input
                      type="checkbox"
                      checked={selected.has(bot.id)}
                      disabled={!selected.has(bot.id) && selected.size >= 64}
                      onChange={() => toggleBot(bot.id)}
                    />
                    {bot.name}
                  </label>
                ))}
                {assignment.bots
                  .filter((id) => !visibleIds.has(id))
                  .map((id) => (
                    <label key={id} className={styles.row}>
                      <input type="checkbox" checked onChange={() => toggleBot(id)} />
                      {t("connectors.unknownBot", { id })}
                    </label>
                  ))}
                {!bots.value?.items.length && !bots.loading && !bots.error && (
                  <p className={styles.note}>{t("connectors.noBots")}</p>
                )}
                <SecretFeedback loading={bots.loading} error={bots.error} retry={bots.refresh} />
                <SecretPagination
                  previous={bots.previous}
                  next={bots.next}
                  disabled={bots.loading || busy}
                />
              </>
            )}
          </fieldset>
        </>
      )}
      {emptyAssignment && (
        <p role="alert" className={styles.error}>
          {t("connectors.secrets.selectBot")}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      <div className={styles.formFoot}>
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t("connectors.secrets.cancel")}
        </Button>
        <Button
          loading={busy}
          disabled={
            !peer || busy || unavailable || !!nameError || stale || emptyAssignment || missingValue
          }
          onClick={() => void save()}
        >
          {t("connectors.secrets.save")}
        </Button>
      </div>
    </SecretPanelShell>
  );
}

/** Delete needs an explicit confirm; the backend also revokes remembered grants. */
function DeleteSecretPanel({
  secret,
  removed,
  refresh,
  close,
}: {
  secret?: UserSecretMeta;
  removed(name: string): void;
  refresh(): Promise<void>;
  close(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  if (!secret) {
    // The row vanished in another window while the confirm was open.
    return (
      <SecretPanelShell title={t("connectors.secrets.delete")} close={close}>
        <p role="alert" className={styles.error}>
          {t("connectors.secrets.error.stale")}
        </p>
        <Button variant="secondary" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </SecretPanelShell>
    );
  }
  const remove = async () => {
    if (!peer || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await peer.call(
        "secrets.delete",
        { name: secret.name, expectedRevision: secret.revision },
        { signal: AbortSignal.timeout(30_000) },
      );
      removed(secret.name);
      close();
    } catch (failure) {
      setError(secretWriteError(failure, "connectors.secrets.error.delete"));
      if (failure instanceof RpcError && failure.code === RpcErrorCodes.secretStale) void refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SecretPanelShell title={t("connectors.secrets.delete")} close={close} busy={busy}>
      <p>{t("connectors.secrets.deleteConfirm", { name: secret.name })}</p>
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}
        </p>
      )}
      <div className={styles.formFoot}>
        <Button variant="secondary" disabled={busy} onClick={close}>
          {t("connectors.secrets.cancel")}
        </Button>
        <Button
          className={styles.dangerButton}
          loading={busy}
          disabled={!peer || busy}
          onClick={() => void remove()}
        >
          {t("connectors.secrets.deleteButton")}
        </Button>
      </div>
    </SecretPanelShell>
  );
}
