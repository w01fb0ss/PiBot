export const SEARCH_TOOLS = ["notion-search", "search", "notion_search", "API-post-search"];
export const READ_TOOLS = ["notion-fetch", "fetch", "notion_fetch", "API-retrieve-a-page"];
export const ACCOUNT_TOOL = "notion-get-self";
export const TASK_TOOL = "notion-get-async-task";
export const WRITE_TOOLS = {
  create: "notion-create-pages",
  update: "notion-update-page",
  delete: "notion-delete-pages",
} as const;

export function isManagedNotionRead(tool: string): boolean {
  return (
    SEARCH_TOOLS.includes(tool) ||
    READ_TOOLS.includes(tool) ||
    tool === ACCOUNT_TOOL ||
    tool === TASK_TOOL
  );
}
