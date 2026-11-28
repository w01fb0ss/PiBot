import { dirname, resolve } from "node:path";
import {
  abortable,
  checkWorkflowInputs,
  localWorkspaceFiles,
  omitUnavailableWorkflowInput,
  skillContract,
  type WorkflowSkill,
  type WorkspaceFileAccess,
} from "@pibot/brain/orchestration-kit";
import type { Logger } from "@pibot/observability";
import {
  DeliverablePathSchema,
  type GroupExecutionPlan,
  GroupExecutionPlanSchema,
  type GroupPlanCard,
  GroupPlanInputError,
  RpcError,
  type SkillContract,
  type WorkflowInput,
} from "@pibot/protocol-base";

import { ATTACHMENT_INPUT } from "./group-plan-inputs.ts";

const invalid = () => new RpcError(-32602, "group_plan_method_inputs_invalid");

async function inputAccess<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await abortable(operation, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (isUnavailable(error)) throw new RpcError(-32602, "group_plan_method_input_unavailable");
    throw error;
  }
}

function isUnavailable(error: unknown) {
  return (
    omitUnavailableWorkflowInput(error) || (error as NodeJS.ErrnoException | null)?.code === "ELOOP"
  );
}

/** Folder labels are data, never paths that can select another working root. */
function inputPath(root: string, name: string, files?: WorkspaceFileAccess) {
  if (!DeliverablePathSchema.safeParse(name).success || /[/\\]/.test(name)) throw invalid();
  return (files?.paths.resolve ?? resolve)(root, name);
}

function hasAttachmentInputs(
  plan: GroupExecutionPlan,
  folder: string | undefined,
  files?: WorkspaceFileAccess,
) {
  return (
    !!folder &&
    plan.inputs.some(
      (item) =>
        item.kind === "file" &&
        item.name.startsWith(ATTACHMENT_INPUT) &&
        (files?.paths.dirname ?? dirname)(item.value) === folder,
    )
  );
}

function failure(
  plan: GroupExecutionPlan,
  root: string,
  declaration: WorkflowInput,
  reason: string,
  files?: WorkspaceFileAccess,
) {
  const { name, required } = declaration;
  const expected =
    declaration.kind === "folder"
      ? inputPath(root, name, files)
      : (plan.inputs.find((item) => item.name === name && item.kind === "file")?.value ?? "");
  return new GroupPlanInputError(reason, {
    name: name.slice(0, 200),
    required,
    expected: expected.slice(0, 4096),
    found: plan.inputs
      .filter((item) => item.name !== name && (item.kind === "file" || item.kind === "folder"))
      .slice(0, 6)
      .map((item) => `${item.kind}: ${item.value}`.slice(0, 4096)),
  });
}

async function methodInputCheck(
  plan: GroupExecutionPlan,
  root: string,
  input: WorkflowInput,
  value: string,
  signal: AbortSignal,
  access: WorkspaceFileAccess,
  logger?: Pick<Logger, "warn">,
) {
  try {
    if (input.kind === "folder") {
      const { isAbsolute, relative, resolve, sep } = access.paths;
      if (!isAbsolute(value)) return "group_plan_method_inputs_invalid";
      const rel = relative(root, value);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        return "group_plan_method_inputs_invalid";
      const info = await abortable(access.inspect(value, signal), signal);
      if (!info) return input.required ? "group_plan_method_input_unavailable" : "omitted";
      if (
        info.kind !== "directory" ||
        (await abortable(access.canonical(value, signal), signal)) !== resolve(value)
      )
        return "group_plan_method_inputs_invalid";
    }
    const { name } = input;
    const checked = await checkWorkflowInputs(
      {
        inputs: [input],
        prechecks: plan.contract.prechecks.filter((i) => typeof i !== "string" && i.input === name),
      },
      { [name]: value },
      signal,
      access,
      logger,
    );
    const reason = checked.failures[0]?.reason;
    if (reason === "empty") return "group_plan_method_input_empty";
    if (reason) return "group_plan_method_input_unavailable";
    if (!checked.inputs.length) return "omitted";
  } catch (error) {
    signal.throwIfAborted();
    if (!input.required && omitUnavailableWorkflowInput(error, logger)) return "omitted";
    if (isUnavailable(error)) return "group_plan_method_input_unavailable";
    throw error;
  }
}

/**
 * A method's folder input may be the same-named folder under the workplace root, the request's
 * copied inputs, or any folder inside the workplace the user named in the message. The
 * plan records which path it bound; containment and readability are checked here, never trusted.
 */
