import type { Grant, GrantScope } from "@pibot/protocol-base";
import {
  automaticDownload,
  commandConfirmation,
  commandNetwork,
  confirmCommand,
  readonlyDownload,
} from "./command-consent.ts";
import {
  GIT_CONFIGURATION_CONFIRMATION_REASON,
  GIT_HOOK_CONFIRMATION_REASON,
  GIT_HOOKS_PATH_CONFIRMATION_REASON,
  OUTSIDE_WRITE_REASON,
  WINDOWS_FILE_READ_CONFIRMATION,
  WINDOWS_READ_ONLY,
} from "./confirmation-reasons.ts";
import { deny } from "./deny.ts";
import type { PolicyTrace } from "./explain.ts";
import { gitEntryDecision } from "./git-entry-policy.ts";
import { jev } from "./jev.ts";
import { effectiveLevel } from "./levels.ts";
import {
  fixedOutsideCommand,
  LOCAL_SERVICE_REASON,
  listedOutsideCommand,
  OUTSIDE_SANDBOX_REASON,
  outsideSandboxDecision,
} from "./outside-sandbox.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PolicyOptions, PolicyResult } from "./types.ts";

export interface FinishPorts {
  matchesGrant: typeof import("../grants/grants.ts").matchesGrant;
  containsPath: typeof import("../paths/paths.ts").containsPath;
  publicReadDomain: typeof import("../targets/web.ts").publicReadDomain;
  serviceDecision: typeof import("./finish-service-decisions.ts").serviceDecision;
}

