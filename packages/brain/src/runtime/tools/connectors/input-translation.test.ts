import {
  CONNECTOR_INPUT_LANGUAGE,
  DEFAULT_EXECUTION_LIMITS,
  type PreparedConnector,
} from "@pibot/protocol-base";
import { openDatabase, runMigrations } from "@pibot/storage";
import { describe, expect, it, vi } from "vitest";
import { BudgetService } from "../../queue/budget-service.ts";
import type { LocalRun } from "../local-run.ts";
import { dispatchReadConnector } from "./connector-tools.ts";
import { ConnectorInputTranslations, translateConnectorInput } from "./input-translation.ts";

function setup() {
  const controller = new AbortController();
  const model = { provider: "test", id: "main" };
  const observer = { beforeRequest: vi.fn(), settled: vi.fn() };
  const context = {
    signal: controller.signal,
    toolInputSession: { id: "session", model },
    executionClock: {},
  };
  const translate = vi.fn(async () => '["used books book swap warm"]');
  const warn = vi.fn();
  const redact = (text: string) => text.replaceAll("私密", "[redacted]");
  const run = {
    context,
    local: {
      deps: { redactor: { redact }, logger: { warn }, transformToolInput: translate },
      budgets: { observer: () => observer },
      connectorInputTranslations: new ConnectorInputTranslations(),
    },
  } as unknown as LocalRun;
  const target = {
    translateImageInspirationQuery: true,
    tool: {
      schema: {
        [CONNECTOR_INPUT_LANGUAGE]: { query: "en", count: "en" },
        properties: {
          query: { type: "string" },
          layout: { type: "string" },
          count: { type: "number" },
        },
      },
    },
  } as unknown as PreparedConnector;
  const input = {
    connectorId: "00000000-0000-4000-8000-000000000001",
    catalogVersion: 1,
    tool: "inspiration_search",
    args: { query: "旧书 交换 温暖", layout: "封面", count: 2 },
  };
  return { controller, context, input, target, translate, warn, observer, run, model };
}

