import { z } from "zod";
import { IdSchema } from "../core/ids.ts";

// Opening a note in the person's own Obsidian. The brain has already proved that the
// reference belongs to a stored reply and that the note is inside a vault assigned to that Bot or
// group; this port carries only the identities it verified, so no URL, app name, path list or
// command can reach the host. The host re-checks the same identities, rebuilds the `obsidian://`
// URI itself and hands that one string to the system.

const identity = z.strictObject({
  /** Canonical path as the source was recorded; never a path from a model or the renderer. */
  path: z
    .string()
    .min(1)
    .max(32768)
    .refine((value) => !value.includes("\0")),
  device: z.string().min(1).max(64),
  inode: z.string().min(1).max(64),
});

export const KnowledgeOpenHostMethods = {
  "host.knowledge.trashNote": {
    params: z.strictObject({
      vault: identity,
      relativePath: z.string().min(1).max(500),
      expectedVersion: z.string().min(1).max(200),
    }),
    result: z.strictObject({ trashed: z.literal(true) }),
  },
  "host.knowledge.openNote": {
    params: z.strictObject({
      /**
       * One-shot handle the brain registered before calling. The host asks the brain to revalidate
       * through it after the slow configuration check and immediately before the system open, so a
       * source revoked while Obsidian's config was being read cannot still be opened.
       */
      requestId: IdSchema,
      sourceId: IdSchema,
      vault: identity,
      note: z.strictObject({
        /** Vault-relative document path; the host resolves it and refuses anything that leaves the root. */
        relativePath: z.string().min(1).max(4096),
        device: z.string().min(1).max(64),
        inode: z.string().min(1).max(64),
      }),
      /** True for plain document folders or non-Markdown files that should reveal in file manager. */
      preferReveal: z.boolean().optional(),
    }),
    result: z.strictObject({
      opened: z.literal(true),
      method: z.enum(["obsidian", "revealed"]).optional(),
      fallbackReason: z
        .enum(["obsidian_unavailable", "duplicate_vault", "not_in_obsidian", "document_file"])
        .optional(),
    }),
  },
} as const;

/**
 * The reverse direction of the same private peer: the host asks the brain whether this click is
 * still allowed, and consumes the handle. Registered by the brain-side host adapter only; the
 * renderer and the model never see the id.
 */
export const KnowledgeConfirmHostMethods = {
  "host.knowledge.confirmOpen": {
    params: z.strictObject({ requestId: IdSchema }),
    result: z.null(),
  },
} as const;
