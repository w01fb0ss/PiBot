import { constants } from "node:fs";
import { access, opendir, stat } from "node:fs/promises";
import type { SkillProvenance } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import {
  AbsolutePathSchema,
  RpcError,
  RpcErrorCodes,
  type SkillContract,
  type SkillDocument,
  type WorkflowInput,
  type WorkflowPrecheckFailure,
} from "@pibot/protocol-base";
import { abortable } from "../../core/abort.ts";
import { skillContract } from "../../resources/packages/skill-format.ts";
import type { WorkspaceFileAccess } from "../../resources/workplaces/workspace-files.ts";

/**
 * One run of a workflow skill as the run engine carries it (QueueInput → ChatRun). Built
 * by `prepareWorkflow` after the program's pre-checks passed; trusted, never taken from the model.
 */
export interface WorkflowRun {
  skillId: string;
  /** Display name of the skill (the workflow's name in the chat and receipt). */
  name: string;
  version: number | null;
  /**
   * Skill body, shown from the run's first request so the model does not spend a turn reading
   * it. SEC: in a reference message (`workflowSkillText`), never the system prompt.
   */
  body: string;
  /** SEC: missing (a caller that did not say) is treated as imported, the stricter fence. */
  provenance?: SkillProvenance;
  /** Folder holding SKILL.md (relative script / template paths in the body resolve from it). */
  baseDir?: string;
  contract: SkillContract;
  params: { name: string; value: string }[];
  /** Folder / file / text inputs the user gave; `previous` inputs are filled in by the program. */
  inputs: { name: string; kind: Exclude<WorkflowInput["kind"], "previous">; value: string }[];
  /**
   * This period's artifact folder when the caller already knows it (a routine's period folder);
   * otherwise the run engine picks one under the primary folder.
   */
  folder?: string;
  /** A routine's ledger already lists the previous period; the engine does not look for one. */
  previousFromLedger?: boolean;
  /**
   * The previous period an earlier run of this workflow already found, carried with a
   * fixed `folder` to the coordinator's sign-off run of a group hand-off.
   */
  previous?: { folder: string; files: string[] };
  /** Brain-validated concrete owner for each group DAG step. */
  stepOwners?: { stepId: string; botId: string }[];
}

export interface WorkflowSkill {
  id: string;
  document: SkillDocument;
  baseDir?: string;
  /** SEC: where the skill's text came from; the run fences an imported body as such. */
  provenance?: SkillProvenance;
}

export type PreparedWorkflow =
  | { ok: true; workflow: WorkflowRun }
  | { ok: false; failures: WorkflowPrecheckFailure[] };

const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);
// Each path check is a stat or the first directory entry; a stuck network drive must not hold
// the request (the whole RPC also has its own deadline).
const CHECK_MS = 5_000;

/**
 * Validates a run request against the skill's contract and runs the program-judged pre-checks
 * (①) before any model is involved: required inputs present, folder / file inputs exist
 * (and are non-empty where the contract says so). Failures come back as a list for the form; the
 * caller must not start a run. Malformed requests (unknown names, no contract) throw.
 */
export async function prepareWorkflow(
  skill: WorkflowSkill,
  request: {
    params: Record<string, string>;
    inputs: Record<string, string>;
    /** The user's lower cost cap for this run; never above the contract's. */
    costCapUsd?: number;
  },
  signal: AbortSignal,
  files?: WorkspaceFileAccess,
  logger?: Pick<Logger, "warn">,
): Promise<PreparedWorkflow> {
  const { contract: declaredContract } = skillContract(skill.document);
  if (!skill.document.contract) throw invalid("workflow_not_contract");
  if (!declaredContract) throw invalid("workflow_contract_invalid");
  const contract = withCostCap(declaredContract, request.costCapUsd);
  const declared = new Map(contract.inputs.map((input) => [input.name, input]));
  for (const name of Object.keys(request.inputs))
    if (!declared.has(name) || declared.get(name)?.kind === "previous")
      throw invalid("workflow_input_unknown");
  const params = new Map(skill.document.params.map((param) => [param.name, param]));
  for (const name of Object.keys(request.params))
    if (!params.has(name)) throw invalid("workflow_param_unknown");

  const { inputs, failures } = await checkWorkflowInputs(
    contract,
    request.inputs,
    signal,
    files,
    logger,
  );
  if (failures.length) return { ok: false, failures };
  return {
    ok: true,
    workflow: {
      skillId: skill.id,
      name: skill.document.name,
      version: skill.document.version ?? null,
      body: skill.document.body,
      ...(skill.provenance ? { provenance: skill.provenance } : {}),
      ...(skill.baseDir ? { baseDir: skill.baseDir } : {}),
      contract,
      params: skill.document.params.map((param) => ({
        name: param.name,
        value: request.params[param.name]?.trim() || param.default || "",
      })),
      inputs,
    },
  };
}

