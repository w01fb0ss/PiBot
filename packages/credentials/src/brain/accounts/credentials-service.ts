import { randomUUID } from "node:crypto";
import { abortable } from "@pibot/brain/kit";
import {
  type Credential,
  type CredentialCapture,
  credentialSite,
  credentialSiteLabel,
  credentialSiteMatches,
  type MethodParams,
  type MethodResults,
  RpcError,
  RpcErrorCodes,
} from "@pibot/credentials-contract/full";
import { assertSafeSecretValue } from "@pibot/secrets";
import {
  ApprovalPausesRepo,
  BotsRepo,
  SecretStore,
  SettingsRepo,
  transaction,
} from "@pibot/storage";
import { z } from "zod";
import { type SiteCredentialMatch, SiteCredentialsRepo } from "../../store/index.ts";
import type { CredentialContext } from "../context.ts";
import { resolveCredentialLanguage } from "../language.ts";
import { fillForTakeover, takeoverAccounts } from "./credentials-takeover.ts";
import { currentTotp, parseTotp, TotpConfigSchema } from "./credentials-totp.ts";

// The one encrypted blob per record: username, password and the note together (the note joined
// later, and users may still fill it with hints). JSON keeps any character safe for the host's
// SecretCipher input rules. Older blobs have no `n`.
const SecretSchema = z.strictObject({
  u: z.string().max(500),
  p: z.string().min(1).max(1000),
  n: z.string().max(1000).optional(),
});
type Secret = { username: string; password: string; note: string };
const TOTP_SCOPE = "credential-totp";

const CHOICE_TTL_MS = 15 * 60 * 1000;
const CAPTURE_HOST_TIMEOUT_MS = 10_000;

const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);

/** Default display name: enough to tell accounts apart, not the full username. */
export function maskAccount(username: string): string {
  const value = username.trim();
  const at = value.indexOf("@");
  const local = at > 0 ? value.slice(0, at) : value;
  const domain = at > 0 ? value.slice(at) : "";
  const shown =
    local.length <= 4
      ? `${local.slice(0, 1)}***`
      : `${local.slice(0, 2)}***${domain ? "" : local.slice(-1)}`;
  return `${shown}${domain}`.slice(0, 200) || "***";
}

/** Candidates for one login: the most specific matching saved site and its accounts. */
export interface LoginCandidates {
  site: string;
  accounts: { id: string; label: string }[];
}

/**
 * Saved website accounts. Owns the repository, the in-memory account choices of
 * pending first-login cards and the public part of "save this account?" prompts after a
 * takeover. Plaintext exists only transiently: decrypted for one fill or one authenticated
 * reveal, and registered with the redactor so no log, audit or model text can carry it.
 */
export class CredentialService {
  readonly repo: SiteCredentialsRepo;
  private readonly totpStore: SecretStore;
  private readonly choices = new Map<string, { credentialId: string; at: number }>();
  private readonly captures = new Map<string, CredentialCapture>();
  /** Sites (and the account) the user allowed during a run: `${runId}\n${site}` → account. */
  private readonly runLogins = new Map<string, { credentialId: string; at: number }>();

  constructor(private readonly local: CredentialContext) {
    this.repo = new SiteCredentialsRepo(local.deps.db);
    this.totpStore = new SecretStore(local.deps.db, local.deps.host.secrets, local.deps.redactor);
  }

  private get deps() {
    return this.local.deps;
  }

  private remember(password: string) {
    // Short or unusual passwords cannot be registered; they still never reach logs by design.
    try {
      assertSafeSecretValue(password);
      this.deps.redactor.add(password);
    } catch {
      // assertSafeSecretValue rejects leading/trailing spaces, newlines and "!" prefixes.
    }
  }

