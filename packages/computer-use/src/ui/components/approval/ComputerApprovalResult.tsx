import { approvalExplanation } from "@pibot/client-core";
import type {
  Approval,
  ComputerApprovalRequest,
  ComputerGrantDuration,
} from "@pibot/computer-use-contract/full";
import { ApprovalExplanation, approvalStyles, useRpc, useT } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";

type Request = ComputerApprovalRequest;

/** Settled card: what was allowed, read back from the run's grants (the approval row has no choices). */
export function ComputerApprovalResult({
  approval,
  request,
}: {
  approval: Approval;
  request: Request;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [grant, setGrant] = useState<
    { apps: string[]; duration: ComputerGrantDuration; allowCoordinates: boolean } | undefined
  >();
  useEffect(() => {
    if (!peer || approval.status !== "allowed") return;
    let active = true;
    peer
      .call("computer.grants", { runId: approval.runId, limit: 50 })
      .then((grants) => {
        const after = Date.parse(approval.createdAt);
        const match = grants
          .filter((g) => Date.parse(g.createdAt) >= after)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (active && match) setGrant(match);
      })
      .catch(() => {
        // Falls back to the plain "you allowed this" line.
      });
    return () => {
      active = false;
    };
  }, [peer, approval.status, approval.runId, approval.createdAt]);
  // A paused card closed after the conversation moved on reads the same as every other card.
  if (approval.superseded)
    return (
      <div className={approvalStyles.result} role="status">
        {t("approval.superseded")}
      </div>
    );
  if (approval.status === "denied")
    return (
      <div className={approvalStyles.result} role="status">
        {t("computerUse.result.denied")}
        <ApprovalExplanation {...approvalExplanation(approval, t)} />
      </div>
    );
  if (approval.status !== "allowed")
    return (
      <div className={approvalStyles.result} role="status">
        {t(`approval.${approval.status}`)}
        <ApprovalExplanation {...approvalExplanation(approval, t)} />
      </div>
    );
  const names = new Map(request.apps.map((app) => [app.id.toLowerCase(), app.name]));
  const parts = grant
    ? [
        grant.apps
          .map((id) => names.get(id.toLowerCase()) ?? id)
          .join(t("computerUse.listSeparator")),
        t(`computerUse.result.${grant.duration}`),
        ...(grant.allowCoordinates ? [t("computerUse.card.coordinates")] : []),
      ]
    : [];
  return (
    <div className={approvalStyles.success} role="status">
      {[t("approval.allowed"), ...parts].join(" · ")}
      <ApprovalExplanation {...approvalExplanation(approval, t)} />
    </div>
  );
}
