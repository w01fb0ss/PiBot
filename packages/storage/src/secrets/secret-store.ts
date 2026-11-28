import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CredentialTotpSecretSchema, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { assertSafeSecretValue, keyHint, type Redactor, type SecretCipher } from "@pibot/secrets";
import { z } from "zod";

const warmConcurrency = 8;
// Imported connector fields can be empty or whitespace-sensitive. The encrypted envelope
// distinguishes them from legacy values without widening the host's secret input contract.
const connectorValuePrefix = "\0pibot-connector-value:";
const importedConnectorValue = (scope: string, name: string) =>
  scope === "user-secret" && /^IMPORT_[A-F0-9]{32}_/.test(name);
const connectorValueSchema = z.union([
  z.string(),
  z.strictObject({ value: z.string(), configuration: z.boolean() }),
]);

function decodedValue(scope: string, name: string, plain: string) {
  if (importedConnectorValue(scope, name) && plain.startsWith(connectorValuePrefix)) {
    try {
      const saved = connectorValueSchema.parse(
        JSON.parse(plain.slice(connectorValuePrefix.length)),
      );
      // The legacy flag meant a value was eligible for plaintext, even if it was kept private.
      return typeof saved === "string" ? saved : saved.value;
    } catch {
      throw new Error("Saved connector value unavailable");
    }
  }
  assertSafeSecretValue(plain);
  return plain;
}

export class SecretStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
  ) {}

  async set(scope: string, name: string, value: string): Promise<void> {
    const commit = await this.prepareSet(scope, name, value);
    commit();
    this.registerCommittedImport(scope, name, value);
  }

  /** Import callers publish redaction after their enclosing storage transaction has committed. */
  registerCommittedImport(scope: string, name: string, value: string): void {
    if (importedConnectorValue(scope, name)) this.register(scope, name, value);
  }

  /** Encryption may cross host RPC: finish it before entering a synchronous SQLite transaction. */
  async prepareSet(scope: string, name: string, value: string): Promise<() => void> {
    const imported = importedConnectorValue(scope, name);
    const plain = imported ? connectorValuePrefix + JSON.stringify(value) : value;
    assertSafeSecretValue(plain);
    if (!(await this.cipher.isAvailable()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
    const ciphertext = await this.cipher.encrypt(plain);
    // Preparing an install must have no redaction side effects if it rolls back.
    if (!imported) this.register(scope, name, value);
    const hint = imported ? null : (keyHint(value) ?? null);
    return () =>
      this.db
        .prepare(`INSERT INTO secrets (id, scope, name, ciphertext, hint, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(scope, name) DO UPDATE
      SET ciphertext = excluded.ciphertext, hint = excluded.hint, last_used_at = NULL`)
        .run(randomUUID(), scope, name, ciphertext, hint, new Date().toISOString());
  }

  async get(
    scope: string,
    name: string,
    onCredentialRead?: (value: string) => void,
  ): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT ciphertext FROM secrets WHERE scope = ? AND name = ?")
      .get(scope, name);
    if (!row) return undefined;
    if (!(await this.cipher.isAvailable()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
    const value = decodedValue(
      scope,
      name,
      await this.cipher.decrypt(row.ciphertext as Uint8Array),
    );
    // Undecrypted secrets are absent from this process and cannot be emitted by it.
    // Register plaintext before returning it to any caller that could produce diagnostics.
    this.register(scope, name, value);
    onCredentialRead?.(value);
    this.db
      .prepare(`UPDATE secrets SET last_used_at = ?, hint = COALESCE(hint, ?)
        WHERE scope = ? AND name = ? AND ciphertext = ?`)
      .run(
        new Date().toISOString(),
        importedConnectorValue(scope, name) ? null : (keyHint(value) ?? null),
        scope,
        name,
        row.ciphertext as Uint8Array,
      );
    return value;
  }

  private register(scope: string, name: string, value: string) {
    if (importedConnectorValue(scope, name)) {
      // Short imported literals are protected at the MCP output boundary. Making them
      // shared substring matches can corrupt unrelated structured fields such as audit IDs.
      value = value.trim().replace(/^[!\s]+/, "");
      if (value.length < 8 || /[\0\r\n]/.test(value)) return;
    }
    const named = this.redactor as Redactor & { addNamed?(name: string, value: string): void };
    if (scope === "user-secret" && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && named.addNamed)
      named.addNamed(name, value);
    else {
      this.redactor.add(value);
      if (scope === "credential-totp" && named.addNamed) {
        // Warm raw Base32 too: tools may encounter it without the enclosing encrypted JSON.
        let decoded: unknown;
        try {
          decoded = JSON.parse(value);
        } catch {
          throw new Error("Saved account authenticator unavailable");
        }
        const parsed = CredentialTotpSecretSchema.safeParse(decoded);
        if (!parsed.success) throw new Error("Saved account authenticator unavailable");
        named.addNamed("TOTP", parsed.data.secret);
      }
    }
  }

  /** Seed output/write-out protection before tools can read files, even if a secret was never used. */
  async warm(signal: AbortSignal): Promise<void> {
    let after = "";
    for (;;) {
      signal.throwIfAborted();
      const rows = this.db
        .prepare("SELECT id,scope,name,ciphertext FROM secrets WHERE id > ? ORDER BY id LIMIT 100")
        .all(after);
      if (!rows.length) return;
      if (!(await this.cipher.isAvailable()))
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      // On desktop every decrypt is a host RPC round trip. One at a time, startup
      // paid the round-trip latency once per stored secret; a few in flight hide it while the
      // host still decrypts serially. Registration order does not matter to the redactor.
      let next = 0;
      const worker = async () => {
        while (next < rows.length) {
          const row = rows[next++] as (typeof rows)[number];
          signal.throwIfAborted();
          const scope = String(row.scope);
          const name = String(row.name);
          const value = decodedValue(
            scope,
            name,
            await this.cipher.decrypt(row.ciphertext as Uint8Array),
          );
          this.register(scope, name, value);
        }
      };
      // A failed worker must not release the owner while sibling host decrypts still run.
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(warmConcurrency, rows.length) }, worker),
      );
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      after = String(rows.at(-1)?.id);
    }
  }

  has(scope: string, name: string): boolean {
    return (
      this.db.prepare("SELECT id FROM secrets WHERE scope = ? AND name = ?").get(scope, name) !==
      undefined
    );
  }

  remove(scope: string, name: string): boolean {
    return (
      this.db.prepare("DELETE FROM secrets WHERE scope = ? AND name = ?").run(scope, name).changes >
      0
    );
  }

  /** Installation cleanup uses an exact generated prefix; an empty prefix must never widen it. */
  removePrefix(scope: string, prefix: string): number {
    if (!prefix) throw new TypeError("Secret prefix must not be empty");
    return Number(
      this.db
        .prepare("DELETE FROM secrets WHERE scope = ? AND substr(name, 1, ?) = ?")
        .run(scope, prefix.length, prefix).changes,
    );
  }

  hint(scope: string, name: string): string | undefined {
    const row = this.db
      .prepare("SELECT hint FROM secrets WHERE scope = ? AND name = ?")
      .get(scope, name);
    return row?.hint == null ? undefined : String(row.hint);
  }
}
