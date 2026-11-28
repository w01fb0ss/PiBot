import { z } from "zod";

const optionId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const UserQuestionSchema = z
  .strictObject({
    prompt: z.string().trim().min(1).max(500),
    options: z
      .array(
        z.strictObject({
          id: optionId,
          label: z.string().trim().min(1).max(100),
          description: z.string().trim().min(1).max(500),
        }),
      )
      .min(2)
      .max(4),
    recommendedId: optionId,
  })
  .refine(
    (question) =>
      new Set(question.options.map((option) => option.id)).size === question.options.length &&
      question.options.every((option) => option.id !== "custom") &&
      question.options.some((option) => option.id === question.recommendedId),
  );
export const UserQuestionReplySchema = z.union([
  z.strictObject({ optionId }),
  z.strictObject({ custom: z.string().trim().min(1).max(2000) }),
]);
export const UserQuestionPauseSchema = z.strictObject({
  reason: z.literal("needs_user"),
  summary: z.string().max(500),
  question: UserQuestionSchema,
  sourceMessageId: z.uuid().optional(),
  /** Program-owned decisions cannot be replaced by free-form answers. */
  fixedOptions: z.boolean().optional(),
  answer: z
    .strictObject({
      text: z.string().max(4000),
      optionId: optionId.optional(),
      answeredAt: z.iso.datetime(),
    })
    .optional(),
});
export type UserQuestion = z.infer<typeof UserQuestionSchema>;

const QuestionAnswerTextSchema = UserQuestionPauseSchema.shape.answer.unwrap().shape.text;

export function messageQuestionAnswerText(message: { usage: unknown }): string | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const answer = QuestionAnswerTextSchema.safeParse(
    (usage as Record<string, unknown>).questionAnswerText,
  );
  return answer.success ? answer.data : undefined;
}
