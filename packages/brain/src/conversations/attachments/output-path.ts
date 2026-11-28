// Recognize run-produced deliverables without treating a reply as file-read authority.
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const DELIVERABLE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".rtf",
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".ods",
  ".ppt",
  ".pptx",
  ".odp",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".tif",
  ".tiff",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".sql",
  ".ipynb",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".swift",
  ".kt",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".vue",
  ".svelte",
  ".toml",
  ".mp3",
  ".mp4",
  ".mov",
  ".m4v",
  ".m4a",
  ".wav",
  ".webm",
  ".ogg",
  ".zip",
]);

/** Lexical candidate filter only; sendFiles must still verify canonical paths and file identity. */
export function isOutputDeliverable(path: string, roots: readonly string[]): boolean {
  if (!DELIVERABLE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  return roots.some((root) => {
    const part = relative(resolve(root), resolve(path));
    if (!part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) return false;
    const segments = part.split(sep);
    if (segments.includes(".cache")) return false;
    const folder = segments.indexOf(".pibot");
    return folder >= 0 && segments[folder + 1] === "out" && segments.length > folder + 2;
  });
}
