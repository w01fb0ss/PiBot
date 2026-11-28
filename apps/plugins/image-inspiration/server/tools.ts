import type { ConnectorRemoteTool } from "@pibot/plugin-sdk";

export const inspirationTools: readonly ConnectorRemoteTool[] = [
  {
    name: "inspiration_search",
    title: "检索生图灵感库 / Search image inspirations",
    description:
      "Search bundled MIT-licensed image prompt templates and visual references by keywords, style, layout, and theme. Call this before generating stylised covers, posters, illustrations, UI mockups, or storyboards.",
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    inputLanguage: { query: "en" },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Keywords in English or Chinese (subject, visual mood, medium, or format).",
        },
        style: {
          type: "string",
          maxLength: 80,
          description:
            "Optional style filter (e.g. Illustration, Photography, Poster, Editorial, Minimalist, 3D, UI, Anime, Watercolor, Vintage, Product, Infographic).",
        },
        layout: {
          type: "string",
          maxLength: 80,
          description:
            "Optional layout/composition filter (e.g. poster, cover, grid, split-screen, storyboard, infographic, card, banner, portrait, landscape, flat-lay, isometric, ui-screen).",
        },
        theme: {
          type: "string",
          maxLength: 80,
          description:
            "Optional theme/category filter (e.g. Tech, Food, Travel, Commerce, E-commerce, Fashion, Education, Social, Portrait, Poster, Ad Creative, Architecture, Brand).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Maximum results to return (1-25, default 8).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspiration_get",
    title: "读取生图灵感详情 / Get image inspiration",
    description:
      "Fetch the full prompt text, style guidance, pitfalls, and license/commit provenance for one inspiration entry returned by inspiration_search.",
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Entry id returned by inspiration_search.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];
