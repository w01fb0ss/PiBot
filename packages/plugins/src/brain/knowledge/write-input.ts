import {
  KnowledgeCreateInputSchema,
  KnowledgeDeleteInputSchema,
  KnowledgeUpdateInputSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/plugins-contract/full";

export function isKnowledgeWrite(tool: string): tool is KnowledgeWriteTool {
  return tool === "knowledge_create" || tool === "knowledge_update" || tool === "knowledge_delete";
}

export type KnowledgeWriteTool = "knowledge_create" | "knowledge_update" | "knowledge_delete";

export type KnowledgeWriteInput = ReturnType<typeof parseKnowledgeWrite>;

export function parseKnowledgeWrite(tool: KnowledgeWriteTool, input: unknown) {
  switch (tool) {
    case "knowledge_create":
      return { action: "create", ...KnowledgeCreateInputSchema.parse(input) } as const;
    case "knowledge_update":
      return { action: "update", ...KnowledgeUpdateInputSchema.parse(input) } as const;
    case "knowledge_delete":
      return { action: "delete", ...KnowledgeDeleteInputSchema.parse(input) } as const;
  }
}

export function writeRef(input: KnowledgeWriteInput) {
  return input.action === "create" ? (input.path ?? input.parent ?? "") : input.ref;
}

export function writeError(code: string): never {
  throw new RpcError(RpcErrorCodes.invalidParams, code);
}