  private async requireStorage() {
    if (!(await this.deps.host.secrets.isAvailable()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
  }

  private async seal(secret: Secret): Promise<Uint8Array> {
    await this.requireStorage();
    const blob = await this.deps.host.secrets.encrypt(
      JSON.stringify({
        u: secret.username,
        p: secret.password,
        ...(secret.note ? { n: secret.note } : {}),
      }),
    );
    this.remember(secret.password);
    return blob;
  }

  private async decrypt(id: string) {
    const blob = this.repo.secret(id);
    if (!blob) throw invalid("credential_not_found");
    await this.requireStorage();
    const parsed = SecretSchema.safeParse(JSON.parse(await this.deps.host.secrets.decrypt(blob)));
    // A blob that does not parse is not echoed anywhere; the record is treated as unreadable.
    if (!parsed.success) throw new RpcError(RpcErrorCodes.internal, "credential_unreadable");
    return parsed.data;
  }

  /** A pre-T17 plaintext note still in its column wins until it is moved into the blob. */
  private async open(id: string): Promise<Secret> {
    const data = await this.decrypt(id);
    this.remember(data.p);
    return {
      username: data.u,
      password: data.p,
      note: this.repo.legacyNote(id) || (data.n ?? ""),
    };
  }

  /**
   * Moves older plaintext notes into each record's encrypted blob and clears the column.
   * Idempotent and best effort (called at brain start): without secure storage the notes stay
   * readable from the column and are moved by the next run or the next save of that record.
   */
  async migrateNotes(signal: AbortSignal) {
    try {
      const pending = this.repo.legacyNotes();
      if (!pending.length || !(await this.deps.host.secrets.isAvailable())) return;
      for (const { id, note } of pending) {
        signal.throwIfAborted();
        const secret = await this.open(id);
        this.repo.moveNote(id, note, await this.seal({ ...secret, note }));
      }
    } catch {
      this.deps.logger.warn("Saved account notes not migrated; retried at next start");
    }
  }

  /** Notes for a list page; records that cannot be decrypted right now show no note. */
  private async withNotes(records: Credential[]): Promise<Credential[]> {
    if (!records.some((record) => !record.note)) return records;
    if (!(await this.deps.host.secrets.isAvailable())) return records;
    return Promise.all(
      records.map(async (record) => {
        if (record.note) return record;
        try {
          return { ...record, note: (await this.decrypt(record.id)).n ?? "" };
        } catch {
          this.deps.logger.warn(`Saved account note unreadable credentialId=${record.id}`);
          return record;
        }
      }),
    );
  }

  private mainBotId() {
    return new BotsRepo(this.deps.db).getMain()?.id ?? "";
  }

  private audit(
    kind: "credential.saved" | "credential.updated" | "credential.deleted" | "credential.revealed",
    value: Credential,
  ) {
    this.local.approvals.audit.append({
      botId: this.mainBotId(),
      kind,
      summary: `Saved account ${kind.slice("credential.".length)}`,
      detail: {
        actor: "user",
        credentialId: value.id,
        domain: credentialSiteLabel(value.site).slice(0, 200),
        target: value.label,
        botIds: value.botIds,
      },
    });
  }

  private changed() {
    this.deps.peer.emit("credentials.changed", {});
  }

  async status(): Promise<MethodResults["credentials.status"]> {
    return {
      storage: await this.deps.host.secrets.isAvailable(),
      // Only macOS has a system prompt reachable from Electron (Touch ID / login password).
      reveal: this.deps.platform === "darwin" && !!this.deps.host.credentials,
    };
  }

  list(params: MethodParams["credentials.list"]) {
    return this.withNotes(this.repo.list(params));
  }

  async save(params: MethodParams["credentials.save"]): Promise<Credential> {
    const site = credentialSite(params.site);
    if (!site) throw invalid("credential_site_invalid");
    const existing = params.id ? this.repo.get(params.id) : undefined;
    if (params.id && !existing) throw invalid("credential_not_found");
    if (!existing && (!params.username || !params.password))
      throw invalid("credential_secret_required");
    const id = existing?.id ?? randomUUID();
    const expected = existing ? JSON.stringify(existing) : undefined;
    const expectedBlob = existing ? Buffer.from(this.repo.secret(id) ?? []) : undefined;
    let commitTotp: (() => void) | undefined;
    if (typeof params.totp === "string") {
      const config = parseTotp(params.totp);
      this.deps.redactor.addNamed("TOTP", config.secret);
      this.deps.redactor.addNamed("TOTP", params.totp);
      commitTotp = await this.totpStore.prepareSet(TOTP_SCOPE, id, JSON.stringify(config));
    }
    // The note lives in the blob, so changing it (or moving a pre-T17 one) re-seals the record;
    // editing only the name or the Bots does not need secure storage.
    let blob: Uint8Array | undefined;
    let note: string | undefined;
    if (
      !existing ||
      params.username !== undefined ||
      params.password !== undefined ||
      params.note !== undefined ||
      existing.note
    ) {
      const old = existing ? await this.open(existing.id) : undefined;
      note = params.note ?? old?.note ?? "";
      blob = await this.seal({
        username: params.username ?? old?.username ?? "",
        password: params.password ?? old?.password ?? "",
        note,
      });
    }
    const fields = {
      id,
      site,
      label:
        params.label ??
        (params.username !== undefined ? maskAccount(params.username) : existing?.label) ??
        "***",
      // The column only ever held pre-T17 plaintext; every write clears it.
      note: "",
      botIds: params.botIds,
      hasTotp: params.totp === undefined ? (existing?.hasTotp ?? false) : params.totp !== null,
    };
    const value = transaction(this.deps.db, () => {
      // Host encryption yields: never overwrite a simultaneous account reassignment or edit.
      if (
        existing &&
        (JSON.stringify(this.repo.get(id)) !== expected ||
          !expectedBlob?.equals(this.repo.secret(id) ?? new Uint8Array()))
      )
        throw invalid("credential_changed");
      if (params.totp === null) this.totpStore.remove(TOTP_SCOPE, id);
      commitTotp?.();
      return existing
        ? this.repo.update(id, fields, blob, (_before, after) =>
            this.audit("credential.updated", after),
          )
        : this.repo.create(fields, blob as Uint8Array, (created) =>
            this.audit("credential.saved", created),
          );
    });
    if (!value) throw invalid("credential_not_found");
    this.changed();
    if (note !== undefined) return { ...value, note };
    return (await this.withNotes([value]))[0] ?? value;
  }

  delete(id: string) {
    transaction(this.deps.db, () => {
      if (!this.repo.remove(id, (value) => this.audit("credential.deleted", value)))
        throw invalid("credential_not_found");
      this.totpStore.remove(TOTP_SCOPE, id);
    });
    this.changed();
    return { ok: true as const };
  }

  /** Viewing a password needs system authentication; refused where there is none. */
  async reveal(id: string, signal: AbortSignal): Promise<MethodResults["credentials.reveal"]> {
    const record = this.repo.get(id);
    if (!record) throw invalid("credential_not_found");
    const host = this.deps.host.credentials;
    if (this.deps.platform !== "darwin" || !host)
      throw new RpcError(RpcErrorCodes.unsupported, "credential_reveal_unsupported");
    const language = this.language();
    const verdict = await host.call(
      "host.credentials.authenticate",
      {
        reason:
          language === "zh"
            ? `显示 ${credentialSiteLabel(record.site)} 的已存密码`
            : `show the saved password for ${credentialSiteLabel(record.site)}`,
      },
      signal,
    );
    if (!verdict.ok)
      throw invalid(
        verdict.code === "unsupported" ? "credential_reveal_unsupported" : "credential_auth_failed",
      );
    const secret = await this.open(id);
    this.audit("credential.revealed", record);
    // Code units, not a string: brain's outgoing text redaction now knows this password.
    return {
      username: secret.username,
      password: Array.from({ length: secret.password.length }, (_, index) =>
        secret.password.charCodeAt(index),
      ),
    };
  }

  private language() {
    return resolveCredentialLanguage(
      new SettingsRepo(this.deps.db).get().language,
      Intl.DateTimeFormat().resolvedOptions().locale,
    );
  }

  /**
   * The accounts the Bot may use on `pageUrl`. When several saved sites match (example.com and
   * login.example.com), the most specific one wins so one card names one site. `site` (from the
   * model) only narrows the choice; it can never widen it past the page.
   */
  hasSite(botId: string, site: string): boolean {
    return this.repo.forBot(botId).some((entry) => entry.site === site);
  }
  candidates(botId: string, pageUrl: string, site?: string): LoginCandidates | undefined {
    const wanted = site ? credentialSite(site) : undefined;
    if (site && !wanted) return undefined;
    const matches = this.repo.forBot(botId).filter(
      (entry) =>
        credentialSiteMatches(entry.site, pageUrl) &&
        // The model's site only filters, in either direction (parent or subdomain named).
        (!wanted ||
          credentialSiteMatches(entry.site, wanted) ||
          credentialSiteMatches(wanted, entry.site)),
    );
    if (!matches.length) return undefined;
    const specific = (entry: SiteCredentialMatch) => new URL(entry.site).hostname.length;
    const best = Math.max(...matches.map(specific));
    const chosen = matches.filter((entry) => specific(entry) === best);
    const site0 = chosen[0]?.site as string;
    return {
      site: site0,
      accounts: chosen
        .filter((entry) => entry.site === site0)
        .slice(0, 20)
        .map((entry) => ({ id: entry.id, label: entry.label })),
    };
  }

  /** Decrypts one account for a fill, re-checking the Bot's access and the page. */
  async secretFor(
    botId: string,
    credentialId: string,
    pageUrl: string,
    parent = this.local.shutdown.signal,
  ) {
    const signal = AbortSignal.any([
      parent,
      this.local.shutdown.signal,
      AbortSignal.timeout(20_000),
    ]);
    const record = this.repo.get(credentialId);
    if (!record || !this.repo.allowed(credentialId, botId)) throw invalid("credential_not_allowed");
    if (!credentialSiteMatches(record.site, pageUrl)) throw invalid("credential_site_mismatch");
    const encrypted = this.repo.secret(credentialId);
    if (!encrypted) throw invalid("credential_not_allowed");
    const expectedBlob = Buffer.from(encrypted);
    const snapshot = (value: Credential) => JSON.stringify({ ...value, lastUsedAt: null });
    const expected = snapshot(record);
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = this.repo.get(credentialId),
        blob = this.repo.secret(credentialId);
      // Timestamp precision alone cannot prove that a password or its Bot assignment is unchanged.
      if (
        !current ||
        !this.repo.allowed(credentialId, botId) ||
        snapshot(current) !== expected ||
        !blob ||
        !expectedBlob.equals(blob)
      )
        throw invalid("credential_not_allowed");
    };
    assertCurrent();
    const { username, password } = await abortable(this.open(credentialId), signal);
    const storedTotp = record.hasTotp
      ? await abortable(this.totpStore.get(TOTP_SCOPE, credentialId), signal)
      : undefined;
    assertCurrent();
    this.repo.touch(credentialId);
    let code: string | undefined;
    let totpExpiresAt: number | undefined;
    if (record.hasTotp) {
      const parsed = TotpConfigSchema.safeParse(storedTotp ? JSON.parse(storedTotp) : undefined);
      if (!parsed.success) throw invalid("credential_totp_unavailable");
      this.deps.redactor.addNamed("TOTP", parsed.data.secret);
      const now = Date.now();
      code = currentTotp(parsed.data, now);
      totpExpiresAt = (Math.floor(now / 1000 / parsed.data.period) + 1) * parsed.data.period * 1000;
      this.deps.redactor.addNamed("TOTP", code);
    }
    return {
      record,
      username,
      password,
      ...(code ? { totp: code, totpExpiresAt } : {}),
      assertCurrent,
    };
  }

  takeoverAccounts(params: MethodParams["credentials.takeoverAccounts"], signal: AbortSignal) {
    return takeoverAccounts(this.local, this, params, signal);
  }

  fillForTakeover(params: MethodParams["credentials.fillForTakeover"], signal: AbortSignal) {
    return fillForTakeover(this.local, this, params, signal);
  }

  private prune(now = Date.now()) {
    for (const map of [this.choices, this.runLogins])
      for (const [key, value] of map) if (now - value.at > CHOICE_TTL_MS) map.delete(key);
  }

  /** The account already used for this site in this run (one consent per run and site). */
  approvedInRun(runId: string, site: string): string | undefined {
    const value = this.runLogins.get(`${runId}\n${site}`);
    return value && Date.now() - value.at <= CHOICE_TTL_MS ? value.credentialId : undefined;
  }

  approveInRun(runId: string, site: string, credentialId: string) {
    this.prune();
    this.runLogins.set(`${runId}\n${site}`, { credentialId, at: Date.now() });
  }

  finishRun(runId: string) {
    for (const key of this.runLogins.keys())
      if (key.startsWith(`${runId}\n`)) this.runLogins.delete(key);
  }

  /** `credentials.login.resolve`: records the account picked on the card, then resolves it. */
  async resolveLogin(params: MethodParams["credentials.login.resolve"]) {
    this.local.approvals.pauseExpiredChat(params.approvalId);
    const approval = this.local.approvals.repo.get(params.approvalId);
    if (!approval?.login || approval.status !== "pending")
      throw invalid("Approval is no longer pending");
    const key = `${approval.runId}:${approval.toolCallId}`;
    if (params.decision === "allow") {
      const accounts = approval.login.accounts;
      const credentialId =
        params.credentialId ?? (accounts.length === 1 ? accounts[0]?.id : undefined);
      if (!credentialId || !accounts.some((account) => account.id === credentialId))
        throw invalid("credential_choice_required");
      this.prune();
      this.choices.set(key, { credentialId, at: Date.now() });
      const pauses = new ApprovalPausesRepo(this.deps.db);
      if (pauses.get(approval.id)) pauses.choice(approval.id, { credentialId });
    }
    try {
      await this.local.approvals.resolve(
        params.approvalId,
        params.decision,
        params.decision === "allow" && params.remember,
        params.decision === "allow" && params.preauthorize === true,
      );
      // The login card's result has no out-of-date flag; the settled card reads it from history.
      return { ok: true as const };
    } catch (error) {
      this.choices.delete(key);
      throw error;
    }
  }

  /** The account the user picked for this tool call, consumed once. */
  takeChoice(runId: string, toolCallId: string): string | undefined {
    const key = `${runId}:${toolCallId}`;
    const value = this.choices.get(key);
    this.choices.delete(key);
    const paused = new ApprovalPausesRepo(this.deps.db).takeChoice(runId, toolCallId);
    const selected = z.strictObject({ credentialId: z.uuid() }).safeParse(paused);
    if (selected.success) return selected.data.credentialId;
    return value && Date.now() - value.at <= CHOICE_TTL_MS ? value.credentialId : undefined;
  }

  /**
   * After a hand-back: asks the host whether a login form was submitted during the
   * takeover. Only the site and username come back here; the password stays in the host until
   * the user saves (`take`) or dismisses (`discard`).
   */
  async afterHandBack(botId: string) {
    const host = this.deps.host.credentials;
    if (!host) return;
    try {
      const found = await host.call(
        "host.browser.login.capture",
        { botId },
        AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(CAPTURE_HOST_TIMEOUT_MS)]),
      );
      const capture = found ? { botId, ...found } : null;
      if (capture) this.captures.set(botId, capture);
      else this.captures.delete(botId);
      this.deps.peer.emit("credentials.capture", { botId, capture });
    } catch {
      this.deps.logger.warn(`credential capture unavailable botId=${botId}`);
    }
  }

  capture(botId: string) {
    return this.captures.get(botId) ?? null;
  }

  async resolveCapture(
    params: MethodParams["credentials.capture.resolve"],
    signal: AbortSignal,
  ): Promise<MethodResults["credentials.capture.resolve"]> {
    const pending = this.captures.get(params.botId);
    if (!pending || pending.captureId !== params.captureId)
      throw invalid("credential_capture_gone");
    const host = this.deps.host.credentials;
    if (!host) throw new RpcError(RpcErrorCodes.unsupported, "browser_unavailable");
    let credential: Credential | null = null;
    if (params.save) {
      // Refuse before taking the password out of the host, so a retry is still possible.
      await this.requireStorage();
      const taken = await host.call(
        "host.browser.login.take",
        { botId: params.botId, captureId: params.captureId },
        signal,
      );
      const sealed = await this.seal({
        username: taken.username,
        password: taken.password,
        note: "",
      });
      credential = this.repo.create(
        {
          site: taken.site,
          label: params.label ?? (taken.username ? maskAccount(taken.username) : "***"),
          note: "",
          botIds: params.botIds ?? [params.botId],
        },
        sealed,
        (created) => this.audit("credential.saved", created),
      );
      this.changed();
    } else
      await host.call(
        "host.browser.login.discard",
        { botId: params.botId, captureId: params.captureId },
        signal,
      );
    this.captures.delete(params.botId);
    this.deps.peer.emit("credentials.capture", { botId: params.botId, capture: null });
    return { ok: true, credential };
  }

  dispose() {
    this.runLogins.clear();
    this.choices.clear();
    this.captures.clear();
  }
}
