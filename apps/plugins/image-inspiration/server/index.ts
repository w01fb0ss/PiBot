import { serveStdio } from "@pibot/plugin-sdk";
import { getInspiration, searchInspirations } from "./catalog.ts";
import { inspirationTools } from "./tools.ts";

await serveStdio({
  id: "image-inspiration",
  open: async () => ({
    listTools: async () => ({ tools: [...inspirationTools] }),
    onToolsChanged: () => () => undefined,
    callTool: async ({ tool, args, signal }) => {
      signal.throwIfAborted();
      if (tool === "inspiration_search") {
        return searchInspirations({
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.style === "string" ? { style: args.style } : {}),
          ...(typeof args.layout === "string" ? { layout: args.layout } : {}),
          ...(typeof args.theme === "string" ? { theme: args.theme } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
      }
      if (tool === "inspiration_get") {
        const entry = getInspiration(String(args.id ?? ""));
        if (!entry) throw new Error("inspiration_not_found");
        return entry;
      }
      throw new Error("inspiration_tool_unavailable");
    },
    close: async () => undefined,
  }),
});
