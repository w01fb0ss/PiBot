import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
// Narrow subpath: the desktop brain bundles @pibot/execution's root entry and must not pull in the
// native OS credential bridge, which only the headless runner ships.
import {
  createSystemCredentialStore,
  SystemCredentialError,
  type SystemCredentialStore,
} from "@pibot/execution/credentials";
import { base64url, destroyEndpoint, type EndpointKeys, endpointKeys, unbase64 } from "@pibot/link";
import { RunnerIdSchema } from "@pibot/protocol-base";

const SERVICE = "com.pibot.runner";
const LEGACY_ACCOUNT = "device-seed-v1";
const AAD = Buffer.from("pibot-runner-identity-v1", "utf8");
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const METADATA_MAX_BYTES = 4096;
const ENVELOPE_MAX_BYTES = 8192;

type Backend = "system" | "file";
type CredentialReference = { service: string; account: string };
type Metadata = {
  version: 1 | 2;
  backend: Backend;
  deviceId: string;
  publicKey: string;
  credential?: CredentialReference;
};
type Envelope = {
  version: 1;
  kdf: { name: "scrypt"; salt: string; n: number; r: number; p: number };
  cipher: { name: "aes-256-gcm"; nonce: string; tag: string };
  ciphertext: string;
};

export type RunnerIdentityFailure =
  | "identity_corrupt"
  | "passphrase_required"
  | "passphrase_invalid"
  | "system_credentials_failed";

