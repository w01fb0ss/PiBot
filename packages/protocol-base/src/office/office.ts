import { z } from "zod";
import { base64Schema } from "../chat/attachments.ts";
import { optionalPageOffset } from "../tools/pagination.ts";
import { OfficeContentSchema, OfficeFormatSchema } from "./content.ts";
import { OfficeOperationsSchema } from "./ooxml.ts";
import { OfficeStructureQuerySchema } from "./structure.ts";
import { WordReviewKindSchema } from "./word.ts";

const path = z.string().min(1).max(32_768);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const page = z.number().int().nonnegative();
export const OfficePreviewSchema = z.strictObject({
  format: OfficeFormatSchema,
  revision,
  content: OfficeContentSchema,
  warnings: z.array(z.string().max(500)).max(30),
  truncated: z.boolean(),
  total: page,
  sheetNames: z.array(z.string().max(31)).max(50).optional(),
  sheetIndex: page.optional(),
});
export const OfficeAppsSchema = z.strictObject({
  apps: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(300),
        name: z.string().min(1).max(300),
        formats: z.array(OfficeFormatSchema).max(3),
      }),
    )
    .max(100),
  defaultAvailable: z.boolean(),
});
export const OFFICE_RENDER_EDGE = 960;
export const OFFICE_RENDER_PAGE_COUNT = 5;
export const OFFICE_RENDER_PIXELS = 3_500_000;
export const OFFICE_RENDER_PAGE_BYTES = 700 * 1024;
const renderPage = z.number().int().min(1).max(10_000);
const renderPages = z
  .array(renderPage)
  .min(1)
  .max(OFFICE_RENDER_PAGE_COUNT)
  .refine((pages) => new Set(pages).size === pages.length);
export const OfficeRenderIssueSchema = z.strictObject({
  page: renderPage,
  code: z.enum([
    "text_overflow",
    "low_contrast",
    "text_shrunk",
    "too_many_fonts",
    "too_many_points",
    "picture_outside",
    "element_outside",
    "element_overlap",
    "empty_slide",
    "small_text",
    "missing_picture",
    "layout_check_incomplete",
  ]),
  value: z.number().finite().nonnegative().max(10_000).optional(),
  /** A hint never counts as a problem: page numbers, footers and heavily shrunk text. */
  severity: z.enum(["issue", "hint"]).optional(),
});
export const OfficeRenderCheckSchema = z.strictObject({
  issues: z.array(OfficeRenderIssueSchema).max(25),
  pages: z.array(renderPage).max(OFFICE_RENDER_PAGE_COUNT),
  outOfRange: z.array(renderPage).max(OFFICE_RENDER_PAGE_COUNT),
  activeContent: z.boolean(),
});
export const OfficeRenderedPageSchema = z.strictObject({
  page: renderPage,
  width: z.number().int().min(1).max(OFFICE_RENDER_EDGE),
  height: z.number().int().min(1).max(OFFICE_RENDER_EDGE),
  data: base64Schema(OFFICE_RENDER_PAGE_BYTES),
});
export const OfficeRenderedPagesSchema = z
  .array(OfficeRenderedPageSchema)
  .max(OFFICE_RENDER_PAGE_COUNT)
  .refine(
    (pages) =>
      new Set(pages.map(({ page }) => page)).size === pages.length &&
      pages.reduce((pixels, { width, height }) => pixels + width * height, 0) <=
        OFFICE_RENDER_PIXELS,
  );
export type OfficeRenderCheck = z.infer<typeof OfficeRenderCheckSchema>;
export type OfficeRenderIssue = z.infer<typeof OfficeRenderIssueSchema>;

const toolOffset = optionalPageOffset.describe(
  "Omit offset for the first page; never pass placeholders.",
);

export const officeToolSchemas = {
  office_inspect: z.strictObject({
    path,
    expectedRevision: revision.optional(),
    ...OfficeStructureQuerySchema.shape,
    offset: toolOffset,
  }),
  office_read: z.strictObject({
    path,
    expectedRevision: revision.optional(),
    section: z.enum(["content", "structure"]).optional(),
    wordReview: WordReviewKindSchema.optional(),
    collection: OfficeStructureQuerySchema.shape.collection,
    slide: OfficeStructureQuerySchema.shape.slide,
    sheet: page.optional(),
    offset: toolOffset,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  office_create: z.strictObject({
    path,
    content: OfficeContentSchema,
    acceptValidationErrors: z.boolean().optional(),
  }),
  office_edit: z.strictObject({
    path,
    expectedRevision: revision,
    outputPath: path.optional(),
    operations: OfficeOperationsSchema,
    acceptValidationErrors: z.boolean().optional(),
  }),
  office_preview: z.strictObject({
    path,
    expectedRevision: revision.optional(),
    sheet: page.optional(),
    offset: toolOffset,
    limit: z.number().int().min(1).max(200).optional(),
  }),
  office_validate: z.strictObject({ path, expectedRevision: revision.optional() }),
  office_render: z.strictObject({
    path,
    pages: renderPages.default([1]),
    expectedRevision: revision.optional(),
    outputPath: path.optional(),
    review: z.boolean().optional(),
  }),
  office_capabilities: z.strictObject({ format: OfficeFormatSchema.optional() }),
  office_template_fields: z.strictObject({ path, expectedRevision: revision.optional() }),
  office_template_fill: z.strictObject({
    path,
    expectedRevision: revision,
    data: z.record(z.string().max(120), z.unknown()),
    outputPath: path.optional(),
    acceptValidationErrors: z.boolean().optional(),
  }),
  office_convert: z.strictObject({
    path,
    to: z.enum(["markdown", "docx", "xlsx", "pptx", "csv", "pdf"]),
    outputPath: path.optional(),
    expectedRevision: revision.optional(),
  }),
};

/** A render writes only its explicit export target; the source deck is always read. */
export function officeRenderOutputPath(
  tool: string,
  input: { outputPath?: unknown },
): string | undefined {
  const output = input.outputPath;
  return tool === "office_render" && typeof output === "string" && output ? output : undefined;
}

export const OfficeHostMethods = {
  "host.office.render": {
    params: z.strictObject({
      format: OfficeFormatSchema,
      data: base64Schema(20 * 1024 * 1024),
      pages: renderPages,
    }),
    result: OfficeRenderedPagesSchema,
  },
  "host.officeApps": {
    params: z.strictObject({ format: OfficeFormatSchema }),
    result: OfficeAppsSchema,
  },
  "host.officeOpen": {
    params: z.strictObject({
      botId: z.uuid(),
      file: path,
      allowedRoots: z.array(path).min(1).max(202),
      appId: z.string().min(1).max(300),
    }),
    result: z.null(),
  },
};
export type OfficePreview = z.infer<typeof OfficePreviewSchema>;
export type OfficeApps = z.infer<typeof OfficeAppsSchema>;
export type OfficeToolInput = {
  [K in keyof typeof officeToolSchemas]: { tool: K; args: z.infer<(typeof officeToolSchemas)[K]> };
}[keyof typeof officeToolSchemas];
