// Carry fixed import errors from parsing and storage to the job owner.
export class ImportFailure extends Error {
  constructor(
    readonly reason:
      | "unsupported"
      | "source_changed"
      | "source_in_use"
      | "timeout"
      | "format"
      | "gemini_html"
      | "target"
      | "limit"
      | "memory_conflict"
      | "memory_quota"
      | "distillation"
      | "project",
  ) {
    super(reason);
  }
}
