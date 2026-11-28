import { effectiveLevel } from "@pibot/policy";
import {
  ConnectorCallError,
  ConnectorNetworkBlockedError,
  DraftContentSchema,
  type DraftResolve,
  type DraftView,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { type DraftPayload, type DraftsRepo, transaction } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import { capabilitySelectionMatches } from "../../runtime/tools/connectors/capability-adapter.ts";
import { ConnectorSchemaError } from "../../runtime/tools/connectors/connector-schema.ts";
import {
  type ConnectorCallInput,
  ConnectorToolError,
  type PreparedConnector,
} from "../../runtime/tools/connectors/connector-tools.ts";
import { connectorNetworkApproval } from "../../runtime/tools/connectors/network-approval.ts";
import { automaticDraftAllowed, evaluateDraft } from "./draft-authorization.ts";
import { contentDigest, fail, snapshot } from "./draft-content.ts";
import { connectionToolRememberable, rememberConnectionTool } from "./draft-tool-grants.ts";

interface DraftResolution {
  local: LocalService;
  repo: DraftsRepo;
  context(view: DraftView, payload: DraftPayload): ToolRunContext;
  expire(id: string): void;
  cancel(id: string): void;
  changed(id: string): void;
  audit(id: string, phase: string, actor?: "user" | "automatic" | "system"): void;
  /** The service's reply to a send, for the waiting tool call to hand to the Bot. */
  sent?(id: string, reply: unknown): void;
  /** Only the waiting tool call reads the reason. */
  failed?(id: string, error: ConnectorCallError): void;
}
/** Claim once, revalidate current authority at transport dispatch, then persist the real outcome. */
export async function resolveDraft(
  deps: DraftResolution,
  input: DraftResolve,
  actor: "user" | "automatic",
  options: {
    /** Only the automatic send right after this same call's "ask every time" card was answered. */
    confirmedNow?: boolean;
    desktopSend?: boolean;
  } = {},
) {
  const { confirmedNow = false, desktopSend = false } = options;
  await deps.local.userSecrets.ready(deps.local.shutdown.signal);
  const current = deps.repo.get(input.approvalId);
  if (!current) return fail("draftUnavailable", "draft_unavailable");
  const { view, payload } = current;
  if (view.status === "expired") return fail("draftExpired", "draft_expired");
  if (view.status !== "pending") return fail("draftResolved", "draft_already_resolved");
  if (Date.parse(view.expiresAt) <= Date.now()) {
    deps.expire(view.approvalId);
    return fail("draftExpired", "draft_expired");
  }
  if (input.action === "discard") {
    transaction(deps.local.deps.db, () => {
      deps.repo.claim(view.approvalId, "discard", payload.content, view.draft.contentDigest, false);
      deps.local.approvals.repo.resolve(view.approvalId, "denied", false, [
        ...(deps.local.approvals.repo.get(view.approvalId)?.explanation ?? []),
        {
          axis: "grant",
          code: "approval_user_denied",
          effect: "deny",
        },
      ]);
      deps.audit(view.approvalId, "discarded", actor);
    });
    deps.changed(view.approvalId);
    deps.local.deps.peer.emit("approval.resolved", {
      id: view.approvalId,
      status: "denied",
      remembered: false,
    });
    return { ok: true as const, status: "discarded" as const };
  }
  if (input.content !== undefined && !view.draft.editable)
    return fail("draftContentInvalid", "draft_not_editable");
  if (
    input.rememberTool &&
    (view.draft.identity === "user" ||
      actor !== "user" ||
      !view.draft.canRememberTool ||
      !connectionToolRememberable(deps.local, view.draft.connectorId))
  )
    return fail("draftDenied", "tool_cannot_be_remembered");
  if (input.rememberTarget && !view.draft.canRememberTarget)
    return fail("draftDenied", "target_cannot_be_remembered");
  const content = input.content ?? payload.content;
  if (
    !DraftContentSchema.safeParse(content).success ||
    deps.local.deps.redactor.redact(content) !== content
  )
    return fail("draftContentInvalid", "draft_content_invalid");
  let context: ToolRunContext;
  try {
    context = deps.context(view, payload);
  } catch (error) {
    deps.cancel(view.approvalId);
    throw error;
  }
  if (
    payload.capabilityId &&
    !capabilitySelectionMatches(context, payload.capabilityId, view.draft.connectorId)
  ) {
    deps.cancel(view.approvalId);
    return fail("draftChanged", "draft_capability_changed");
  }
  const signal = AbortSignal.any([
    context.signal,
    deps.local.shutdown.signal,
    AbortSignal.timeout(30_000),
  ]);
  if (context.routineRunId) {
    const owner = deps.local.unattended;
    if (!owner) return fail("draftUnavailable", "draft_routine_unavailable");
    const run = owner.run(context.routineRunId);
    if (run.waitCheckpoint?.drain) {
      try {
        await owner.verifyWaiting(run.id, signal);
      } catch {
        deps.cancel(view.approvalId);
        return fail("draftChanged", "draft_source_changed");
      }
    }
  }
  if (input.rememberTarget && context.routineRunId) {
    if (!deps.local.unattended) return fail("draftUnavailable", "draft_routine_unavailable");
    const run = deps.local.unattended.run(context.routineRunId);
    if (
      !run.routineId ||
      run.reason === "trial" ||
      run.waitCheckpoint?.approvalId !== view.approvalId
    )
      return fail("draftDenied", "target_cannot_be_remembered");
  }
  const result = await evaluateDraft(
    deps.local,
    context,
    view.draft,
    payload,
    signal,
    actor === "automatic" && confirmedNow,
  );
  if (result.decision === "deny" || (actor === "automatic" && result.decision !== "allow")) {
    deps.cancel(view.approvalId);
    return fail("draftDenied", "send_permission_denied");
  }
  const args =
    payload.contentField === null
      ? payload.args
      : { ...payload.args, [payload.contentField]: content };
  const call: ConnectorCallInput = {
    connectorId: view.draft.connectorId,
    catalogVersion: view.draft.catalogVersion,
    tool: view.draft.tool,
    args,
  };
  const service = deps.local.connectors;
  if (!service) return fail("draftUnavailable", "connector_unavailable");
  let prepared: PreparedConnector;
  try {
    prepared = service.resolveTool(view.botId, call, context.permissionGroupId ?? payload.groupId);
    if (snapshot(prepared) !== payload.snapshotDigest)
      return fail("draftChanged", "draft_connector_changed");
  } catch (error) {
    if (error instanceof ConnectorSchemaError && error.code === "connector_args_invalid")
      return fail("draftContentInvalid", "draft_content_invalid");
    if (error instanceof RpcError) throw error;
    return fail("draftChanged", "draft_connector_changed");
  }
  // The only async work before claiming is permission evaluation; re-check current expiry here.
  if (Date.parse(view.expiresAt) <= Date.now()) {
    deps.expire(view.approvalId);
    return fail("draftExpired", "draft_expired");
  }
  transaction(deps.local.deps.db, () => {
    deps.repo.claim(
      view.approvalId,
      "send",
      content,
      contentDigest(content),
      content !== payload.content,
    );
    deps.audit(view.approvalId, "sending", actor);
  });
  deps.changed(view.approvalId);
  const authorize = () => {
    if (deps.repo.get(view.approvalId)?.view.status !== "sending")
      return fail("draftResolved", "draft_already_resolved");
    if (Date.parse(view.expiresAt) <= Date.now()) return fail("draftExpired", "draft_expired");
    const currentContext = deps.context(view, payload);
    if (
      payload.capabilityId &&
      !capabilitySelectionMatches(currentContext, payload.capabilityId, view.draft.connectorId)
    )
      return fail("draftChanged", "draft_capability_changed");
    const permissions = deps.local.tasks.settings(
      currentContext,
      runPermissions(deps.local, currentContext),
    );
    if (
      effectiveLevel(permissions.levels.send_out, undefined) === "never" ||
      effectiveLevel(permissions.levels.connector, undefined) === "never"
    )
      return fail("draftDenied", "send_permission_denied");
    if (
      actor === "automatic" &&
      !automaticDraftAllowed(deps.local, currentContext, view.draft, result, confirmedNow)
    )
      return fail("draftDenied", "send_permission_changed");
    if (deps.local.deps.redactor.contains(args).length > 0)
      return fail("draftContentInvalid", "draft_content_invalid");
  };
  try {
    const reply = await abortable(
      service.dispatchDraft(
        view.approvalId,
        view.botId,
        call,
        prepared,
        signal,
        authorize,
        connectorNetworkApproval(
          deps.local,
          context,
          {
            id: deps.local.approvals.repo.get(view.approvalId)?.toolCallId ?? view.approvalId,
            tool: "connector_call",
          },
          authorize,
          actor === "user" && desktopSend,
        ),
      ),
      signal,
    );
    let toolRemembered = false;
    let canRemember = input.rememberTarget === true;
    if (canRemember) {
      try {
        const current = deps.context(view, payload);
        const levels = deps.local.tasks.settings(
          current,
          runPermissions(deps.local, current),
        ).levels;
        canRemember = levels.connector !== "never" && levels.send_out !== "never";
      } catch {
        canRemember = false;
      }
    }
    transaction(deps.local.deps.db, () => {
      if (input.rememberTool)
        toolRemembered = rememberConnectionTool(
          deps.local,
          () => deps.context(view, payload),
          view,
          payload,
          call,
        );
      deps.repo.finish(view.approvalId, "sent");
      deps.local.approvals.repo.resolve(view.approvalId, "allowed", toolRemembered, [
        ...result.explanation,
        {
          axis: "grant",
          code: actor === "automatic" ? "draft_automatic_authorized" : "approval_user_allowed",
          effect: "allow",
        },
      ]);
      if (canRemember && result.canRemember && result.grantScope && context.routineRunId) {
        const owner = deps.local.unattended;
        const run = owner?.run(context.routineRunId);
        if (!owner || !run?.routineId || run.reason === "trial" || !run.waitCheckpoint)
          return fail("draftDenied", "target_cannot_be_remembered");
        owner.addPreauth(
          run.routineId,
          { category: "send_out", scope: result.grantScope },
          run.waitCheckpoint.workspaceSnapshot,
        );
      } else if (canRemember && result.canRemember && result.grantScope)
        deps.local.approvals.grants.create({
          botId: view.botId,
          category: "send_out",
          scope: result.grantScope,
          ...((context.permissionGroupId ?? payload.groupId)
            ? { groupId: context.permissionGroupId ?? payload.groupId }
            : {}),
        });
      deps.audit(view.approvalId, "sent", actor);
    });
    // Before anything can wake the waiting call, so it finds the reply when it reads the receipt.
    deps.sent?.(view.approvalId, reply);
    deps.local.deps.peer.emit("approval.resolved", {
      id: view.approvalId,
      status: "allowed",
      remembered: canRemember || toolRemembered,
    });
    deps.changed(view.approvalId);
    return { ok: true as const, status: "sent" as const };
  } catch (error) {
    // Even an abort after transport dispatch may have reached the remote service.
    if (error instanceof ConnectorNetworkBlockedError) deps.failed?.(view.approvalId, error);
    if (
      error instanceof RpcError &&
      error.code <= RpcErrorCodes.draftUnavailable &&
      error.code >= RpcErrorCodes.draftExecutionFailed
    ) {
      deps.repo.finish(view.approvalId, "failed");
      deps.local.approvals.repo.resolve(view.approvalId, "denied", false, [
        ...(deps.local.approvals.repo.get(view.approvalId)?.explanation ?? []),
        {
          axis: "grant",
          code: "changed",
          effect: "deny",
        },
      ]);
      deps.audit(view.approvalId, "failed", actor);
      deps.changed(view.approvalId);
      throw error;
    }
    if (error instanceof ConnectorCallError && error.outcome === "failed") {
      transaction(deps.local.deps.db, () => {
        deps.repo.finish(view.approvalId, "failed");
        deps.local.approvals.repo.resolve(view.approvalId, "denied", false, [
          ...(deps.local.approvals.repo.get(view.approvalId)?.explanation ?? []),
          {
            axis: "grant",
            code: "changed",
            effect: "deny",
          },
        ]);
        deps.audit(view.approvalId, "failed", actor);
      });
      if (error.serviceMessage) deps.failed?.(view.approvalId, error);
      deps.local.deps.peer.emit("approval.resolved", {
        id: view.approvalId,
        status: "denied",
        remembered: false,
      });
      deps.changed(view.approvalId);
      return fail("draftExecutionFailed", "draft_execution_failed");
    }
    if (error instanceof ConnectorToolError && error.code === "connector_catalog_changed") {
      deps.repo.finish(view.approvalId, "failed");
      deps.local.approvals.repo.resolve(view.approvalId, "denied", false, [
        ...(deps.local.approvals.repo.get(view.approvalId)?.explanation ?? []),
        {
          axis: "grant",
          code: "changed",
          effect: "deny",
        },
      ]);
      deps.audit(view.approvalId, "failed", actor);
      deps.changed(view.approvalId);
      return fail("draftChanged", "draft_connector_changed");
    }
    deps.repo.finish(view.approvalId, "unknown");
    deps.local.approvals.repo.resolve(view.approvalId, "allowed", false, [
      ...result.explanation,
      {
        axis: "grant",
        code: actor === "automatic" ? "draft_automatic_authorized" : "approval_user_allowed",
        effect: "allow",
      },
    ]);
    deps.audit(view.approvalId, "unknown", actor);
    deps.local.deps.peer.emit("approval.resolved", {
      id: view.approvalId,
      status: "allowed",
      remembered: false,
    });
    deps.changed(view.approvalId);
    return fail("draftExecutionFailed", "draft_execution_uncertain");
  }
}
