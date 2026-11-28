import type { TranslationKey } from "@pibot/i18n";
import { useAction, useRpc } from "@pibot/renderer-kit";
import {
  RpcError,
  RpcErrorCodes,
  SKILL_DROP_MAX_BYTES,
  SKILL_DROP_MAX_FILES,
  type SkillFileChange,
  SkillPackageWritePathSchema,
} from "@pibot/skills-contract/full";
import { useCallback, useRef, useState } from "react";
import { skillError } from "./presentation.ts";

/** A supporting file as the editor holds it until the whole package is saved. */
export interface EditorFile {
  path: string;
  bytes: number;
  script: boolean;
  /** Editable here; binary files are only listed (and can be removed). */
  text: boolean;
  /** Where the unchanged bytes are: the saved skill, an upload kept in brain, or nowhere yet. */
  source: { kind: "saved" } | { kind: "upload"; uploadId: string; from: string } | { kind: "new" };
  /** Text typed in the editor; undefined = unchanged from `source`. */
  edited?: string;
}
export type SavedFile = { path: string; bytes: number; script: boolean; text?: boolean };
/** Which skill (or nothing yet) the saved files belong to, for reading them on demand. */
export interface FileScope {
  /** Absent on the connections page while there is no Bot to save for yet. */
  botId?: string;
  groupId?: string;
  skillId?: string;
}

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const key = (path: string) => path.toLowerCase();
// Case-insensitive like the brain's check: Windows and macOS folders would merge these names.
function clash(files: readonly EditorFile[], path: string) {
  const lower = key(path);
  return files.some((file) => {
    const other = key(file.path);
    return other === lower || other.startsWith(`${lower}/`) || lower.startsWith(`${other}/`);
  });
}

/** Path problems for 「新建文件」, before anything is sent; brain checks the same rules again. */
export function newPathIssue(
  files: readonly EditorFile[],
  raw: string,
): TranslationKey | undefined {
  const path = raw.normalize("NFC");
  if (!SkillPackageWritePathSchema.safeParse(path).success) return "skills.editor.pathInvalid";
  if (clash(files, path)) return "skills.editor.pathExists";
  return undefined;
}

/**
 * K2: the files of a skill package being edited. Saved and uploaded text is read only when a
 * file is opened; on save the edit becomes one change list (`skills.create` / `skills.update`).
 */
export function useSkillFiles(scope: FileScope, saved: readonly SavedFile[] = []) {
  const { peer, registerSkillDrop } = useRpc();
  const upload = useAction();
  const [files, setFiles] = useState<EditorFile[]>(() =>
    saved.map((file) => ({ ...file, text: file.text ?? false, source: { kind: "saved" } })),
  );
  const savedPaths = useRef(saved.map((file) => file.path));
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadError, setLoadError] = useState<{ path: string; key: TranslationKey }>();
  const loading = useRef(new Set<string>());

  const load = useCallback(
    async (file: EditorFile) => {
      if (!peer || !file.text || file.edited !== undefined || file.source.kind === "new") return;
      const id = `${file.source.kind === "upload" ? file.source.uploadId : "saved"}:${file.path}`;
      if (loaded.has(id) || loading.current.has(id)) return;
      loading.current.add(id);
      setLoadError(undefined);
      try {
        const result =
          file.source.kind === "upload"
            ? await peer.call("skills.readFile", {
                groupId: scope.groupId,
                uploadId: file.source.uploadId,
                path: file.source.from,
              })
            : scope.skillId
              ? await peer.call("skills.readFile", {
                  groupId: scope.groupId,
                  skillId: scope.skillId,
                  path: file.path,
                })
              : undefined;
        if (!result) return;
        if (result.text === null)
          // The list judged it from its first bytes; the whole file says binary.
          setFiles((old) => old.map((f) => (f === file ? { ...f, text: false } : f)));
        else setLoaded((old) => new Map(old).set(id, result.text ?? ""));
      } catch (error) {
        setLoadError({ path: file.path, key: skillError(error) });
      } finally {
        loading.current.delete(id);
      }
    },
    [peer, loaded, scope.groupId, scope.skillId],
  );
  const textOf = (file: EditorFile): string | undefined => {
    if (file.edited !== undefined) return file.edited;
    if (file.source.kind === "new") return "";
    const id = `${file.source.kind === "upload" ? file.source.uploadId : "saved"}:${file.path}`;
    return loaded.get(id);
  };
  const edit = (path: string, text: string) =>
    setFiles((old) =>
      old.map((file) =>
        file.path === path ? { ...file, edited: text, bytes: byteLength(text) } : file,
      ),
    );
  const add = (raw: string) => {
    const path = raw.normalize("NFC");
    setFiles((old) => [
      ...old,
      { path, bytes: 0, script: false, text: true, source: { kind: "new" }, edited: "" },
    ]);
    return path;
  };
  const remove = (path: string) => setFiles((old) => old.filter((file) => file.path !== path));
  /** Uploaded files replace ones with the same name, the usual "put the new version in". */
  const uploadFiles = async (from: "file" | "folder" | "drop", files?: File[]) => {
    const botId = scope.botId;
    if (!botId) {
      upload.setError("skills.write.noBots");
      return undefined;
    }
    const result = await upload.run(async (signal) => {
      if (!peer) return null;
      const dropId = files ? await registerSkillDrop?.(files) : undefined;
      if (files && !dropId) throw new RpcError(RpcErrorCodes.invalidParams, "skill_files_invalid");
      return peer.call(
        "skills.pickFiles",
        { groupId: scope.groupId, botId, from, dropId: dropId ?? undefined },
        { timeoutMs: 630_000, signal },
      );
    }, skillError);
    if (!result) return undefined;
    const added: EditorFile[] = result.files.map((file) => ({
      ...file,
      source: { kind: "upload", uploadId: result.uploadId, from: file.path },
    }));
    const names = new Set(added.map((file) => key(file.path)));
    setFiles((old) => [...old.filter((file) => !names.has(key(file.path))), ...added]);
    return added[0]?.path;
  };
  const drop = async (files: File[]) => {
    if (files.some((file) => file.size > SKILL_DROP_MAX_BYTES)) {
      upload.setError("skills.error.skill_attachment_too_large");
      return;
    }
    if (
      files.length > SKILL_DROP_MAX_FILES ||
      files.reduce((size, file) => size + file.size, 0) > SKILL_DROP_MAX_BYTES
    ) {
      upload.setError("skills.editor.dropLimit");
      return;
    }
    if (
      files.some(
        (file) => !SkillPackageWritePathSchema.safeParse(file.name.normalize("NFC")).success,
      )
    ) {
      upload.setError("skills.error.skill_files_invalid");
      return;
    }
    await uploadFiles("drop", files);
  };
  /** The change list for a save; undefined when the supporting files are as they were. */
  const changes = (): SkillFileChange[] | undefined => {
    const current = new Set(files.map((file) => key(file.path)));
    const list: SkillFileChange[] = savedPaths.current
      .filter((path) => !current.has(key(path)))
      .map((path) => ({ path, remove: true as const }));
    for (const file of files) {
      if (file.edited !== undefined) list.push({ path: file.path, text: file.edited });
      else if (file.source.kind === "upload")
        list.push({
          path: file.path,
          upload: { uploadId: file.source.uploadId, path: file.source.from },
        });
    }
    return list.length ? list : undefined;
  };
  return {
    files,
    load,
    textOf,
    loadError,
    edit,
    add,
    remove,
    pick: (from: "file" | "folder") => uploadFiles(from),
    drop,
    changes,
    uploading: upload.busy,
    uploadError: upload.error,
  };
}
