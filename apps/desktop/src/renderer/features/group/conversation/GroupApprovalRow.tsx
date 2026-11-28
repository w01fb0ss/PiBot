import type { ChatPeer } from "@pibot/client-core";
import type { Approval, Bot } from "@pibot/protocol";
import { BotAvatar, useT } from "@pibot/renderer-kit";
import { ApprovalCard } from "../../chat/tools/ApprovalCard.tsx";
import styles from "../group.module.css";

export function GroupApprovalRow({
  peer,
  approval,
  bot,
  groupName,
  refresh,
}: {
  peer: ChatPeer;
  approval: Approval;
  bot?: Bot;
  groupName: string;
  refresh(): Promise<void>;
}) {
  const t = useT();
  const name = bot?.name ?? t("group.member");
  return (
    <div className={styles.workingMessage} data-group-approval-id={approval.id} tabIndex={-1}>
      <BotAvatar bot={bot} unknown label={name} size={28} />
      <div className={styles.inlineApproval}>
        {approval.status === "pending" ? (
          <>
            <strong>{name}</strong>
            <ApprovalCard
              approval={approval}
              refresh={refresh}
              context={{ botName: name, groupName }}
              decide={async (id, decision, remember, preauthorize, rememberSecrets) => {
                await peer.call("approvals.resolve", {
                  id,
                  decision,
                  remember,
                  preauthorize,
                  rememberSecrets,
                  conversationId: approval.conversationId ?? undefined,
                });
              }}
            />
          </>
        ) : (
          <div role="status">
            <strong>{name}</strong>
            {` · ${t(approval.superseded ? "approval.superseded" : `approval.${approval.status}`)}`}
          </div>
        )}
      </div>
    </div>
  );
}
