import { z } from "zod";
import type { WorkspaceSnapshot } from "../core/boundaries.ts";
import { AbsolutePathSchema, ExecutionLocationTargetSchema } from "../core/boundaries.ts";
import { IdSchema } from "../core/ids.ts";

const text = z.string().min(1);
const time = z.iso.datetime();
const count = z.number().int().nonnegative().safe();
export const WorkingFolderSchema = z.strictObject({
  id: IdSchema,
  path: text,
  displayPath: AbsolutePathSchema.optional(),
  location: ExecutionLocationTargetSchema.optional(),
  name: text,
  role: z.enum(["primary", "readonly", "writable"]).optional(),
  association: z.enum(["user", "monitor"]).optional(),
  commandReadBlocked: z.boolean().optional(),
  /** Last time a topic / routine picked this folder (the Bot's "used folders" list). */
  lastUsedAt: time.optional(),
});
export const WorkplacesSchema = z.strictObject({
  home: text,
  folders: z.array(WorkingFolderSchema).max(200),
  /**
   * The primary folder of the resolved selection. On the Bot-level `workplaces.list` it is the
   * legacy Bot "current folder", which is no longer exposed.
   * @deprecated for Bot-level reads; folders belong to conversations.
   */
  currentId: z.union([z.literal("home"), IdSchema]),
  revision: count.optional(),
});
/** A conversation's folders: one writable primary, up to four additional write roots and read-only references. */
export const FolderSelectionSchema = z
  .strictObject({
    primary: z.union([z.literal("home"), IdSchema]),
    readonly: z.array(IdSchema).max(32),
    writable: z.array(IdSchema).max(4).optional(),
  })
  .refine(
    (value) =>
      new Set(value.readonly).size === value.readonly.length &&
      !value.readonly.includes(value.primary) &&
      new Set(value.writable ?? []).size === (value.writable ?? []).length &&
      (value.writable ?? []).every((id) => id !== value.primary && !value.readonly.includes(id)),
    "Duplicate folder in selection",
  );
/** One row of the Bot's read-only "used folders" list. */
export const UsedFolderSchema = z.strictObject({
  id: IdSchema,
  name: text,
  path: text,
  association: z.enum(["user", "monitor"]),
  lastUsedAt: time.nullable(),
  topics: z.array(z.strictObject({ id: IdSchema, title: z.string().max(200) })).max(3),
  topicCount: count,
  routineCount: count,
});
const RunnerLocationSchema = z.string().regex(/^runner:[a-f0-9]{64}$/);
/**
 * One level of a runner's folders, as the folder chooser browses it. `path: null` is the
 * level above the drive roots (Windows only); `top` means there is nothing above this level.
 */
export const RunnerBrowseSchema = z.strictObject({
  platform: z.enum(["darwin", "linux", "win32"]),
  path: z.string().min(1).max(32768).nullable(),
  parent: z.string().min(1).max(32768).nullable(),
  top: z.boolean(),
  folders: z
    .array(
      z.strictObject({ name: z.string().min(1).max(4096), path: z.string().min(1).max(32768) }),
    )
    .max(500),
  truncated: z.boolean(),
});
const botId = z.strictObject({ botId: IdSchema });
const folder = botId.extend({ folderId: z.union([z.literal("home"), IdSchema]) });
const _ok = z.strictObject({ ok: z.literal(true) });
export const WorkplaceMethods = {
  "workplaces.reveal": { params: folder, result: _ok },
  "workplaces.list": { params: botId, result: WorkplacesSchema },
  "workplaces.add": { params: botId, result: WorkplacesSchema },
  "workplaces.remove": { params: botId.extend({ folderId: IdSchema }), result: WorkplacesSchema },
  /** @deprecated Bots no longer have a current folder; kept so older clients still work. */
  "workplaces.setCurrent": { params: folder, result: WorkplacesSchema },
  // Register a folder from the system dialog (`create` lets the user make a new one there).
  // Nothing is bound: the caller then puts the returned ID into a topic / routine / draft selection.
  "workplaces.pick": {
    params: botId
      .extend({
        create: z.boolean().optional(),
        /** ACP session roots are retained only for the topic they bind and never shown as user folders. */
        association: z.enum(["user", "monitor", "session"]).optional(),
        location: z
          .string()
          .regex(/^runner:[a-f0-9]{64}$/)
          .optional(),
        path: z.string().min(1).max(32768).optional(),
      })
      .refine(
        (value) => !!value.path === !!value.location && !(value.location && value.create),
        "Runner folder requires a location and path",
      ),
    result: z.strictObject({ folder: WorkingFolderSchema.nullable() }),
  },
  // The folder chooser browses a paired runner's folders (renderer only; never a Bot tool).
  // No `path`: a starting folder near the user's folders; `null`: the drive list on Windows.
  "workplaces.browse": {
    params: z.strictObject({
      location: RunnerLocationSchema,
      path: z.string().min(1).max(32768).nullable().optional(),
    }),
    result: RunnerBrowseSchema,
  },
  "workplaces.used": {
    params: botId,
    result: z.strictObject({ folders: z.array(UsedFolderSchema).max(200) }),
  },
  // Hides the record only; topics and routines that use the folder keep working.
  "workplaces.forget": {
    params: botId.extend({ folderId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true), inUse: count }),
  },
} as const;
export type Workplaces = z.infer<typeof WorkplacesSchema>;
export type WorkingFolder = z.infer<typeof WorkingFolderSchema>;
export type FolderSelection = z.infer<typeof FolderSelectionSchema>;
export type UsedFolder = z.infer<typeof UsedFolderSchema>;
export type RunnerBrowse = z.infer<typeof RunnerBrowseSchema>;

/** A run's resolved workplace; pure contract used by collaboration and capability ports. */
export interface ResolvedWorkplace {
  value: Workplaces;
  /** Display spellings for roots that the policy workplace keeps separately, such as group folders. */
  displayFolders?: readonly { path: string; displayPath?: string }[];
  cwd: string;
  roots: string[];
  home: string;
  boundary: WorkspaceSnapshot;
  /**
   * Read-only reference / watched folders that no longer exist and were left out of this
   * run (names only, never paths). Absent when every folder resolved; the run keeps its own folder.
   */
  gone?: { id: string; name: string }[];
}
