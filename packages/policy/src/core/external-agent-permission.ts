export const EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED = "external_agent_explicit_always_required";

/** Pi Bot can answer an external agent's request with consent for the current action only. */
export function externalAgentPermissionDenial(
  options: readonly { kind: string; optionId: string }[],
) {
  if (new Set(options.map(({ optionId }) => optionId)).size !== options.length)
    return "external_agent_ambiguous_options";
  if (options.some(({ kind }) => kind === "allow_once")) return;
  return options.some(({ kind }) => kind === "allow_always")
    ? EXTERNAL_AGENT_EXPLICIT_ALWAYS_REQUIRED
    : "external_agent_no_allow_option";
}
