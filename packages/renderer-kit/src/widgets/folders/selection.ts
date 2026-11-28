import type { TranslationKey } from "@pibot/i18n";
import { type FolderSelection, RpcError, RpcErrorCodes, type RunnerBrowse } from "@pibot/protocol";
import type { RunnerEntry, RunnerPickTarget } from "./runner-folders.ts";

/** One folder as the picker shows it; `home` is the Bot's own folder. */
export interface FolderEntry {
  id: string;
  name: string;
  path?: string;
  location?: string;
}

/**
 * What the shared picker needs from a conversation (DM topic, new-topic draft, group, routine).
 * Every action is a whole new selection or a system-dialog pick; the owner applies it.
 */
export interface FolderModel {
  /** Paired runners; offline ones are listed but cannot be browsed. */
  runners?: RunnerEntry[];
  /** One level of a runner's folders (no `path`: a starting folder; `null`: Windows drives). */
  browseRunner?(
    location: string,
    path: string | null | undefined,
    signal: AbortSignal,
  ): Promise<RunnerBrowse>;
  /** Registers the browsed runner folder and puts it where `target` says. */
  pickRunner?(location: string, path: string, target: RunnerPickTarget): void;
  primary: FolderEntry;
  readonly: FolderEntry[];
  /** Only owners supporting additional write roots opt in; groups and routines do not. */
  writable?: FolderEntry[];
  pickWritable?(): void;
  /** Folders the Bot used that this conversation does not use yet (most recent first). */
  recent: FolderEntry[];
  /** The Bot works in this conversation: changes wait. */
  busy: boolean;
  /** A change or a system dialog is in flight. */
  pending: boolean;
  /** The folders could not be read; the trigger says so instead of a name. */
  failed?: boolean;
  error?: TranslationKey;
  /** Group folders have no "recent" list and no Bot home choice of their own. */
  homeLabel?: TranslationKey;
  setPrimary(id: string): void;
  setReadonly(id: string): void;
  remove(id: string): void;
  /** `only`: the picked folder alone (the new-topic line's choices start a clean selection). */
  pick(target: "primary" | "readonly" | "only", create?: boolean): void;
  /** Just this folder, no references (the new-topic line's "no folder" / picked folder). */
  setOnly(id: string): void;
}

export const MAX_REFERENCES = 32;
export const MAX_WRITABLE_FOLDERS = 4;

/** Switching the main folder drops the old one (it stays in the Bot's used folders). */
export function withPrimary(selection: FolderSelection, id: string): FolderSelection {
  return {
    ...selection,
    primary: id,
    readonly: selection.readonly.filter((ref) => ref !== id),
    ...(selection.writable && { writable: selection.writable.filter((ref) => ref !== id) }),
  };
}
export function withReadonly(selection: FolderSelection, id: string): FolderSelection | null {
  if (id === "home") return null;
  if (selection.readonly.includes(id)) return selection;
  if (selection.readonly.length >= MAX_REFERENCES) return null;
  return {
    ...selection,
    primary: id === selection.primary ? "home" : selection.primary,
    readonly: [...selection.readonly, id],
    ...(selection.writable && { writable: selection.writable.filter((ref) => ref !== id) }),
  };
}
export function withWritable(selection: FolderSelection, id: string): FolderSelection | null {
  if (id === "home" || id === selection.primary || selection.writable?.includes(id))
    return selection;
  if ((selection.writable?.length ?? 0) >= MAX_WRITABLE_FOLDERS) return null;
  return {
    ...selection,
    readonly: selection.readonly.filter((ref) => ref !== id),
    writable: [...(selection.writable ?? []), id],
  };
}
export function without(selection: FolderSelection, id: string): FolderSelection {
  return {
    ...selection,
    primary: id === selection.primary ? "home" : selection.primary,
    readonly: selection.readonly.filter((ref) => ref !== id),
    ...(selection.writable && { writable: selection.writable.filter((ref) => ref !== id) }),
  };
}

/** Maps an RPC failure to the picker's message. */
export function folderError(error: unknown): TranslationKey {
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof RpcError ? error.code : undefined;
  // A picker already open elsewhere is "busy" too, but it is not the Bot working.
  if (code === RpcErrorCodes.busy && !message.includes("picker")) return "folders.busy";
  if (message.includes("workspace_conflict")) return "folders.conflict";
  if (message.includes("protected_path")) return "folders.protected";
  if (/writable_unsupported|writable_folders_unsupported/.test(message))
    return "folders.writableUnsupported";
  if (message.includes("workspace_targets_mixed")) return "remote.runner.mixed";
  if (/runner_target_offline|runner_offline|runner_disconnected/.test(message))
    return "remote.runner.offlineFolder";
  if (/runner_folder_unreadable|runner_folder_invalid/.test(message))
    return "remote.runner.unreadable";
  if (message.includes("runner_path_unavailable")) return "remote.runner.pathUnavailable";
  if (
    /Unknown working folder|changed; associate|workspace_boundary_changed|path_unavailable|invalid_folder/.test(
      message,
    )
  )
    return "folders.unavailable";
  // The request may have been applied: say so rather than inviting a duplicate.
  if (code === RpcErrorCodes.timeout || code === RpcErrorCodes.closed) return "folders.uncertain";
  return "folders.failed";
}
