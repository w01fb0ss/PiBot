import { basename, extname, join } from "node:path";
import type { BinaryToolRun, PreparedTool } from "@pibot/brain/kit";
import {
  libreOfficeInstalled,
  libreOfficePlatformSupported,
  type OfficeConvertSource,
  owningWriteRoot,
} from "@pibot/execution";
import type { OfficeFormat, OfficeToolInput } from "@pibot/office-contract/full";
import { OFFICE_FAILURES, OfficeError } from "./errors.ts";
import { officeFileContext } from "./file-context.ts";
import type { OfficeWorkers } from "./worker.ts";

type ConvertInput = Extract<OfficeToolInput, { tool: "office_convert" }>;

/** LibreOffice renders a paginated PDF, so a source that the 20 MiB in-process reads refuse may still be valid. */
const CONVERT_MAX_BYTES = 100 * 1024 * 1024;

/** Reasons are fixed strings; the note only explains what the user can do next. */
export const LIBREOFFICE_NOTES = {
  libreoffice_missing:
    "Install LibreOffice, then ask Pi Bot to try the conversion again. Pi Bot shows the official download link on the computer doing the conversion.",
  libreoffice_platform_unsupported:
    "This conversion is available on macOS and Linux with system protection enabled. On Windows, use the source app to save or export the file in the format you need.",
  libreoffice_ready_to_retry:
    "LibreOffice is now available. Ask the user to retry so Pi Bot can check permission to write the converted file.",
  libreoffice_isolation_unavailable:
    "System protection needed for conversion could not start. Ask the user to check Settings → Permissions before retrying.",
  libreoffice_cleanup_unconfirmed:
    "Pi Bot is waiting for the conversion process to exit before deleting its private temporary files. The user can export the original file in their office app. / Pi Bot 正在等待转换进程退出，届时会清理此次转换的私有临时文件。可先用原来的办公软件导出文件。",
  libreoffice_timeout:
    "The conversion did not finish within 120 seconds and was stopped. / 转换在 120 秒内没有完成，已停止。",
  libreoffice_unsupported_format:
    "This source and target combination is not supported. / 不支持这组源格式与目标格式。",
  libreoffice_failed:
    "LibreOffice could not complete the conversion. Try opening and exporting the file in LibreOffice. / LibreOffice 未能完成转换。请尝试在 LibreOffice 中打开并导出文件。",
};

/**
 * Legacy formats only convert to their OOXML counterpart; everything else maps by extension so a
 * rename cannot smuggle a different source family into a conversion.
 */
function convertSource(path: string): OfficeFormat | "markdown" | "csv" | "legacy" | undefined {
  const extension = extname(path).toLowerCase().slice(1);
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "csv") return "csv";
  if (extension === "docx" || extension === "xlsx" || extension === "pptx") return extension;
  if (extension === "doc" || extension === "xls" || extension === "ppt") return "legacy";
  return undefined;
}

const PURE_PAIRS = new Set([
  "docx:markdown",
  "xlsx:csv",
  "pptx:markdown",
  "markdown:docx",
  "markdown:pptx",
  "csv:xlsx",
]);