export function finishShared(
  input: EvaluationInput,
  options: PolicyOptions,
  prepared: RequestFacts,
  trace: PolicyTrace,
  ports: FinishPorts,
): PolicyResult {
  const { matchesGrant, containsPath, publicReadDomain, serviceDecision } = ports;
  const { result, incomplete, outside, skill, attachment, localService } = prepared;
  const locationTarget = input.boundary?.location?.target ?? "local";
  const scope =
    prepared.scope && ["folder", "workplace", "programs"].includes(prepared.scope.kind)
      ? { ...prepared.scope, target: locationTarget }
      : prepared.scope;
  if (result.decision === "deny") return result;
  if (result.category === "read_ai_config") {
    const level = effectiveLevel(
      input.settings.levels.read_ai_config,
      input.botOverrides?.read_ai_config,
    );
    trace.step("level", "permission_level", "info", {
      level,
      source:
        input.permissionSources?.read_ai_config ??
        (input.botOverrides?.read_ai_config === undefined ? "default" : "bot"),
    });
    result.canRemember = false;
    delete result.grantScope;
    if (level === "never") return deny(result, "permission_never", trace, "level");
    result.decision = "ask";
    result.reason = "read_ai_config_once";
    return trace.result(result, "level");
  }
  // The Bot's own skills folder is app-owned config, like its memory: always readable, never a
  // reusable grant, and it widens nothing outside that folder.
  if (skill) {
    result.decision = "allow";
    result.reason = "bot_skill";
    result.canRemember = false;
    return trace.result(result, "intrinsic");
  }
  // The message itself names this file, and Pi Bot's own attachment folder is where the
  // app put it; a read there is the request being carried out, not a new access to ask about.
  if (attachment) {
    result.decision = "allow";
    result.reason = "bot_attachment";
    result.canRemember = false;
    return trace.result(result, "intrinsic");
  }
  // Image dispatch uses the existing web ceiling/grants, while its facts name only the
  // configured service host. It never grants general browsing or a new permission tier.
  const requestCategory = input.request.category;
  const category =
    requestCategory === "image_generation" || requestCategory === "video_generation"
      ? "web"
      : requestCategory;
  if (requestCategory !== category) trace.step("category", "web", "info");
  if (
    category === "memory" ||
    category === "memory_read" ||
    category === "collaboration" ||
    category === "routine_proposal" ||
    category === "review" ||
    category === "planning" ||
    category === "tool_discovery" ||
    category === "plugin_install" ||
    category === "skill_proposal" ||
    category === "workplace_proposal" ||
    category === "check_proposal" ||
    category === "background" ||
    category === "browser_tabs" ||
    category === "phone_data" ||
    // Decided in intrinsic-decisions; never reaches levels or grants.
    category === "local_network"
  )
    return deny(result, "category_unavailable", trace, "category");
  let level = effectiveLevel(input.settings.levels[category], input.botOverrides?.[category]);
  trace.step("level", "permission_level", "info", {
    level,
    source:
      input.permissionSources?.[category] ??
      (input.botOverrides?.[category] === undefined ? "default" : "bot"),
  });
  // Workspace scope is a security boundary, not a Bot/default inheritance choice.
  if (outside && level === "always") {
    level = "ask";
    trace.step("boundary", "outside_workplace", "narrow");
  }
  // A group run exists to produce files in the group's own output folder, so those writes
  // are the intended product rather than a place to ask about every file. "never" (a person's
  // explicit choice), outside writes and the danger branches below still refuse.
  const outputWrite = outputWriteScope(input, result, options.platform, containsPath);
  if (outputWrite) trace.step("boundary", "group_output", "info");
  if (level === "never") return deny(result, "permission_never", trace, "level");
  if (input.request.category === "web" && input.request.browserSensitive) {
    result.decision = "ask";
    result.reason = "browser_sensitive_confirmation";
    result.canRemember = false;
    delete result.grantScope;
    result.facts.push({
      kind: "warning",
      value: `${input.request.browserSensitive.kind}: ${input.request.browserSensitive.name}`,
    });
    return trace.result(result, "boundary");
  }
  // Before the outside-sandbox card and every level/grant/YOLO path: those cannot answer it.
  if (input.gitEntries) return gitEntryDecision(input, input.gitEntries, result, trace);
  if (input.request.category === "run_command") {
    if (
      input.outsideSandbox?.status === "eligible" &&
      options.platform === "darwin" &&
      result.risk !== "danger" &&
      result.analysis?.commands.length === 1 &&
      input.outsideSandbox.localService &&
      !input.request.outsideSandbox &&
      input.outsideSandbox.blockRecorded
    ) {
      result.decision = "ask";
      result.reason = LOCAL_SERVICE_REASON;
      result.risk = "normal";
      result.canRemember = true;
      delete result.grantScope;
      // The card names the one port or socket that opens; nothing else does.
      result.facts.push(
        { kind: "network", value: input.outsideSandbox.localService.target },
        { kind: "warning", value: "local_service" },
      );
      return trace.result(result, "boundary");
    }
    if (
      input.outsideSandbox?.status === "eligible" &&
      options.platform === "darwin" &&
      result.risk !== "danger" &&
      result.analysis?.commands.length === 1 &&
      input.outsideSandbox.systemService &&
      input.outsideSandbox.blockRecorded &&
      !input.request.outsideSandbox
    ) {
      result.decision = "ask";
      result.reason = "system_service_once";
      result.risk = "normal";
      result.canRemember = true;
      delete result.grantScope;
      result.facts.push(
        { kind: "network", value: input.outsideSandbox.systemService },
        { kind: "warning", value: "system_service" },
      );
      return trace.result(result, "boundary");
    }
    // After a recognized block of this same call, or a command the user listed;
    // either way the current person confirms this run, and it is never remembered.
    const automatic =
      input.outsideSandbox?.status === "eligible" &&
      listedOutsideCommand(
        input.request.command,
        result.analysis,
        input.outsideSandbox.automatic ?? [],
        options.platform,
      );
    if (automatic) result.facts.push({ kind: "warning", value: "sandbox_outside_auto" });
    // Programs that need the person's own login or bypass the proxy go straight to
    // the outside-sandbox card instead of a doomed sandboxed try; a command the person had
    // remembered still runs without asking.
    if (
      !automatic &&
      input.outsideSandbox?.status === "eligible" &&
      fixedOutsideCommand(result.analysis, options.platform)
    ) {
      result.decision = "ask";
      result.reason = OUTSIDE_SANDBOX_REASON;
      result.risk = "danger";
      result.canRemember = false;
      delete result.grantScope;
      result.facts.push(
        { kind: "warning", value: "outside_sandbox_login" },
        { kind: "warning", value: "outside_sandbox" },
      );
      return trace.result(result, "danger");
    }
    const outside = automatic
      ? undefined
      : outsideSandboxDecision(
          input.request.outsideSandbox === true,
          input.outsideSandbox,
          input.request.command,
          result.analysis,
          options.platform,
        );
    if (outside?.decision === "deny") return deny(result, outside.reason, trace, "boundary");
    if (outside) {
      result.decision = "ask";
      result.reason = outside.reason;
      result.risk = "danger";
      result.canRemember = false;
      result.facts.push({ kind: "warning", value: "outside_sandbox" });
      delete result.grantScope;
      return trace.result(result, "danger");
    }
  }
  if (prepared.gitHook) {
    result.decision = "ask";
    result.reason = GIT_HOOK_CONFIRMATION_REASON;
    result.risk = "danger";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "danger");
  }
  if (
    prepared.gitConfiguration === "global" ||
    prepared.gitConfiguration === "hooks-path" ||
    prepared.gitConfiguration === "sensitive-project"
  ) {
    result.decision = "ask";
    result.reason =
      prepared.gitConfiguration === "hooks-path"
        ? GIT_HOOKS_PATH_CONFIRMATION_REASON
        : GIT_CONFIGURATION_CONFIRMATION_REASON;
    result.risk = "danger";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "danger");
  }
  if (input.request.category === "write_file" && input.request.projectNotes) {
    const { path, projectNotesReview: review } = input.request;
    // A preview answers this exact local write only, after the normal path and level checks.
    if (
      review &&
      (locationTarget !== "local" ||
        outside ||
        path !== review.reviewed.target ||
        result.path?.path !== review.reviewed.target ||
        review.change.target !== review.reviewed.target ||
        review.change.diffHash !== review.reviewed.diffHash ||
        review.change.contentHash !== review.reviewed.contentHash ||
        review.change.beforeHash !== review.reviewed.beforeHash)
    )
      return deny(result, "project_notes_review_changed", trace, "boundary");
    result.decision = review ? "allow" : "ask";
    result.reason = review ? "project_notes_reviewed" : "project_notes_confirmation";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "boundary");
  }
  if (input.request.category === "video_generation") {
    // A video job can outlive this run, so only this call's human confirmation authorizes it.
    result.decision = "ask";
    result.category = "web";
    result.reason = "video_generation_confirmation";
    result.videoModel = { provider: input.request.provider, id: input.request.model };
    result.facts.push({ kind: "warning", value: "paid_generation" });
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "boundary");
  }
  if (input.request.category === "image_generation") {
    // Every real generation is billed. The web level only bounds whether the configured
    // service may be reached; "always" is consent to visit sites, not to spend money, so each
    // generation asks, also in groups whatever their permissions. Owner decision 2026-10-23: the
    // card can remember this Bot + exact model (`paid_image`), and YOLO no longer allows it
    // (yolo.ts); a routine pre-approval of the same scope is matched by brain.
    const scope = {
      kind: "paid_image" as const,
      provider: input.request.provider,
      model: input.request.model,
    };
    result.facts.push({ kind: "warning", value: "paid_generation" });
    result.canRemember = true;
    result.grantScope = scope;
    const held = input.grants?.some((grant) =>
      matchesGrant(grant, { botId: input.botId, category: "web", scope }, options.platform),
    );
    result.decision = held ? "allow" : "ask";
    result.reason = held ? "paid_grant_matched" : "paid_generation_confirmation";
    if (!held) trace.step("grant", "grant_not_matched", "info");
    return trace.result(result, held ? "grant" : "boundary");
  }
  if (input.request.category === "run_command" && input.request.stdin) {
    // Interpreter input can execute code the original command's AST never contained.
    result.decision = "ask";
    result.reason = "dangerous_operation";
    result.risk = "danger";
    result.canRemember = false;
    delete result.grantScope;
    result.facts = result.facts.filter(
      (fact) => fact.kind !== "warning" || fact.value !== "readonly",
    );
    if (result.analysis) result.analysis = { ...result.analysis, readonly: false };
    // Input reaches a process whose sandbox was fixed at its start; it opens no new root.
    delete result.outsideWrites;
    delete result.outsideWriteRoots;
    result.facts.push({ kind: "warning", value: "background_stdin" });
    return trace.result(result, "danger");
  }
  if (result.outsideWrites?.length && !result.outsideWritesRemembered) {
    // Asked for this call only, whatever the level, grants or routine consent; the
    // card offers no "always", YOLO leaves it pending (`mustAskNow`) and nothing is remembered.
    result.decision = "ask";
    result.reason = OUTSIDE_WRITE_REASON;
    result.risk = "danger";
    result.canRemember = false;
    delete result.grantScope;
    result.facts = result.facts.filter(
      (fact) => fact.kind !== "warning" || fact.value !== "readonly",
    );
    result.facts.push({ kind: "warning", value: OUTSIDE_WRITE_REASON, risk: "danger" });
    trace.step("danger", OUTSIDE_WRITE_REASON, "info");
    return trace.result(result, "boundary");
  }
  const service = serviceDecision(
    input,
    options,
    result,
    trace,
    scope,
    localService,
    prepared.privateNetwork,
  );
  if (service) return service;
  if (result.risk === "danger") {
    result.reason = "dangerous_operation";
    return trace.result(result, "danger");
  }
  const commandConsent = commandConfirmation(input, result);
  if (commandConsent) return confirmCommand(result, commandConsent, trace);
  if (result.reason === WINDOWS_FILE_READ_CONFIRMATION) return trace.result(result, "boundary");
  if (
    result.reason === WINDOWS_READ_ONLY &&
    category === "run_command" &&
    options.platform === "win32"
  ) {
    result.decision = "allow";
    return trace.result(result, "boundary");
  }
  if (incomplete) {
    if (options.platform !== "win32") {
      result.facts.push({ kind: "warning", value: "incomplete_analysis" });
      result.reason = "incomplete_analysis";
      // The ordinary "cannot fully analyse" ask on a read script; brain offers it to a
      // routine as consent pinned to that script, never as a remembered grant.
      if (prepared.scriptScope?.kind === "programs") {
        result.scriptScope = { ...prepared.scriptScope, target: locationTarget };
      }
    }
    return trace.result(result, "boundary");
  }
  if ((scope?.kind === "programs" || scope?.kind === "workplace") && scope.topicId)
    result.facts.push({ kind: "warning", value: "topic_writable_scope" });
  result.canRemember = !!scope && !input.managedGitConfiguration;
  if (scope && !input.managedGitConfiguration) result.grantScope = scope;
  const held = (grants: Grant[] | undefined, wanted: GrantScope | undefined) =>
    !!wanted &&
    !!grants?.some((grant) =>
      matchesGrant(
        grant,
        {
          botId: input.botId,
          category,
          scope: wanted,
          writableRoots: input.boundary?.writeRoots,
          commandPaths: result.analysis
            ? [...result.analysis.reads, ...result.analysis.writes]
            : undefined,
        },
        options.platform,
      ),
    );
  // A remembered or automatic download runs with the bounded command network list, like every
  // automatic sandboxed run, so a redirect cannot reach a site only allowAll would admit.
  const boundDownload = () => {
    if (readonlyDownload(input, result.analysis)) result.commandNetwork = commandNetwork(input);
  };
  if (held(input.grants, scope)) {
    result.decision = "allow";
    result.reason = "grant_matched";
    boundDownload();
    return trace.result(result, "grant");
  }
  const publicRead = webReadScope(input);
  if (publicRead) {
    result.taskWebReadAvailable = result.risk === "normal";
    if (result.risk === "normal" && input.taskWebReadAllowed) {
      result.grantScope = publicRead;
      result.canRemember = true;
      result.decision = "allow";
      result.reason = "task_web_read";
      return trace.result(result, "grant");
    }
    const domain = result.url ? publicReadDomain(result.url) : undefined;
    if (domain) result.conversationWebDomain = domain;
    if (domain && input.conversationWebDomains?.includes(domain)) {
      result.grantScope = publicRead;
      result.canRemember = true;
      result.decision = "allow";
      result.reason = "conversation_web_read";
      return trace.result(result, "grant");
    }
    // "Always allow" on a web_fetch card remembers reading public pages for this Bot, so
    // the card offers that scope; a site remembered before keeps matching above.
    result.grantScope = publicRead;
    result.canRemember = true;
    if (held(input.grants, publicRead)) {
      result.decision = "allow";
      result.reason = "public_web_read";
      return trace.result(result, "grant");
    }
  }
  if (held(input.runGrants, scope)) {
    result.decision = "allow";
    result.reason = "run_grant_matched";
    boundDownload();
    return trace.result(result, "grant");
  }
  trace.step("grant", scope ? "grant_not_matched" : "grant_unavailable", "info");
  if (level === "ask" && readonlyCommand(input, result)) {
    // Fully understood, read-only, inside one work folder, no network: nothing to protect.
    result.decision = "allow";
    result.reason = "readonly_command";
    result.canRemember = false;
    delete result.grantScope;
    boundDownload();
    return trace.result(result, "level");
  }
  jev.review(input.request);
  if (outputWrite && result.risk === "normal") {
    // Nothing to remember: the exemption follows the folder, not a choice the person made.
    result.decision = "allow";
    result.reason = "group_output_write";
    result.canRemember = false;
    delete result.grantScope;
    return trace.result(result, "level");
  }
  result.decision = level === "always" ? "allow" : "ask";
  result.reason = level === "always" ? "permission_always" : "permission_ask";
  return trace.result(result, "level");
}
/**
 * A write into the group's own artifact root no longer asks. Only an in-workplace write
 * qualifies: an outside target keeps its unconditional one-off card, and a plan step's
 * own folder is inside this root, so a reviewer's report is covered without a separate rule.
 */
