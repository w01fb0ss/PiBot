// Knowledge sources: extends the existing contract matrix with the new methods and event.
import type { EventPayloads, MethodParams, MethodResults } from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-16T00:00:00.000Z";
const source = {
  id,
  kind: "obsidian" as const,
  name: "Vault",
  targets: { all: false, bots: [], groups: [] },
  writable: false,
  createdAt: at,
  updatedAt: at,
  lastUsedAt: null,
};
type Fixture<K extends keyof MethodParams> = {
  params: MethodParams[K];
  result: MethodResults[K];
  badParams: unknown;
  badResult: unknown;
};
type KnowledgeMethod =
  | "knowledge.detect"
  | "knowledge.list"
  | "knowledge.get"
  | "knowledge.inspect"
  | "knowledge.addObsidian"
  | "knowledge.repoint"
  | "knowledge.repointReference"
  | "knowledge.addNotion"
  | "knowledge.account"
  | "knowledge.update"
  | "knowledge.remove"
  | "knowledge.openReference";

export const knowledgeMethodCases = {
  "knowledge.detect": {
    params: {},
    result: {
      obsidian: {
        installed: true,
        vaults: [{ name: "Vault", path: "/Users/me/Vault", added: false }],
      },
      notion: { installed: false },
    },
    badParams: { path: "/Users/me/Vault" },
    badResult: { obsidian: { installed: true, vaults: [] }, notion: { installed: "maybe" } },
  },
  "knowledge.list": {
    params: { limit: 50 },
    result: { items: [source], nextBefore: null },
    badParams: { limit: 101 },
    badResult: { items: [] },
  },
  "knowledge.account": {
    params: { id, refresh: true },
    result: {
      account: {
        status: "ok" as const,
        reason: null,
        workspace: "Team",
        name: "Me",
        email: "me@example.com",
        checkedAt: at,
      },
    },
    badParams: {},
    badResult: { account: { status: "maybe" } },
  },
  "knowledge.get": {
    params: { id },
    result: { source, origin: { kind: "obsidian" as const, path: "/Users/me/Vault" } },
    badParams: {},
    badResult: { source, origin: { kind: "obsidian" } },
  },
  "knowledge.inspect": {
    params: { id },
    result: {
      summary: {
        status: "ok" as const,
        supported: 12,
        unsupported: 3,
        scannedPdf: 1,
        skippedLarge: 0,
        skippedUnreadable: 1,
        unexamined: 0,
        byKind: { markdown: 8, text: 2, pdf: 1, word: 1 },
        truncated: false,
      },
    },
    badParams: {},
    badResult: { summary: { status: "missing" } },
  },
  "knowledge.addObsidian": {
    params: {},
    result: { source },
    badParams: { path: "/Users/me/Vault" },
    badResult: {},
  },
  "knowledge.repoint": {
    params: { id },
    result: { source },
    badParams: { path: "/Users/me/Vault" },
    badResult: {},
  },
  "knowledge.repointReference": {
    params: {
      messageId: id,
      href: "obsidian://open?vault=Vault&file=Notes%2FPlan",
    },
    result: { sourceId: id },
    badParams: { messageId: id, href: "obsidian://open?vault=Vault&file=Notes%2FPlan", botId: id },
    badResult: {},
  },
  "knowledge.addNotion": {
    params: {},
    result: { source: { ...source, kind: "notion" as const }, connectorId: id },
    badParams: { id },
    badResult: { connectorId: id },
  },
  "knowledge.update": {
    params: { id, name: "Vault", targets: { all: false, bots: [id], groups: [] } },
    result: source,
    badParams: { id, name: "", targets: { bots: [], groups: [] } },
    badResult: { ...source, kind: "other" },
  },
  "knowledge.remove": {
    params: { id },
    result: { ok: true as const },
    badParams: {},
    badResult: { ok: false },
  },
  // Only the message and the href travel; the result says the system open was
  // dispatched, not that Obsidian showed anything.
  "knowledge.openReference": {
    params: {
      messageId: id,
      href: "obsidian://open?vault=Vault&file=Notes%2FPlan",
    },
    result: { opened: true as const },
    badParams: { messageId: id, href: "obsidian://open?vault=Vault&file=Plan", botId: id },
    badResult: { opened: false },
  },
} satisfies { [K in KnowledgeMethod]: Fixture<K> };

export const knowledgeEventCases = {
  "knowledge.changed": {
    payload: { id, reason: "added" as const } satisfies EventPayloads["knowledge.changed"],
    bad: { id, reason: "used" },
  },
};