export class RunnerIdentityError extends Error {
  constructor(readonly failure: RunnerIdentityFailure) {
    super(failure);
    this.name = "RunnerIdentityError";
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function parseMetadata(value: unknown): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RunnerIdentityError("identity_corrupt");
  const record = value as Record<string, unknown>;
  const hasReference = record.version === 2 && record.backend === "system";
  if (
    !exactObject(value, [
      "version",
      "backend",
      "deviceId",
      "publicKey",
      ...(hasReference ? ["credential"] : []),
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    (value.backend !== "system" && value.backend !== "file") ||
    typeof value.deviceId !== "string" ||
    typeof value.publicKey !== "string"
  )
    throw new RunnerIdentityError("identity_corrupt");
  if (
    hasReference &&
    (!exactObject(value.credential, ["service", "account"]) ||
      value.credential.service !== SERVICE ||
      typeof value.credential.account !== "string" ||
      !/^device-seed-v1-[0-9a-f]{16}$/.test(value.credential.account))
  )
    throw new RunnerIdentityError("identity_corrupt");
  RunnerIdSchema.parse(value.deviceId);
  unbase64(value.publicKey, 32);
  return value as Metadata;
}

function parseEnvelope(value: unknown): Envelope {
  if (
    !exactObject(value, ["version", "kdf", "cipher", "ciphertext"]) ||
    value.version !== 1 ||
    typeof value.ciphertext !== "string" ||
    !exactObject(value.kdf, ["name", "salt", "n", "r", "p"]) ||
    value.kdf.name !== "scrypt" ||
    typeof value.kdf.salt !== "string" ||
    value.kdf.n !== SCRYPT_N ||
    value.kdf.r !== SCRYPT_R ||
    value.kdf.p !== SCRYPT_P ||
    !exactObject(value.cipher, ["name", "nonce", "tag"]) ||
    value.cipher.name !== "aes-256-gcm" ||
    typeof value.cipher.nonce !== "string" ||
    typeof value.cipher.tag !== "string"
  )
    throw new RunnerIdentityError("identity_corrupt");
  return value as Envelope;
}

function decode(value: string, bytes?: number): Buffer {
  const result = Buffer.from(value, "base64url");
  if (base64url(result) !== value || (bytes !== undefined && result.length !== bytes))
    throw new RunnerIdentityError("identity_corrupt");
  return result;
}

function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      salt,
      32,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

async function readPrivate(path: string, maximum: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > maximum ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())))
    )
      throw new RunnerIdentityError("identity_corrupt");
    const body = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset <= maximum) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maximum) throw new RunnerIdentityError("identity_corrupt");
    return body.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function replace(path: string, value: string, privateFile: boolean): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.next`;
  try {
    const handle = await open(temporary, "wx", privateFile ? 0o600 : 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function encryptSeed(path: string, seed: Uint8Array, passphrase: string): Promise<void> {
  if (!passphrase) throw new RunnerIdentityError("passphrase_required");
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await derive(passphrase, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      kdf: { name: "scrypt", salt: base64url(salt), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      cipher: { name: "aes-256-gcm", nonce: base64url(nonce), tag: base64url(cipher.getAuthTag()) },
      ciphertext: base64url(ciphertext),
    };
    await replace(path, `${JSON.stringify(envelope)}\n`, true);
  } finally {
    key.fill(0);
  }
}

async function decryptSeed(path: string, passphrase: string): Promise<Buffer> {
  if (!passphrase) throw new RunnerIdentityError("passphrase_required");
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(JSON.parse(await readPrivate(path, ENVELOPE_MAX_BYTES)));
  } catch (error) {
    if (error instanceof RunnerIdentityError) throw error;
    throw new RunnerIdentityError("identity_corrupt");
  }
  const salt = decode(envelope.kdf.salt, 16);
  const nonce = decode(envelope.cipher.nonce, 12);
  const tag = decode(envelope.cipher.tag, 16);
  const ciphertext = decode(envelope.ciphertext, 32);
  const key = await derive(passphrase, salt);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const seed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (seed.length !== 32) throw new RunnerIdentityError("identity_corrupt");
    return seed;
  } catch (error) {
    if (error instanceof RunnerIdentityError) throw error;
    throw new RunnerIdentityError("passphrase_invalid");
  } finally {
    key.fill(0);
  }
}

function material(seed: Uint8Array) {
  // Buffer.slice aliases its source; endpoint cleanup must not erase a seed being migrated.
  const keys = endpointKeys(new Uint8Array(seed));
  const publicKey = base64url(keys.signingPublic);
  const deviceId = RunnerIdSchema.parse(
    createHash("sha256").update(keys.signingPublic).digest("hex"),
  );
  return { keys, publicKey, deviceId };
}

function verify(seed: Uint8Array, metadata: Metadata) {
  const identity = material(seed);
  if (identity.deviceId !== metadata.deviceId || identity.publicKey !== metadata.publicKey) {
    destroyEndpoint(identity.keys);
    throw new RunnerIdentityError("identity_corrupt");
  }
  return identity;
}

async function metadataAt(path: string): Promise<Metadata | undefined> {
  try {
    return parseMetadata(JSON.parse(await readPrivate(path, METADATA_MAX_BYTES)));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof RunnerIdentityError) throw error;
    throw new RunnerIdentityError("identity_corrupt");
  }
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export interface RunnerIdentity {
  backend: Backend;
  deviceId: string;
  publicKey: string;
  keys: EndpointKeys;
  dispose(): void;
}

export interface RunnerIdentityOptions {
  /** Private identity subdirectory directly under the runner data root. */
  directory: string;
  passphrase(creating: boolean): Promise<string>;
  /**
   * A headless start that supplied PIBOT_RUNNER_PASSPHRASE chose the encrypted file for a NEW
   * identity. Without this a server whose Secret Service exists but cannot be used unattended
   * (locked collection) never started (round-1 Linux, 2026-11-12). The backend is then recorded,
   * so an existing identity never moves.
   */
  preferFile?: boolean;
  signal: AbortSignal;
  systemStore?: SystemCredentialStore;
}

async function commitSystemSeed(
  system: SystemCredentialStore,
  account: string,
  seed: Uint8Array,
  signal: AbortSignal,
) {
  // Once set begins, a failure is never eligible for a file-backend fallback.
  await system.set(account, base64url(seed), signal);
  const confirmed = await system.get(account, signal);
  if (confirmed !== base64url(seed)) throw new RunnerIdentityError("system_credentials_failed");
}

/** Opens exactly one stable identity and records its backend so transient outages cannot rotate it. */
export async function openRunnerIdentity(options: RunnerIdentityOptions): Promise<RunnerIdentity> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const metadataPath = join(options.directory, "identity.json");
  const encryptedPath = join(options.directory, "identity.enc.json");
  const metadata = await metadataAt(metadataPath);
  const credential = metadata?.credential ?? {
    service: SERVICE,
    account: `${LEGACY_ACCOUNT}-${createHash("sha256")
      .update(await realpath(dirname(options.directory)))
      .digest("hex")
      .slice(0, 16)}`,
  };
  const system = options.systemStore ?? createSystemCredentialStore(credential.service);
  let seed: Buffer | undefined;
  let backend: Backend | undefined;

  if (metadata?.backend === "system") {
    try {
      const stored = await system.get(
        metadata.version === 1 ? LEGACY_ACCOUNT : credential.account,
        options.signal,
      );
      if (stored === null) throw new RunnerIdentityError("identity_corrupt");
      seed = decode(stored, 32);
      if (metadata.version === 1) {
        // A directory without matching public metadata may never claim the legacy global seed.
        const checked = verify(seed, metadata);
        destroyEndpoint(checked.keys);
        const scoped = await system.get(credential.account, options.signal);
        if (scoped !== null && scoped !== base64url(seed))
          throw new RunnerIdentityError("identity_corrupt");
        if (scoped === null)
          await commitSystemSeed(system, credential.account, seed, options.signal);
      }
    } catch (error) {
      seed?.fill(0);
      if (error instanceof RunnerIdentityError) throw error;
      throw new RunnerIdentityError("system_credentials_failed");
    }
    backend = "system";
  } else if (metadata?.backend === "file") {
    seed = await decryptSeed(encryptedPath, await options.passphrase(false));
    backend = "file";
  } else if (await exists(encryptedPath)) {
    // Encryption is committed before metadata. Recover that exact seed after a crash instead of
    // creating a different system identity when a keychain appears between launches.
    seed = await decryptSeed(encryptedPath, await options.passphrase(false));
    backend = "file";
  } else if (options.preferFile) {
    const candidate = randomBytes(32);
    try {
      await encryptSeed(encryptedPath, candidate, await options.passphrase(true));
      seed = candidate;
    } catch (error) {
      candidate.fill(0);
      throw error;
    }
    backend = "file";
  } else {
    let stored: string | null | undefined;
    try {
      stored = await system.get(credential.account, options.signal);
    } catch (error) {
      if (
        !(error instanceof SystemCredentialError) ||
        (error.failure !== "unavailable" && error.failure !== "unsupported")
      )
        throw error instanceof RunnerIdentityError
          ? error
          : new RunnerIdentityError("system_credentials_failed");
      const candidate = randomBytes(32);
      try {
        await encryptSeed(encryptedPath, candidate, await options.passphrase(true));
        seed = candidate;
      } catch (fileError) {
        candidate.fill(0);
        throw fileError;
      }
      backend = "file";
    }
    if (stored !== undefined) {
      if (stored !== null) seed = decode(stored, 32);
      else {
        const candidate = randomBytes(32);
        try {
          // Starting a system-store mutation is the backend commitment point. A failed read-back
          // must never fall through to a second file identity while the first seed may be stored.
          await commitSystemSeed(system, credential.account, candidate, options.signal);
          seed = Buffer.from(candidate);
        } catch (error) {
          throw error instanceof RunnerIdentityError
            ? error
            : new RunnerIdentityError("system_credentials_failed");
        } finally {
          candidate.fill(0);
        }
      }
      backend = "system";
    }
  }

  if (!seed || !backend) throw new RunnerIdentityError("identity_corrupt");
  const selectedSeed = seed;
  const selectedBackend = backend;
  let identity: ReturnType<typeof material> | undefined;
  try {
    identity = metadata ? verify(selectedSeed, metadata) : material(selectedSeed);
    if (!metadata || metadata.version === 1) {
      const next: Metadata = {
        version: 2,
        backend: selectedBackend,
        deviceId: identity.deviceId,
        publicKey: identity.publicKey,
        ...(selectedBackend === "system" ? { credential } : {}),
      };
      await replace(metadataPath, `${JSON.stringify(next)}\n`, false);
    }
    const finalIdentity = identity;
    return {
      backend: selectedBackend,
      ...finalIdentity,
      dispose() {
        destroyEndpoint(finalIdentity.keys);
      },
    };
  } catch (error) {
    if (identity) destroyEndpoint(identity.keys);
    throw error;
  } finally {
    selectedSeed.fill(0);
  }
}
