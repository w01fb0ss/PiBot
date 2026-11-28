import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawEntry } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import {
  ROLE_CATALOG_PUBLIC_KEYS,
  type RoleCatalog,
  type RoleCatalogEntry,
  type RoleCatalogItem,
  RoleCatalogSchema,
  type RoleCatalogState,
} from "@pibot/teams-contract";
import { z } from "zod";
import { zipEntries } from "../teams/team-archive.ts";

/**
 * The signed role library, on its own host so publishing roles never redeploys the site.
 * Only the app's own request; no cookie or user identifier.
 */
export const ROLE_CATALOG_URL = "https://roles.pibot.space/v1/";
const CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const SIGNATURE_MAX_BYTES = 1024;
const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const KINDS = { role: "roles", group: "groups" } as const;

type Kind = "role" | "group";
type Failure = NonNullable<RoleCatalogState["error"]>;
const StateFileSchema = z.strictObject({
  checkedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});

class CatalogFailure extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}

/** "0.0.10" > "0.0.9": numeric parts, missing parts are 0; anything unparsable counts as newest. */
function older(version: string, than: string) {
  const parts = (value: string) => value.split(/[.+-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(version), parts(than)];
  if ([...a, ...b].some((n) => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

async function bounded(response: Response, max: number) {
  if (!response.body) throw new CatalogFailure("server");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new CatalogFailure("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function atomicWrite(path: string, data: Buffer | string) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

/**
 * Downloads, verifies and caches the catalog and the archives the user installs. A catalog is
 * trusted only with a signature from a release key compiled into this build; an archive only when
 * its size and SHA-256 match that catalog and it reads like any built-in pack.
 */
export class RoleCatalogService {
  private readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private verified?: RoleCatalog | null;
  constructor(
    private readonly deps: {
      dataDir: string;
      appVersion: string;
      fetch: typeof fetch;
      /** Throws when the files are not a valid pack of that kind and id. */
      validate(entries: RawEntry[], kind: Kind, id: string): void;
      /** What this installer ships, for "bundled" next to each entry. */
      bundled(): Promise<Map<string, number>>;
      audit(reasonCode: "catalog_checked" | "catalog_installed", target?: string): void;
      baseUrl?: string;
      publicKeys?: readonly string[];
      signal: AbortSignal;
    },
  ) {
    this.dir = join(deps.dataDir, "role-catalog");
  }
  private get keys() {
    return this.deps.publicKeys ?? ROLE_CATALOG_PUBLIC_KEYS;
  }
  private get base() {
    return this.deps.baseUrl ?? ROLE_CATALOG_URL;
  }
  /** One check or install at a time; a second caller waits for the first. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private trusts(data: Buffer, signature: Buffer) {
    return this.keys.some((key) => {
      try {
        return verify(null, data, createPublicKey(key), signature);
      } catch {
        // A malformed key in the list cannot vouch for anything; the others may still.
        return false;
      }
    });
  }
  private async download(path: string, max: number, parent?: AbortSignal) {
    const signal = AbortSignal.any([
      this.deps.signal,
      AbortSignal.timeout(TIMEOUT_MS),
      ...(parent ? [parent] : []),
    ]);
    let response: Response;
    try {
      response = await this.deps.fetch(new URL(path, this.base), {
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      this.deps.signal.throwIfAborted();
      parent?.throwIfAborted();
      throw new CatalogFailure("offline");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogFailure("server");
    }
    return bounded(response, max);
  }
  /** The cached catalog, re-verified on first use so a file edited on disk is not believed. */
  private async cached(): Promise<RoleCatalog | null> {
    if (this.verified !== undefined) return this.verified;
    try {
      const [data, signature] = await Promise.all([
        readFile(join(this.dir, "catalog.json")),
        readFile(join(this.dir, "catalog.json.sig")),
      ]);
      this.verified = this.trusts(data, signature)
        ? RoleCatalogSchema.parse(JSON.parse(data.toString("utf8")))
        : null;
    } catch {
      // Never checked, or a damaged cache: the next check replaces it.
      this.verified = null;
    }
    return this.verified;
  }
  private async stateFile() {
    try {
      return StateFileSchema.parse(
        JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")),
      );
    } catch {
      return { checkedAt: null, error: null };
    }
  }
  private async installedVersions() {
    const versions = new Map<string, number>();
    for (const kind of ["role", "group"] as const)
      for (const name of await this.archives(kind)) {
        const match = /^([a-z0-9][a-z0-9-]*)\.v([1-9][0-9]*)\.pibot$/.exec(name);
        if (match) {
          const key = `${kind}:${match[1]}`;
          versions.set(key, Math.max(versions.get(key) ?? 0, Number(match[2])));
        }
      }
    return versions;
  }
  private async archives(kind: Kind) {
    try {
      return (await readdir(join(this.dir, "installed", KINDS[kind]))).filter((name) =>
        name.endsWith(".pibot"),
      );
    } catch {
      return [];
    }
  }
  async state(): Promise<RoleCatalogState> {
    const [catalog, file, installed, bundled] = await Promise.all([
      this.cached(),
      this.stateFile(),
      this.installedVersions(),
      this.deps.bundled(),
    ]);
    const error = (
      ["offline", "server", "signature", "format", "too_large", "app_too_old"] as const
    ).find((code) => code === file.error);
    const entries = (items: RoleCatalogItem[], kind: Kind): RoleCatalogEntry[] =>
      items.map((item) => ({
        kind,
        id: item.id,
        version: item.version,
        name: item.name,
        description: item.description,
        title: item.title,
        summary: item.summary,
        avatar: item.avatar,
        defaultBotName: item.defaultBotName,
        members: item.members,
        category: item.category,
        bytes: item.bytes,
        bundled: bundled.get(`${kind}:${item.id}`) ?? null,
        installed: installed.get(`${kind}:${item.id}`) ?? null,
        needsUpdate: !!item.minApp && older(this.deps.appVersion, item.minApp),
      }));
    return {
      status: !this.keys.length ? "untrusted" : error ? "unavailable" : catalog ? "ready" : "never",
      checkedAt: file.checkedAt,
      error: error ?? null,
      entries: catalog
        ? [...entries(catalog.roles, "role"), ...entries(catalog.groups, "group")]
        : [],
    };
  }
  check(): Promise<RoleCatalogState> {
    return this.serial(async () => {
      // Without a release key nothing could be verified, so nothing is downloaded either.
      if (!this.keys.length) return this.state();
      await mkdir(this.dir, { recursive: true });
      let error: Failure | null = null;
      try {
        let data: Buffer;
        let signature: Buffer;
        try {
          [data, signature] = await Promise.all([
            this.download("catalog.v2.json", CATALOG_MAX_BYTES),
            this.download("catalog.v2.json.sig", SIGNATURE_MAX_BYTES),
          ]);
        } catch {
          [data, signature] = await Promise.all([
            this.download("catalog.json", CATALOG_MAX_BYTES),
            this.download("catalog.json.sig", SIGNATURE_MAX_BYTES),
          ]);
        }
        if (!this.trusts(data, signature)) throw new CatalogFailure("signature");
        const parsed = RoleCatalogSchema.safeParse(
          (() => {
            try {
              return JSON.parse(data.toString("utf8"));
            } catch {
              return undefined;
            }
          })(),
        );
        if (!parsed.success) throw new CatalogFailure("format");
        if (older(this.deps.appVersion, parsed.data.minApp))
          throw new CatalogFailure("app_too_old");
        await atomicWrite(join(this.dir, "catalog.json"), data);
        await atomicWrite(join(this.dir, "catalog.json.sig"), signature);
        this.verified = parsed.data;
      } catch (caught) {
        if (!(caught instanceof CatalogFailure)) throw caught;
        // The previous verified catalog stays usable; the state says why the refresh failed.
        error = caught.code;
      }
      await atomicWrite(
        join(this.dir, "state.json"),
        JSON.stringify({ checkedAt: new Date().toISOString(), error }),
      );
      this.deps.audit("catalog_checked", error ?? "ok");
      return this.state();
    });
  }
  install(
    kind: Kind,
    id: string,
    routing?: {
      version: number;
      signal: AbortSignal;
      guard(): void;
      availableRoles: ReadonlySet<string>;
    },
  ): Promise<number> {
    return this.serial(async () => {
      routing?.guard();
      const catalog = await this.cached();
      if (!catalog) throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_unavailable");
      const target = catalog[KINDS[kind]].find((entry) => entry.id === id);
      if (!target) throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_unknown");
      if (target.minApp && older(this.deps.appVersion, target.minApp))
        throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_app_too_old");
      const installed = await this.installedVersions();
      const installedVersion = installed.get(`${kind}:${id}`) ?? 0;
      if (routing && (routing.version !== target.version || installedVersion > target.version))
        throw new RpcError(RpcErrorCodes.invalidParams, "builtin_routing_changed");
      if ((routing || kind === "role") && installedVersion >= target.version) return target.version;
      const items: { kind: Kind; item: RoleCatalogItem }[] = [];
      const add = (itemKind: Kind, item: RoleCatalogItem) => {
        if (!items.some((entry) => entry.kind === itemKind && entry.item.id === item.id))
          items.push({ kind: itemKind, item });
      };
      add(kind, target);
      if (kind === "group") {
        for (const member of target.members ?? []) {
          // A routing install provisions a new recipient. Any existing local roles keep their version.
          if (routing?.availableRoles.has(member)) continue;
          const role = catalog.roles.find((entry) => entry.id === member);
          if (!role) throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_unknown");
          if (role.minApp && older(this.deps.appVersion, role.minApp))
            throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_app_too_old");
          if ((installed.get(`role:${member}`) ?? 0) < role.version) add("role", role);
        }
      }
      const downloaded: { kind: Kind; item: RoleCatalogItem; data: Buffer }[] = [];
      for (const entry of items) {
        let data: Buffer;
        try {
          data = await this.download(
            entry.item.archive,
            Math.min(entry.item.bytes, ARCHIVE_MAX_BYTES),
            routing?.signal,
          );
        } catch (caught) {
          if (caught instanceof CatalogFailure)
            throw new RpcError(RpcErrorCodes.invalidParams, `role_catalog_${caught.code}`);
          throw caught;
        }
        if (
          data.length !== entry.item.bytes ||
          createHash("sha256").update(data).digest("hex") !== entry.item.sha256
        )
          throw new RpcError(RpcErrorCodes.invalidParams, "role_catalog_archive_mismatch");
        this.deps.validate(zipEntries(data), entry.kind, entry.item.id);
        downloaded.push({ ...entry, data });
      }
      routing?.guard();
      this.deps.signal.throwIfAborted();
      for (const entry of downloaded) {
        const destination = join(
          this.dir,
          "installed",
          KINDS[entry.kind],
          `${entry.item.id}.v${entry.item.version}.pibot`,
        );
        await mkdir(join(this.dir, "installed", KINDS[entry.kind]), { recursive: true });
        await atomicWrite(destination, entry.data);
        for (const name of await this.archives(entry.kind))
          if (
            name.startsWith(`${entry.item.id}.v`) &&
            name !== `${entry.item.id}.v${entry.item.version}.pibot`
          )
            await rm(join(this.dir, "installed", KINDS[entry.kind], name), { force: true });
      }
      this.deps.audit("catalog_installed", `${kind}:${id}@${target.version}`);
      return target.version;
    });
  }
  /** Checks an imported archive against the currently cached, signature-verified catalog. */
  async verifyArchive(data: Buffer): Promise<boolean> {
    const catalog = await this.cached();
    if (!catalog) return false;
    const digest = createHash("sha256").update(data).digest("hex");
    return [...catalog.roles, ...catalog.groups].some(
      (item) => item.bytes === data.length && item.sha256 === digest,
    );
  }

  /** Installed archives for the built-in loader, newest file per id. */
  async packs() {
    const packs: { kind: Kind; id: string; entries: RawEntry[] }[] = [];
    for (const kind of ["role", "group"] as const) {
      const best = new Map<string, { version: number; name: string }>();
      for (const name of await this.archives(kind)) {
        const match = /^([a-z0-9][a-z0-9-]*)\.v([1-9][0-9]*)\.pibot$/.exec(name);
        if (!match) continue;
        const [, id = "", version] = match;
        if ((best.get(id)?.version ?? 0) < Number(version))
          best.set(id, { version: Number(version), name });
      }
      for (const [id, { name }] of best)
        packs.push({
          kind,
          id,
          entries: withoutAlwaysCommands(
            zipEntries(await readFile(join(this.dir, "installed", KINDS[kind], name))),
          ),
        });
    }
    return packs;
  }
  async history() {
    return (await this.cached())?.history;
  }
}

/**
 * A downloaded pack is trusted like a user's import: the shipped roles' "run commands without
 * asking" exception does not travel with it, so every later read (create, update) sees the tighter
 * setting.
 */
export function withoutAlwaysCommands(entries: RawEntry[]): RawEntry[] {
  return entries.map((entry) => {
    if (entry.path !== "team.json") return entry;
    let team: { bots?: { permissionOverrides?: Record<string, unknown> }[] };
    try {
      team = JSON.parse(entry.data.toString("utf8"));
    } catch {
      // Unreadable: the loader rejects this pack with its own issue line.
      return entry;
    }
    for (const bot of team.bots ?? [])
      if (bot.permissionOverrides?.run_command === "always")
        delete bot.permissionOverrides.run_command;
    return { path: entry.path, data: Buffer.from(JSON.stringify(team)) };
  });
}