describe("connector input translation", () => {
  it("translates a declared field once per session, including simultaneous requests", async () => {
    const { controller, context, input, target, translate, observer, run, model } = setup();
    const invoke = () => translateConnectorInput(run, input, target, controller.signal);
    const result = {
      args: { query: "used books book swap warm", layout: "封面", count: 2 },
      text: "used books book swap warm",
    };
    expect(await Promise.all([invoke(), invoke()])).toEqual([result, result]);
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model,
        observer,
        text: JSON.stringify([input.args.query]),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(input.args.query).toBe("旧书 交换 温暖");
    context.toolInputSession.id = "other-session";
    expect(await invoke()).toEqual(result);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("keeps all arguments unchanged for other connections, even if a catalog requests translation", async () => {
    const { controller, input, target, translate, run } = setup();
    delete target.translateImageInspirationQuery;
    expect(await translateConnectorInput(run, input, target, controller.signal)).toBeUndefined();
    expect(translate).not.toHaveBeenCalled();
  });

  it("only translates the inspiration query and preserves all other arguments", async () => {
    const { controller, input, target, translate, run } = setup();
    target.tool.schema[CONNECTOR_INPUT_LANGUAGE] = { query: "en", layout: "en", path: "en" };
    Object.assign(target.tool.schema.properties as object, { path: { type: "string" } });
    translate.mockResolvedValueOnce('["used books"]');
    const withPath = { ...input, args: { ...input.args, path: "私用/資料" } };
    const invoke = (call = withPath) =>
      translateConnectorInput(run, call, target, controller.signal, ["path"]);
    expect(await invoke()).toEqual({
      args: { query: "used books", layout: "封面", path: "私用/資料", count: 2 },
      text: "used books",
    });
    expect(translate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: '["旧书 交换 温暖"]' }),
    );
    const newLayout = { ...withPath, args: { ...withPath.args, layout: "海报" } };
    expect((await invoke(newLayout))?.args).toEqual({
      ...newLayout.args,
      query: "used books",
    });
    expect(translate).toHaveBeenCalledOnce();
  });

  it("retains a cached query when another session translates many inputs", async () => {
    const cache = new ConnectorInputTranslations();
    const translate = vi.fn(async (texts: string[]) => texts.map(() => "poster"));
    const first = [{ field: "query", text: "海报" }];
    await cache.get("first", first, translate);
    await cache.get(
      "second",
      Array.from({ length: 513 }, (_, i) => ({ field: "query", text: `插画 ${i}` })),
      translate,
    );
    expect(await cache.get("first", first, translate)).toEqual(["poster"]);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("preserves Latin input and skips registered secrets", async () => {
    const { controller, input, target, translate, run } = setup();
    for (const query of ["café poster", "私密", "🎨 123"]) {
      expect(
        await translateConnectorInput(
          run,
          { ...input, args: { query } },
          target,
          controller.signal,
        ),
      ).toBeUndefined();
    }
    expect(translate).not.toHaveBeenCalled();
  });

  it("falls back after a model failure, logs only the input length and retries later", async () => {
    const { controller, input, target, translate, warn, run } = setup();
    translate.mockRejectedValueOnce(new Error("provider echoed 旧书 交换 温暖"));
    expect(await translateConnectorInput(run, input, target, controller.signal)).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        module: "connector-input-translation",
        inputLength: input.args.query.length,
      }),
    );
    expect((await translateConnectorInput(run, input, target, controller.signal))?.args.query).toBe(
      "used books book swap warm",
    );
  });

  it("translates other non-Latin scripts and rejects a secret from the model", async () => {
    const { controller, input, target, translate, run } = setup();
    translate.mockResolvedValueOnce('["private 私密"]');
    expect(
      await translateConnectorInput(
        run,
        { ...input, args: { query: "книги" } },
        target,
        controller.signal,
      ),
    ).toBeUndefined();
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { costUsd: null, estimate: undefined, usage: undefined, requests: 1, unknown: 1 },
    { costUsd: 1, estimate: undefined, usage: undefined, requests: 0, unknown: 0 },
    { costUsd: 1, estimate: 1.1, usage: undefined, requests: 0, unknown: 0 },
    { costUsd: 1, estimate: 0.01, usage: { tokens: 5, costUsd: 0.001 }, requests: 1, unknown: 0 },
  ])(
    "dispatches the original after optional translation is unavailable (cap $costUsd, estimate $estimate)",
    async ({ costUsd, estimate, usage, requests, unknown }) => {
      const db = openDatabase(":memory:");
      runMigrations(db);
      // This test only exercises the budget and dispatch paths, with no persisted chat.
      db.exec("PRAGMA foreign_keys = OFF");
      const abortTree = vi.fn();
      const budgets = new BudgetService({
        db,
        changed: vi.fn(),
        warning: vi.fn(),
        redact: (value) => value,
      });
      budgets.abortTree = abortTree;
      try {
        const { controller, input, target, run } = setup();
        run.context.runId = "00000000-0000-4000-8000-000000000002";
        run.context.language = "en";
        run.context.capabilities = new Map();
        budgets.begin(run.context, { ...DEFAULT_EXECUTION_LIMITS, costUsd });
        Object.assign(run.local, { budgets });
        const provider = vi.fn();
        run.local.deps.transformToolInput = async (request) => {
          if (request.kind !== "tool_input_translation") throw new Error("unexpected purpose");
          const id = "provider-request";
          request.observer?.beforeRequest({
            id,
            kind: "auxiliary",
            model: "main",
            provider: "test",
            pricingKnown: true,
            ...(estimate === undefined ? {} : { estimatedCostUsd: estimate }),
          });
          provider();
          request.observer?.settled({ id, complete: usage !== undefined, usage });
          throw new Error("translation unavailable");
        };
        Object.assign(target, { connector: { id: input.connectorId }, access: {}, secretUses: [] });
        Object.assign(target.tool, { tool: input.tool, readOnly: true });
        const dispatch = vi.fn(async () => {
          budgets.assert(run.context);
          return { items: [] };
        });
        Object.assign(run.local, {
          connectors: { dispatch },
          approvals: { audit: { append: vi.fn() } },
          drafts: { calendars: { observe: vi.fn() } },
        });
        const recordInputTranslation = vi.fn();
        await dispatchReadConnector(
          {
            local: run.local,
            context: run.context,
            assertDispatch: vi.fn(),
            recordInputTranslation,
          },
          { call: { id: "call", tool: "connector_call", input }, explanation: [] },
          input,
          target,
          controller.signal,
        );
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
          run.context.botId,
          input,
          target,
          expect.any(AbortSignal),
          expect.any(Function),
          undefined,
        );
        expect(provider).toHaveBeenCalledTimes(requests);
        expect(budgets.repo.get(run.context.runId)).toMatchObject({
          exhaustedReason: null,
          requests,
          unknownCostRequests: unknown,
          knownCostUsd: usage?.costUsd ?? 0,
        });
        expect(abortTree).not.toHaveBeenCalled();
        expect(recordInputTranslation).not.toHaveBeenCalled();
      } finally {
        await budgets.dispose();
        db.close();
      }
    },
  );
});
