import {
  BotSchema,
  ChangeCommitSchema,
  ChangesDiffSchema,
  ChangesImageSideSchema,
  ChangesLinesSchema,
  ChangesStatusSchema,
  ChangesTargetSchema,
  ChangesTurnSchema,
  GeneratedCommitMessageSchema,
  GitIdentitySchema,
  GitOidSchema,
  GitRefNameSchema,
  IdSchema,
  ReviewFindingSchema,
  ReviewFindingStateSchema,
  SidebarKeySchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));
const refCursor = z
  .string()
  .max(1200)
  .regex(/^refs\/(heads|tags)\/[^\0\r\n]*$/);
const targetFields = {
  conversationKey: SidebarKeySchema,
  topicId: IdSchema.optional(),
  rootId: z.union([z.literal("home"), IdSchema]).optional(),
};
const validTarget = (p: { conversationKey: string; topicId?: string }) =>
  !p.topicId || p.conversationKey.startsWith("dm:");
const scopedTarget = <T extends z.ZodRawShape>(shape: T) =>
  z
    .strictObject({ ...targetFields, ...shape })
    .refine((p) => validTarget(p as { conversationKey: string; topicId?: string }));
const ok = z.strictObject({ ok: z.literal(true) });
const shortText = z.string().min(1).max(200);
export const GitSetupStatusSchema = z.strictObject({
  state: z.enum(["available", "missing", "installing", "failed", "unsupported"]),
  version: z.string().max(100).optional(),
  /** xcode: Apple's Command Line Tools; package: the system installer; manual: no in-app installer. */
  installer: z.enum(["xcode", "package", "manual"]).optional(),
  /** What Pi Bot runs, e.g. "dnf install -y git". */
  command: shortText.optional(),
  /** What the user can run in a terminal instead, e.g. "sudo dnf install -y git". */
  manualCommand: shortText.optional(),
  /** Why installation requires manual action or the last attempt did not end with Git. */
  reason: z.enum(["denied", "failed", "no_elevation", "timeout", "cancelled"]).optional(),
});
export type GitSetupStatus = z.infer<typeof GitSetupStatusSchema>;
export const ChangesMethods = {
  "changes.reveal": {
    params: z.union([
      z.strictObject({ runId: IdSchema, path }),
      z.strictObject({ target: ChangesTargetSchema, path }),
    ]),
    result: ok,
  },
  "changes.status": {
    params: scopedTarget({
      /** Lists the files of one commit (history scope) instead of uncommitted changes. */
      commit: GitOidSchema.optional(),
      /** Page after this path (sorted by path). */
      cursor: path.optional(),
      limit: count.positive().max(2000).optional(),
    }),
    result: ChangesStatusSchema,
  },
  "changes.diff": {
    params: scopedTarget({
      path,
      scope: z.enum(["uncommitted", "turn", "commit"]),
      commit: GitOidSchema.optional(),
      runId: IdSchema.optional(),
    }).refine(
      (p) => (p.scope === "commit") === !!p.commit && (p.scope === "turn") === !!p.runId,
      "Scope requires its commit or runId",
    ),
    result: ChangesDiffSchema,
  },
  "changes.turn": {
    params: z.union([z.strictObject({ runId: IdSchema }), ChangesTargetSchema]),
    result: ChangesTurnSchema,
  },
  "changes.log": {
    params: scopedTarget({
      before: GitOidSchema.optional(),
      limit: count.positive().max(50).optional(),
    }),
    result: z.strictObject({ commits: z.array(ChangeCommitSchema).max(50), hasMore: z.boolean() }),
  },
  "changes.refs": {
    params: scopedTarget({ kind: z.enum(["branch", "tag"]), after: refCursor.optional() }).refine(
      (value) =>
        !value.after ||
        value.after.startsWith(value.kind === "branch" ? "refs/heads/" : "refs/tags/"),
    ),
    result: z.strictObject({
      refs: z
        .array(
          z.strictObject({ name: z.string().max(1024), oid: GitOidSchema, occupied: z.boolean() }),
        )
        .max(50),
      next: refCursor.nullable(),
      writable: z.boolean(),
    }),
  },
  "changes.remotes": {
    params: ChangesTargetSchema,
    result: z.strictObject({
      head: GitOidSchema.nullable(),
      branch: z.string().max(200).nullable(),
      upstream: z
        .strictObject({ remote: z.string().max(100), branch: z.string().max(200) })
        .nullable(),
      remotes: z
        .array(
          z.strictObject({
            name: z.string().max(100),
            fetchHost: z.string().max(253).nullable(),
            pushHost: z.string().max(253).nullable(),
            fetchSupported: z.boolean(),
            pushSupported: z.boolean(),
          }),
        )
        .max(50),
      writable: z.boolean(),
    }),
  },
  "changes.sync": {
    params: scopedTarget({
      action: z.enum(["push", "pull"]),
      remote: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
      remoteBranch: z.string().min(1).max(200),
      head: GitOidSchema,
      branch: z.string().min(1).max(200),
    }),
    result: ok,
  },
  "changes.refWrite": {
    params: scopedTarget({
      action: z.enum(["createBranch", "switchBranch", "createTag"]),
      name: GitRefNameSchema,
      head: GitOidSchema,
      branch: z.string().max(1024).nullable(),
      commit: GitOidSchema,
    }),
    result: ok,
  },
  "changes.discard": {
    params: scopedTarget({
      path,
      hunk: z.strictObject({ index: count, digest: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
    }),
    result: ok,
  },
  /**
   * Takes one object of a Word / Excel / PowerPoint file back to the older version.
   * digest is the newer side's sha256 from changes.diff, so a file changed elsewhere meanwhile is
   * refused instead of overwritten with a splice of the wrong content.
   */
  "changes.discardOffice": {
    params: scopedTarget({
      path,
      scope: z.enum(["uncommitted", "turn", "commit"]),
      commit: GitOidSchema.optional(),
      runId: IdSchema.optional(),
      /** Item id from changes.diff (stable for one pair of versions of this file). */
      item: z.string().min(1).max(120),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
    }).refine(
      (p) => (p.scope === "commit") === !!p.commit && (p.scope === "turn") === !!p.runId,
      "Scope requires its commit or runId",
    ),
    result: ok,
  },
  "changes.commit": {
    params: scopedTarget({
      paths: z.array(path).min(1).max(5000),
      message: z.string().trim().min(1).max(10_000),
      /** Only when Git has no identity for this repository and the user typed one. */
      author: GitIdentitySchema.optional(),
    }),
    result: z.strictObject({ commit: GitOidSchema }),
  },
  /** Drafts with the conversation Bot's model; changes_draft_unavailable when no usable model. */
  "changes.draftMessage": {
    params: scopedTarget({ paths: z.array(path).min(1).max(5000) }),
    result: z.strictObject({ message: GeneratedCommitMessageSchema }),
  },
  /** Starts or stops change notifications for the target's folder (at most four folders at once). */
  "changes.watch": {
    params: scopedTarget({ on: z.boolean() }),
    result: ok,
  },
  /**
   * Unchanged lines between hunks (newer side: working tree, the commit, or the turn's
   * "after" snapshot). count 0 returns only the total. Files over the read limit return none.
   */
  "changes.lines": {
    params: scopedTarget({
      path,
      scope: z.enum(["uncommitted", "turn", "commit"]),
      commit: GitOidSchema.optional(),
      runId: IdSchema.optional(),
      from: count.positive(),
      count: count.max(2000),
    }).refine(
      (p) => (p.scope === "commit") === !!p.commit && (p.scope === "turn") === !!p.runId,
      "Scope requires its commit or runId",
    ),
    result: ChangesLinesSchema,
  },
  /** Thumbnail of one side of an image diff (read-only, size-limited, type-checked). */
  "changes.image": {
    params: scopedTarget({
      path,
      scope: z.enum(["uncommitted", "turn", "commit"]),
      commit: GitOidSchema.optional(),
      runId: IdSchema.optional(),
      side: z.enum(["before", "after"]),
    }).refine(
      (p) => (p.scope === "commit") === !!p.commit && (p.scope === "turn") === !!p.runId,
      "Scope requires its commit or runId",
    ),
    result: ChangesImageSideSchema,
  },
  /** Findings of the latest review run in this conversation for the target's folder. */
  "changes.reviews": {
    params: scopedTarget({}),
    result: z.strictObject({
      runId: IdSchema.nullable(),
      freshness: z.enum(["current", "stale", "unavailable"]),
      findings: z.array(ReviewFindingSchema).max(200),
      /** The Bot that reviewed, when it was not the chat's own Bot. */
      reviewerName: z.string().max(200).optional(),
    }),
  },
  /**
   * Called once the review request was accepted: registers the review with the run it went to,
   * so it replaces the previous findings when it completes even with none of its own. runIds is
   * empty when no run of this conversation could be bound (the previous findings then stay).
   */
  "changes.reviewStart": {
    params: scopedTarget({}),
    result: z.strictObject({ runIds: z.array(IdSchema).max(6) }),
  },
  /** Who can review this chat's code, who reviews now and whom Pi Bot recommends. */
  "changes.reviewers": {
    params: scopedTarget({}),
    result: z.strictObject({
      authorId: IdSchema,
      reviewerId: IdSchema,
      defaultId: IdSchema.nullable(),
      recommendedId: IdSchema,
      /** No live Bot comes from the built-in code-reviewer role yet (offer to create 小审). */
      builtinMissing: z.boolean(),
      bots: z
        .array(
          BotSchema.pick({
            id: true,
            name: true,
            modelId: true,
            avatarShape: true,
            avatarColor: true,
            avatarEyes: true,
            avatarImage: true,
            role: true,
          }),
        )
        .max(200),
    }),
  },
  /**
   * The Bot that should review this target's next review request (used once). `review`
   *What the request asks for, so an author that cannot call Pi Bot's review tool (an
   * external agent) has Pi Bot start the same review itself.
   */
  "changes.reviewerSet": {
    params: scopedTarget({
      botId: IdSchema,
      review: z.strictObject({ scope: z.enum(["turn", "uncommitted"]) }).optional(),
    }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  /** "ignore" (dismissed) or "fix this / fix all" (sent) on findings of this target. */
  "changes.reviewUpdate": {
    params: scopedTarget({
      ids: z.array(IdSchema).min(1).max(200),
      state: ReviewFindingStateSchema,
    }),
    result: ok,
  },
  /**
   * Whether this computer has Git, and how Pi Bot would install it (maintainers 2026-11-21). Every
   * call looks again, so it doubles as 「再检查」. Windows ships Git and answers "unsupported".
   */
  "changes.gitStatus": { params: z.strictObject({}), result: GitSetupStatusSchema },
  /**
   * The user clicked 「安装」 on the card: starts the system installer outside the sandbox and
   * returns at once ("installing"); the card polls changes.gitStatus. A second click while one
   * runs gets the same "installing" answer, never a second installer.
   */
  "changes.gitInstall": { params: z.strictObject({}), result: GitSetupStatusSchema },
} as const;
export const ChangesEvents = {
  /** Coalesced, at most once per second per folder; diff text is fetched on demand, never pushed. */
  "changes.changed": z.strictObject({
    conversationKey: SidebarKeySchema.optional(),
    topicId: IdSchema.optional(),
    rootPath: z.string().optional(),
    runId: IdSchema.optional(),
    /** "review": a Bot recorded a review finding; re-read changes.reviews. */
    /**
     * "folder": the conversation's folder changed (associated, removed, switched). It names the
     * conversation only (any topic): watch again so the watch follows the new folder, then reread.
     */
    reason: z.enum(["files", "stats", "turn", "review", "folder"]),
  }),
} as const;
