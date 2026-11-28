import {
  folderEntries,
  PackageError,
  type PackageFile,
  readScannedFile,
  renderSkillFile,
  scriptLike,
  textOf,
} from "@pibot/brain/kit";
import {
  RpcError,
  type SkillDocument,
  SkillImportSourceSchema,
  TEAM_ARCHIVE_MAX_BYTES,
  TEAM_ARCHIVE_MAX_FILES,
  type TeamSkillReimport,
} from "@pibot/skills-contract/full";
import type { SkillRecord } from "../../store/index.ts";
import { digestFolder } from "./shared-packages.ts";
export interface ExportedSkillPackage {
  folder: string;
  enabled: boolean;
  document: SkillDocument;
  files: PackageFile[];
  reimport?: TeamSkillReimport["reimport"];
}
interface ExportContext {
  records: readonly SkillRecord[];
  document(record: SkillRecord): Promise<SkillDocument>;
  folder(record: SkillRecord): string;
  digest(id: string): string | undefined;
  warn(): void;
}
/** Large imported skills travel as explicit, disabled source notices, never truncated executable packages. */
export async function exportSkillPackages(
  ctx: ExportContext,
  signal: AbortSignal,
  budget = { bytes: TEAM_ARCHIVE_MAX_BYTES, files: TEAM_ARCHIVE_MAX_FILES },
): Promise<ExportedSkillPackage[]> {
  const skills: ExportedSkillPackage[] = [];
  let bytes = 0,
    count = 0;
  for (const record of ctx.records) {
    try {
      signal.throwIfAborted();
      const document = await ctx.document(record);
      const entries = (await folderEntries(ctx.folder(record), signal)).files.filter(
        (entry) => entry.path !== "SKILL.md" && !entry.path.startsWith(".SKILL.md."),
      );
      const skillBytes =
        Buffer.byteLength(renderSkillFile(record.path.slice("skills/".length), document)) +
        entries.reduce((sum, entry) => sum + entry.bytes, 0);
      if (skillBytes > TEAM_ARCHIVE_MAX_BYTES || entries.length + 1 >= TEAM_ARCHIVE_MAX_FILES) {
        if (record.source !== "imported") throw new PackageError("too_large");
        const contentHash =
          (record.packageId && ctx.digest(record.packageId)) ||
          (
            await digestFolder(ctx.folder(record), signal, () => {}, {
              ignoreJunk: !record.packageId,
            })
          ).digest;
        const origin = document.linkOrigin;
        const pinned =
          origin?.owner && origin.repo && origin.commit
            ? `https://codeload.github.com/${origin.owner}/${origin.repo}/zip/${origin.commit}`
            : undefined;
        const locator =
          origin &&
          SkillImportSourceSchema.safeParse({
            host: pinned ? "codeload.github.com" : origin.host,
            url: pinned ?? origin.url,
            subpath: origin.subpath,
          });
        const source =
          record.importSource ?? (locator && locator.success ? locator.data : undefined);
        skills.push({
          folder: record.path.slice("skills/".length),
          enabled: false,
          document: { name: record.name, description: record.description, body: "", params: [] },
          files: [],
          reimport: {
            contentHash,
            ...(source ? { source } : {}),
            reason: source ? "source_required" : "local_too_large",
          },
        });
        continue;
      }
      // Several small packages exceeding the archive budget still fail together, as before;
      // never silently turn a small skill into a missing-content notice because it came last.
      if (bytes + skillBytes > budget.bytes || count + entries.length + 1 > budget.files)
        throw new PackageError("too_large");
      const files: PackageFile[] = [];
      for (const entry of entries) {
        const data = await readScannedFile(entry, signal, budget.bytes);
        files.push({
          path: entry.path,
          data,
          text: textOf(data) !== undefined,
          script: scriptLike(entry.path, data),
        });
      }
      bytes += skillBytes;
      count += entries.length + 1;
      skills.push({
        document,
        enabled: record.enabled,
        folder: record.path.slice("skills/".length),
        files,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof PackageError &&
        (error.message === "too_large" || error.message === "too_many_files")
      )
        throw new RpcError(-32602, "team_too_large");
      if (record.packageId) throw new RpcError(-32603, "skill_file_unavailable");
      ctx.warn();
    }
  }
  return skills;
}
