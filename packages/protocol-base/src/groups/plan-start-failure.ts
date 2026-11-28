import { z } from "zod";
import { RpcError } from "../core/peer.ts";

/** Diagnostics are bounded facts, never source contents or an OS exception message. */
export const GroupPlanInputFailureSchema = z.strictObject({
  name: z.string().max(200),
  required: z.boolean().optional(),
  expected: z.string().max(4096),
  found: z.array(z.string().max(4096)).max(6),
});
export type GroupPlanInputFailure = z.infer<typeof GroupPlanInputFailureSchema>;

export const GroupPlanStartFailureSchema = z.strictObject({
  code: z.string().regex(/^[a-z_]{1,100}$/),
  input: GroupPlanInputFailureSchema.optional(),
  message: z.strictObject({ zh: z.string().max(1000), en: z.string().max(1000) }),
});
export type GroupPlanStartFailure = z.infer<typeof GroupPlanStartFailureSchema>;

/** In-process tool admission can carry facts without putting them in RpcError.message. */
export class GroupPlanInputError extends RpcError {
  readonly input: GroupPlanInputFailure;
  constructor(reason: string, input: GroupPlanInputFailure) {
    super(-32602, reason);
    this.input = GroupPlanInputFailureSchema.parse(input);
  }
}