/** Shared by workflow runs and dynamic methods; input binding never grants tool permissions. */
export async function checkWorkflowInputs(
  contract: Pick<SkillContract, "inputs" | "prechecks">,
  values: Readonly<Record<string, string>>,
  signal: AbortSignal,
  files?: WorkspaceFileAccess,
  logger?: Pick<Logger, "warn">,
): Promise<{ inputs: WorkflowRun["inputs"]; failures: WorkflowPrecheckFailure[] }> {
  const failures: WorkflowPrecheckFailure[] = [];
  const inputs: WorkflowRun["inputs"] = [];
  const nonEmpty = new Set(
    contract.prechecks.flatMap((rule) =>
      typeof rule !== "string" && rule.check === "nonEmpty" ? [rule.input] : [],
    ),
  );
  for (const input of contract.inputs) {
    signal.throwIfAborted();
    if (input.kind === "previous") continue;
    const value = values[input.name]?.trim() ?? "";
    const needsContent = nonEmpty.has(input.name);
    if (!value) {
      if (input.required || (input.kind === "text" && needsContent))
        failures.push({ input: input.name, reason: "required" });
      continue;
    }
    if (input.kind === "text") {
      inputs.push({ name: input.name, kind: "text", value });
      continue;
    }
    if (!AbsolutePathSchema.safeParse(value).success) {
      failures.push({ input: input.name, reason: "invalid" });
      continue;
    }
    // A supplied optional path that has disappeared is the same as no supplied value.
    let reason: WorkflowPrecheckFailure["reason"] | undefined;
    try {
      reason = files?.remote
        ? await remoteCheck(value, input.kind, needsContent, signal, files, !input.required)
        : await checkPath(value, input.kind, needsContent, signal, !input.required);
    } catch (error) {
      signal.throwIfAborted();
      if (!input.required && omitUnavailableWorkflowInput(error, logger)) continue;
      throw error;
    }
    if (reason === "missing" && !input.required) continue;
    if (reason) failures.push({ input: input.name, reason });
    else inputs.push({ name: input.name, kind: input.kind, value });
  }
  return { inputs, failures };
}

/** Log only allowlisted codes. OS error messages can include private paths. */
export function omitUnavailableWorkflowInput(error: unknown, logger?: Pick<Logger, "warn">) {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "file_not_found" ||
    code === "file_not_directory" ||
    (error instanceof RpcError && error.message === "workspace_path_missing")
  )
    return true;
  if (code !== "EACCES" && code !== "EPERM" && code !== "file_access_denied") return false;
  logger?.warn(
    JSON.stringify({ module: "workflow", event: "optional_input_omitted", reasonCode: code }),
  );
  return true;
}

/**
 * A declared contract cost cap is the ceiling; without one a run may set its own. It travels
 * in the run's contract, so it also reaches the recovery identity (a resume never gets more).
 */
function withCostCap(contract: SkillContract, cap: number | undefined): SkillContract {
  if (cap === undefined) return contract;
  const ceiling = contract.budget?.costUsd;
  if (ceiling !== undefined && cap > ceiling) throw invalid("workflow_budget_above_contract");
  return { ...contract, budget: { ...contract.budget, costUsd: cap } };
}

async function checkPath(
  path: string,
  kind: "folder" | "file",
  nonEmpty: boolean,
  parent: AbortSignal,
  optional: boolean,
): Promise<WorkflowPrecheckFailure["reason"] | undefined> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(CHECK_MS)]);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await abortable(stat(path), signal);
  } catch (error) {
    parent.throwIfAborted();
    if (signal.aborted) return optional ? "invalid" : "missing";
    const code = (error as NodeJS.ErrnoException).code;
    if (optional && omitUnavailableWorkflowInput(error)) throw error;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "invalid";
  }
  if (kind === "folder" && !info.isDirectory()) return "not_folder";
  if (kind === "file" && !info.isFile()) return "not_file";
  if (optional) {
    try {
      await abortable(
        access(path, constants.R_OK | (kind === "folder" ? constants.X_OK : 0)),
        signal,
      );
    } catch (error) {
      parent.throwIfAborted();
      if (!signal.aborted && omitUnavailableWorkflowInput(error)) throw error;
      return "invalid";
    }
  }
  if (!nonEmpty) return undefined;
  if (kind === "file") return info.size > 0 ? undefined : "empty";
  const found = await hasEntry(path, signal, optional);
  parent.throwIfAborted();
  return found ? undefined : "empty";
}

/** True once one visible entry is found; hidden files (.DS_Store, desktop.ini-like) do not count. */
async function hasEntry(path: string, signal: AbortSignal, optional: boolean): Promise<boolean> {
  let dir: Awaited<ReturnType<typeof opendir>> | undefined;
  const opened = opendir(path);
  try {
    dir = await abortable(opened, signal);
    for (let i = 0; i < 1000; i++) {
      const entry = await abortable(dir.read(), signal);
      if (!entry) return false;
      if (!entry.name.startsWith(".") && entry.name.toLowerCase() !== "desktop.ini") return true;
    }
    return true;
  } catch (error) {
    if (optional && omitUnavailableWorkflowInput(error)) throw error;
    // Unreadable or too slow to list counts as empty; the caller rechecks its own cancellation.
    return false;
  } finally {
    if (dir) await dir.close().catch(() => undefined);
    else if (signal.aborted) {
      // A directory opened after the deadline still belongs to this check.
      void opened.then((pending) => pending.close()).catch(() => undefined);
    }
  }
}

async function remoteCheck(
  path: string,
  kind: "file" | "folder",
  nonEmpty: boolean,
  signal: AbortSignal,
  files: WorkspaceFileAccess,
  optional: boolean,
): Promise<WorkflowPrecheckFailure["reason"] | undefined> {
  if (!files.paths.isAbsolute(path)) return "invalid";
  const info = await files.inspect(path, signal);
  if (!info) return "missing";
  if (kind === "folder" && info.kind !== "directory") return "not_folder";
  if (kind === "file" && (info.kind !== "file" || info.links !== "1")) return "not_file";
  if (!nonEmpty) {
    if (optional && kind === "folder") await files.page(path, signal, 0, info.version, 1);
    return;
  }
  if (kind === "file") return info.size ? undefined : "empty";
  return (await files.entries(path, signal)).some(
    (e) => !e.name.startsWith(".") && e.name.toLowerCase() !== "desktop.ini",
  )
    ? undefined
    : "empty";
}