function outputWriteScope(
  input: EvaluationInput,
  result: PolicyResult,
  platform: PolicyOptions["platform"],
  containsPath: FinishPorts["containsPath"],
): "group" | undefined {
  const target = result.path;
  if (input.request.category !== "write_file" || !target?.root) return undefined;
  const inside = (roots?: readonly string[]) =>
    !!roots?.some((root) => containsPath(root, target.path, platform));
  return inside(input.groupOutputRoots) ? "group" : undefined;
}
function webReadScope(input: EvaluationInput): GrantScope | undefined {
  const request = input.request;
  return request.category === "web" && request.fetch && !request.search && !request.submit
    ? { kind: "web_read" }
    : undefined;
}
/**
 * The analysis already proved every program read-only with known options and no writes; the
 * reads were resolved inside the grant root (a `programs` scope exists only then). Background
 * starts and interpreter input keep asking, as does anything with a network target except a
 * read-only download the network rules already allow without asking.
 */
function readonlyCommand(input: EvaluationInput, result: PolicyResult) {
  const request = input.request;
  return (
    request.category === "run_command" &&
    !request.background &&
    !request.stdin &&
    result.risk === "normal" &&
    result.grantScope?.kind === "programs" &&
    result.analysis?.readonly === true &&
    !result.analysis.incomplete &&
    (!result.analysis.network || automaticDownload(input, result.analysis)) &&
    result.analysis.writes.length === 0
  );
}