export async function checkMethodInputs(
  plan: GroupExecutionPlan,
  root: string,
  signal: AbortSignal,
  inputFolder?: string,
  files: WorkspaceFileAccess = localWorkspaceFiles,
  logger?: Pick<Logger, "warn">,
) {
  const values = new Map(plan.inputs.map((item) => [item.name, item]));
  if (
    plan.contract.inputs.some((item) => item.kind === "folder" && values.has(item.name)) &&
    (await inputAccess(files.canonical(root, signal), signal)) !== files.paths.resolve(root)
  )
    throw invalid();
  const omitted = new Set<string>();
  let attachmentsChecked = false;
  for (const declaration of plan.contract.inputs) {
    if (declaration.kind !== "folder" && declaration.kind !== "file") continue;
    signal.throwIfAborted();
    const input = values.get(declaration.name);
    if (!input && !declaration.required) continue;
    if (!input || input.kind !== declaration.kind)
      throw failure(plan, root, declaration, "group_plan_method_inputs_invalid", files);
    const reason = await methodInputCheck(
      plan,
      root,
      declaration,
      input.value,
      signal,
      files,
      logger,
    );
    if (reason === "omitted") {
      omitted.add(input.name);
      continue;
    }
    if (reason) throw failure(plan, root, declaration, reason, files);
    // The request's copied inputs are the only folder this run wrote itself, so they get the
    // stricter file checks.
    if (input.kind === "folder" && input.value === inputFolder && !attachmentsChecked) {
      for (const item of plan.inputs.filter(
        (item) =>
          item.kind === "file" &&
          item.name.startsWith(ATTACHMENT_INPUT) &&
          files.paths.dirname(item.value) === inputFolder,
      )) {
        try {
          const info = await inputAccess(files.inspect(item.value, signal), signal);
          if (
            info?.kind !== "file" ||
            info.links !== "1" ||
            (await inputAccess(files.canonical(item.value, signal), signal)) !==
              files.paths.resolve(item.value)
          )
            throw invalid();
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RpcError)) throw error;
          throw failure(plan, root, declaration, error.message, files);
        }
      }
      attachmentsChecked = true;
    }
  }
  return omitted.size ? plan.inputs.filter((item) => !omitted.has(item.name)) : plan.inputs;
}

/** Admission freezes method input declarations and bindings in the existing plan snapshot. */
export async function bindMethodInputs(
  plan: GroupExecutionPlan,
  card: GroupPlanCard,
  root: string,
  roles: ReadonlySet<string>,
  lookup: (botId: string, method: string) => Promise<WorkflowSkill | undefined>,
  signal: AbortSignal,
  inputFolder?: string,
  files: WorkspaceFileAccess = localWorkspaceFiles,
  logger?: Pick<Logger, "warn">,
): Promise<GroupExecutionPlan> {
  const declarations = new Map(plan.contract.inputs.map((item) => [item.name, item]));
  const inputs = new Map(plan.inputs.map((item) => [item.name, item]));
  const prechecks: SkillContract["prechecks"] = [...plan.contract.prechecks];
  for (const step of card.plan.steps) {
    signal.throwIfAborted();
    if (!step.method) continue;
    const owner = card.owners.find((item) => item.stepId === step.id)?.botId;
    if (!owner) throw invalid();
    const method = step.method.normalize("NFKC").trim();
    const slash = method.indexOf("/");
    const key = slash >= 0 && roles.has(method.slice(0, slash)) ? method.slice(slash + 1) : method;
    const skill = await abortable(lookup(owner, key), signal);
    const contract = skill ? skillContract(skill.document).contract : undefined;
    if (!contract || contract.steps?.length)
      throw new RpcError(-32602, "group_plan_method_unavailable");
    const names = new Set<string>();
    for (const input of contract.inputs) {
      const { name, kind } = input;
      const existing = inputs.get(name);
      // Unlike folders, files have no default path in the workplace.
      if (kind !== "folder" && !(kind === "file" && existing)) continue;
      const declared = declarations.get(name);
      // An explicit binding may name any folder inside the workplace; checkMethodInputs
      // validates containment and readability once the whole plan is assembled.
      if ((existing && existing.kind !== kind) || (declared && declared.kind !== kind))
        throw failure(plan, root, input, "group_plan_method_inputs_invalid", files);
      names.add(name);
      declarations.set(name, { ...input, required: input.required || !!declared?.required });
      if (kind === "folder") {
        const path = inputPath(root, name, files);
        if (!existing) inputs.set(name, { name, kind, value: path });
      }
    }
    for (const rule of contract.prechecks) {
      if (typeof rule === "string" || !names.has(rule.input)) continue;
      if (
        !prechecks.some(
          (item) =>
            typeof item !== "string" && item.check === rule.check && item.input === rule.input,
        )
      )
        prechecks.push(rule);
    }
  }
  const candidate = {
    ...plan,
    contract: { ...plan.contract, inputs: [...declarations.values()], prechecks },
    inputs: [...inputs.values()],
  };
  if (hasAttachmentInputs(candidate, inputFolder, files)) {
    const missing: Array<GroupExecutionPlan["inputs"][number]> = [];
    for (const folder of candidate.contract.inputs.filter((item) => item.kind === "folder")) {
      const input = inputs.get(folder.name);
      // An explicit binding is never silently replaced; absent inferred folders may use copies.
      if (!input || plan.inputs.some((item) => item.name === folder.name)) continue;
      if (await methodInputCheck(candidate, root, folder, input.value, signal, files))
        missing.push(input);
    }
    // One unlabelled attachment bundle cannot identify multiple distinct input periods/folders.
    if (missing.length === 1 && missing[0]) missing[0].value = inputFolder as string;
  }
  const parsed = GroupExecutionPlanSchema.safeParse({
    ...candidate,
    inputs: await checkMethodInputs(candidate, root, signal, inputFolder, files, logger),
  });
  if (!parsed.success) throw invalid();
  return parsed.data;
}
