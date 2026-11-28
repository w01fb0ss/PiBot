import { approvalCountdown, approvalDeadline } from "@pibot/client-core";
import type { Approval } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { useSharedText, useText } from "../../runtime/context.tsx";

export function useApprovalDeadline(approval: Approval) {
  const t = useSharedText();
  const mobileText = useText();
  const [now, setNow] = useState(Date.now);
  const deadline = approvalDeadline(approval, now);
  const counting = deadline.remaining > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);
  const time = approvalCountdown(deadline.remaining);
  const label = !counting
    ? t(deadline.paused ? "approval.paused" : "approval.awaitingExpiry")
    : approval.draft
      ? mobileText("draftExpiry", { time })
      : t(deadline.pauses ? "approval.chatCountdown" : "approval.countdown", { time });
  return { ...deadline, label };
}
