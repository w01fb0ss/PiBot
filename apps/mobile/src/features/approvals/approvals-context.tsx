import { createContext, type ReactNode, useContext } from "react";
import { useHeldPlansState } from "./held-plans.ts";
import { useApprovalsState } from "./use-approvals.ts";

/** Pending approvals plus the group plans waiting for a choice: one copy for the tab, badge and list. */
function useInboxState() {
  const approvals = useApprovalsState();
  const held = useHeldPlansState();
  return { ...approvals, held, waiting: approvals.total + held.plans.length };
}

const Context = createContext<ReturnType<typeof useInboxState> | null>(null);
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useInboxState()}>{children}</Context.Provider>;
}
export function useApprovals() {
  const value = useContext(Context);
  if (!value) throw new Error("approvals_unavailable");
  return value;
}