async function executeConvertInner(
  run: BinaryToolRun,
  prepared: PreparedTool,
  input: ConvertInput,
  signal: AbortSignal,
  workers: OfficeWorkers,
  json: (value: unknown) => string,
  assertCurrent: () => void,
) {
  const { local, context, target } = run;
  signal.throwIfAborted();
  const args = input.args;
  const from = convertSource(args.path);
  if (!from) throw new OfficeError("office_unsupported");
  const extension = extname(args.path).toLowerCase().slice(1);
  const legacyTarget: OfficeFormat | undefined =
    extension === "doc"
      ? "docx"
      : extension === "xls"
        ? "xlsx"
        : extension === "ppt"
          ? "pptx"
          : undefined;
  if (args.to === "pdf") {
    // LibreOffice renders any of the six Office sources; the in-process converter has no PDF route.
    if (!["docx", "xlsx", "pptx", "doc", "xls", "ppt"].includes(extension))
      throw new OfficeError("office_unsupported");
  } else if (from === "legacy" ? legacyTarget !== args.to : !PURE_PAIRS.has(`${from}:${args.to}`))
    throw new OfficeError("office_unsupported");
  const to = args.to;
  // A legacy input converts to its own OOXML family or to PDF; both run the LibreOffice recipe.
  const libreOffice = to === "pdf" || from === "legacy";
  const convert = libreOffice ? local.target.convertOfficeDocument : undefined;
  const unavailable = (reason: keyof typeof LIBREOFFICE_NOTES) => ({
    text: json({ status: "unsupported", reason, to, note: LIBREOFFICE_NOTES[reason] }),
    isError: true,
    details: { errorCode: reason },
  });
  if (libreOffice) {
    const { platform, env } = local.deps;
    if (!libreOfficePlatformSupported(platform))
      return unavailable("libreoffice_platform_unsupported");
    if (!convert) return unavailable("libreoffice_isolation_unavailable");
    if (!libreOfficeInstalled(platform, env)) return unavailable("libreoffice_missing");
    // If it appeared after the discovery-only check, a fresh call must authorize the write.
    if (!prepared.result.path) return unavailable("libreoffice_ready_to_retry");
  }
  const answer = await run.approve(
    { id: prepared.call.id, tool: "read_file", input: { path: args.path, limit: 1 } },
    signal,
  );
  if (typeof answer === "string") return { text: answer, isError: true };
  const source = answer;
  if (source.result.category === "read_ai_config") throw new OfficeError("office_invalid");
  const sourcePath = source.result.path?.path;
  if (!sourcePath || convertSource(sourcePath) !== from) throw new OfficeError("office_invalid");
  const read = await target.readBinary({
    ...officeFileContext(run, source, signal),
    path: sourcePath,
    ...(libreOffice ? { maxBytes: CONVERT_MAX_BYTES } : {}),
  });
  await run.assertDerivedRead(source, signal);
  if (args.expectedRevision && args.expectedRevision !== read.revision)
    throw new OfficeError("office_changed");
  assertCurrent();
  const output = prepared.result.path?.path;
  if (!output) throw new OfficeError("office_invalid");
  if (prepared.result.path?.exists) throw new OfficeError("office_output_exists");
  const encoder = new TextEncoder();
  let candidates: { path: string; data: Uint8Array | undefined }[];
  if (libreOffice) {
    // One fixed recipe inside the execution sandbox; the model never supplies a program or argument.
    if (!convert) return unavailable("libreoffice_isolation_unavailable");
    const converted = await convert({
      dataDir: local.deps.dataDir,
      runId: context.runId,
      bytes: read.bytes,
      source: extension as OfficeConvertSource,
      // The checks above only admit PDF or a legacy source's own OOXML target here.
      target: (to === "pdf" ? "pdf" : (legacyTarget as OfficeConvertSource)) as
        | "docx"
        | "xlsx"
        | "pptx"
        | "pdf",
      signal,
      assertCurrent,
    });
    if (converted.status === "unavailable") return unavailable(converted.reason);
    assertCurrent();
    candidates = [{ path: output, data: converted.bytes }];
  } else {
    let text: string | undefined;
    if (from === "markdown" || from === "csv") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      } catch {
        throw new OfficeError("office_invalid");
      }
    }
    const work = await workers.run(
      {
        action: "convert",
        from,
        to,
        ...(text !== undefined ? { text, name: basename(sourcePath) } : { bytes: read.bytes }),
      },
      signal,
    );
    const converted = work.converted;
    if (!converted) throw new OfficeError("office_invalid");
    assertCurrent();
    // XLSX→CSV always publishes a directory of files; accepting "x.csv" would silently create a
    // directory with that name instead of the requested workbook.
    if (to === "csv" && /\.csv$/i.test(output)) throw new OfficeError("office_invalid");
    candidates = converted.files
      ? converted.files.map((file) => {
          const name = basename(file.name);
          if (!name || name !== file.name || name === "." || name === "..")
            throw new OfficeError("office_invalid");
          return { path: join(output, name), data: encoder.encode(file.text) };
        })
      : [
          {
            path: output,
            data:
              converted.bytes ??
              (converted.text !== undefined ? encoder.encode(converted.text) : undefined),
          },
        ];
  }
  // Check every output before the first write so a failure cannot leave a half-converted set.
  for (const file of candidates) {
    if (!file.data || file.data.byteLength === 0) throw new OfficeError("office_content_limit");
  }
  const onLocalTarget = (context.runWorkplace?.boundary.location?.target ?? "local") === "local";
  const revalidate = async () => {
    assertCurrent();
    await run.assertDerivedRead(source, signal);
    const current = await target.readBinary({
      ...officeFileContext(run, source, signal),
      path: sourcePath,
    });
    if (current.revision !== read.revision) throw new OfficeError("office_changed");
    await run.assertDerivedRead(source, signal);
    assertCurrent();
  };
  const outputs: { path: string; bytes: number }[] = [];
  for (const file of candidates) {
    if (!file.data) throw new OfficeError("office_invalid");
    const before = onLocalTarget
      ? await local.changes.turn.beforeWrite(context, file.path, undefined)
      : undefined;
    let written: Awaited<ReturnType<typeof target.writeBinary>>;
    try {
      written = await target.writeBinary({
        ...officeFileContext(run, prepared, signal),
        path: file.path,
        expectedPath: file.path,
        bytes: file.data,
        revalidate,
        assertCurrent,
      });
    } catch (error) {
      // Published files cannot be rolled back; report exactly what exists before stopping.
      if (!outputs.length) throw error;
      return {
        text: json({
          status: "partial",
          to,
          written: outputs,
          failed: file.path,
          error: error instanceof OfficeError ? OFFICE_FAILURES[error.code] : String(error),
        }),
        isError: true,
      };
    }
    if (before)
      await local.changes.turn.afterWrite(
        context,
        before,
        file.path,
        owningWriteRoot(file.path, prepared.boundary?.writeRoots ?? [], local.deps.platform) ??
          prepared.cwd,
        written.revision,
      );
    local.approvals.audit.append({
      botId: context.botId,
      runId: context.runId,
      kind: "file.written",
      summary: "Office conversion written / 已写入转换结果",
      detail: {
        toolName: input.tool,
        toolCallId: prepared.call.id,
        path: written.path,
        bytes: written.bytes,
      },
    });
    outputs.push({ path: written.path, bytes: written.bytes });
  }
  return {
    text: json({
      status: "converted",
      to,
      source: sourcePath,
      revision: read.revision,
      files: outputs,
      layoutVerified: false,
    }),
  };
}

/** Only fixed format/result labels leave the conversion boundary, never document names or errors. */
export async function executeConvert(...args: Parameters<typeof executeConvertInner>) {
  const [run, , input, signal] = args;
  const started = performance.now();
  let outcome = "failed";
  try {
    const result = await executeConvertInner(...args);
    outcome = "isError" in result && result.isError ? "conversion_failed" : "ok";
    return result;
  } finally {
    run.local.deps.logger.info(
      JSON.stringify({
        module: "file-preview",
        event: "office_convert",
        kind: convertSource(input.args.path) ?? "unknown",
        target: input.args.to,
        outcome: signal.aborted ? "aborted" : outcome,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  }
}
