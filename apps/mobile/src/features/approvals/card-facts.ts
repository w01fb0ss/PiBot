import { approvalFactText, approvalText, systemServiceLabel } from "@pibot/client-core";
import { type Approval, isPiManagerCategory } from "@pibot/protocol";
import type { useLanguage, useSharedText } from "../../runtime/context.tsx";
import type { IconName } from "../../ui/icons.tsx";

/** The desktop approval card's header mark: danger, web, file, connector or command. */
export function approvalIcon(approval: Approval): IconName {
  if (approval.risk === "danger") return "warning";
  if (approval.category === "web") return "globe";
  if (["write_file", "read_file", "list_dir"].includes(approval.category)) return "file";
  return approval.category === "connector" ? "link" : "terminal";
}
/** What the request acts on, for the monospace block: the command or URL, else the first fact. */
export function approvalTarget(
  approval: Approval,
  language: ReturnType<typeof useLanguage>,
  shared: ReturnType<typeof useSharedText>,
) {
  // Pi's cards list each change as a labelled row; a target block would repeat the first one.
  if (isPiManagerApproval(approval)) return undefined;
  if (approval.command) return approval.command;
  if (approval.url) return approval.url;
  const fact = approvalText(approval, language).facts[0];
  if (!fact) return undefined;
  if (
    fact.kind === "network" &&
    approval.explanation?.some((step) => step.code === "system_service_once")
  )
    return systemServiceLabel(fact.value, shared);
  return approvalFactText(fact, shared);
}

/** The default Pi's management, hand-off and repair cards: a lead line and labelled rows. */
export function isPiManagerApproval(approval: Approval) {
  return isPiManagerCategory(approval.category);
}

export function isSecuritySettingsApproval(approval: Approval) {
  return (
    approval.category === "settings_change" &&
    (approval.explanation?.some((step) => step.code === "settings_security_confirm") ?? false)
  );
}

/** "Don't ask again" on Pi's cards sets Pi's own level for that kind to always. */
export function piRememberText(approval: Approval, shared: ReturnType<typeof useSharedText>) {
  const category = isPiManagerCategory(approval.category) ? approval.category : "bot_management";
  return shared(`approval.piRemember.${category}`);
}
/** The card's lead sentence in the reader's language (only Pi's cards have one). */
export function approvalLead(approval: Approval, language: ReturnType<typeof useLanguage>) {
  const text = approvalText(approval, language);
  return "lead" in text ? text.lead : undefined;
}
