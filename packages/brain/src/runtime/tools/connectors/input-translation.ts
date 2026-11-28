import { createHash } from "node:crypto";
import {
  CONNECTOR_INPUT_LANGUAGE,
  type ConnectorCallInput,
  ConnectorInputLanguageSchema,
  type PreparedConnector,
} from "@pibot/protocol-base";
import { z } from "zod";
import { abortable } from "../../../core/abort.ts";
import type { ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";

const stringProperties = z.record(z.string(), z.unknown());
const englishStrings = z.array(z.string().trim().min(1).max(2_000));
const nonLatinLetter = /(?!\p{Script_Extensions=Latin})\p{Letter}/u;

interface FieldInput {
  field: string;
  text: string;
}

/** Session-scoped memoization, bounded across long-lived brain processes. */
export class ConnectorInputTranslations {
  private readonly sessions = new Map<string, Map<string, Promise<string | undefined>>>();

  get(
    session: string,
    inputs: FieldInput[],
    translate: (texts: string[]) => Promise<(string | undefined)[]>,
  ) {
    const cache = this.sessions.get(session) ?? new Map<string, Promise<string | undefined>>();
    this.sessions.delete(session);
    this.sessions.set(session, cache);
    if (this.sessions.size > 512) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    const missing: string[] = [];
    const batch = Promise.resolve().then(() => (missing.length ? translate(missing) : []));
    return Promise.all(
      inputs.map(({ field, text }) => {
        const key = createHash("sha256")
          .update(JSON.stringify([field, text]))
          .digest("hex");
        const cached = cache.get(key);
        const index = missing.length;
        const pending = cached ?? batch.then((results) => results[index]);
        if (!cached) missing.push(text);
        cache.set(key, pending);
        if (!cached) {
          const forget = () => {
            if (cache.get(key) === pending) cache.delete(key);
          };
          void pending.then((value) => {
            if (value === undefined) forget();
          }, forget);
        }
        return pending;
      }),
    );
  }
}

export async function translateConnectorInput(
  { context, local }: { context: ToolRunContext; local: LocalService },
  input: ConnectorCallInput,
  approved: PreparedConnector,
  signal: AbortSignal,
  fixedFields: readonly string[] = [],
) {
  if (!approved.translateImageInspirationQuery) return;
  const session = context.toolInputSession;
  const translate = local.deps.transformToolInput;
  const schema = approved.tool.schema;
  const fields = ConnectorInputLanguageSchema.safeParse(schema[CONNECTOR_INPUT_LANGUAGE]).data;
  if (!session || !translate || !fields) return;
  const properties = stringProperties.safeParse(schema.properties).data;
  if (!properties) return;
  const redactor = local.deps.redactor;
  const inputs: FieldInput[] = [];
  for (const field of Object.keys(fields)) {
    const property = Object.hasOwn(properties, field) ? properties[field] : undefined;
    const text = Object.hasOwn(input.args, field) ? input.args[field] : undefined;
    if (
      field === "query" &&
      !fixedFields.includes(field) &&
      property &&
      typeof property === "object" &&
      "type" in property &&
      property.type === "string" &&
      typeof text === "string" &&
      nonLatinLetter.test(text) &&
      redactor.redact(text) === text
    )
      inputs.push({ field, text });
  }
  if (!inputs.length) return;
  const deadline = AbortSignal.any([signal, context.signal, AbortSignal.timeout(8_000)]);
  const pending = local.connectorInputTranslations.get(session.id, inputs, async (texts) => {
    try {
      deadline.throwIfAborted();
      const result = await abortable(
        translate({
          kind: "tool_input_translation",
          model: session.model,
          language: "en",
          text: JSON.stringify(texts),
          signal: deadline,
          ...(context.executionClock
            ? { observer: local.budgets.observer(context, { optional: true }) }
            : {}),
        }),
        deadline,
      );
      const parsed = englishStrings.safeParse(JSON.parse(result));
      if (parsed.success && parsed.data.length === texts.length)
        return parsed.data.map((value) =>
          !nonLatinLetter.test(value) && redactor.redact(value) === value ? value : undefined,
        );
    } catch {
      // Provider or JSON errors can echo content. The diagnostic records only input length.
      local.deps.logger.warn(
        JSON.stringify({
          module: "connector-input-translation",
          inputLength: texts.reduce((length, value) => length + value.length, 0),
        }),
      );
    }
    return [];
  });
  const candidates = await abortable(pending, deadline).catch(() => {
    // The deadline releases dispatch even when the model has not returned yet.
    return [];
  });
  signal.throwIfAborted();
  context.signal.throwIfAborted();
  const args = { ...input.args };
  const translated: string[] = [];
  for (const [index, { field }] of inputs.entries()) {
    const candidate = candidates[index];
    if (!candidate || redactor.redact(candidate) !== candidate) continue;
    args[field] = candidate;
    translated.push(candidate);
  }
  if (translated.length) return { args, text: translated.join("\n") };
}
