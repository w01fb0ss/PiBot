// Schema fixtures for the computer / browser / skills / teach contracts. Kept beside the shared
// table in schemas.test.ts so parallel changes append one spread line instead of large blocks.
import type {
  ComputerGrant,
  ComputerPermissions,
  ComputerState,
  Recording,
  SkillDraft,
} from "@pibot/protocol-base";
import type { EventPayloads, MethodParams, MethodResults } from "../../src/aggregate/api.ts";

const id = "00000000-0000-4000-8000-000000000001";
const date = "2026-10-09T00:00:00.000Z";
const ok = { ok: true } as const;
const thumbnail = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/jpeg" } as const;
const keynote = { id: "com.apple.iWork.Keynote", name: "Keynote" };
const grant: ComputerGrant = {
  id,
  botId: id,
  runId: id,
  apps: [keynote.id],
  duration: "task",
  expiresAt: date,
  foregroundAsk: true,
  allowCoordinates: false,
  createdAt: date,
  revokedAt: null,
};
const _state: ComputerState = {
  botId: id,
  runId: id,
  state: "foreground",
  app: keynote,
  pausedBy: null,
  foreground: { requestId: id, app: keynote, action: "Drag table", status: "waiting_idle" },
  userActive: false,
  screenLocked: false,
  stepCount: 3,
  grant,
};
const _permissions: ComputerPermissions = {
  platform: "darwin",
  available: true,
  unavailableReason: null,
  items: [
    { kind: "accessibility", status: "granted" },
    { kind: "automation", status: "unknown" },
  ],
};
const skill = {
  id,
  botId: id,
  name: "导出客户反馈周表",
  description: "Export the weekly feedback sheet",
  source: "taught",
  enabled: true,
  lastUsedAt: null,
  createdAt: date,
  updatedAt: date,
} as const;
const doc = {
  name: skill.name,
  description: skill.description,
  body: "1. Open {date}",
  params: [{ name: "date", default: "today" }],
};
/** A prepared Python environment; `planHash` is what the approval card was shown for. */
const planHash = "a".repeat(64);
const runtimeStatus: MethodResults["skills.runtime"] = {
  skillId: id,
  state: "ready",
  runtime: "python",
  networkDomains: { primary: ["github.com"], withMirror: ["github.com", "releases.astral.sh"] },
  requirements: [{ runtime: "python", version: ">=3.10", packages: ["numpy"] }],
  nativeModules: ["numpy"],
  interpreter: { command: "python3", version: "3.12.4" },
  envId: "0123456789abcdef",
  planHash,
  packages: 1,
  bytes: 1024,
  reason: null,
  logPath: null,
  progress: null,
};
const proposal = {
  id,
  botId: id,
  messageId: id,
  payload: doc,
  status: "open",
  resolvedSkillId: null,
  createdAt: date,
  resolvedAt: null,
} as const;
const recording: Recording = {
  id,
  botId: id,
  status: "review",
  startedAt: date,
  endedAt: date,
  steps: [
    {
      index: 0,
      kind: "type",
      url: "https://example.com/login",
      target: "Password",
      secret: true,
      hasThumbnail: true,
      at: date,
    },
  ],
};
const draft: SkillDraft = {
  ...doc,
  recordingId: id,
  permissions: { domains: ["example.com"], writePaths: [], sendTo: [] },
  trigger: "chat",
};

type Cases<K extends keyof MethodParams & keyof MethodResults> = {
  [M in K]: {
    params: MethodParams[M];
    result: MethodResults[M];
    badParams: unknown;
    badResult: unknown;
  };
};

export const skillMethodCases = {
  "skills.list": {
    params: { botId: id, enabled: true },
    result: [skill],
    badParams: { enabled: true },
    badResult: [{ ...skill, source: "market" }],
  },
  "skills.get": {
    params: { skillId: id },
    result: { skill, document: doc, files: [] },
    badParams: {},
    badResult: { skill, document: { ...doc, body: "" } },
  },
  "skills.createWorkflow": {
    params: {
      botId: id,
      requestId: id,
      document: {
        name: "Weekly report",
        description: "Create a weekly report",
        body: "Summarize the selected folder.",
        contract: {
          inputs: [],
          prechecks: [],
          deliverables: [],
          acceptance: [],
          stop: [],
          maxFixRounds: 1,
          approvals: [],
        },
      },
    },
    result: skill,
    badParams: { botId: id },
    badResult: { ...skill, source: "plugin" },
  },
  "skills.workflows": {
    params: { botId: id },
    result: { items: [] },
    badParams: {},
    badResult: { items: [{}] },
  },
  "skills.planSaveState": {
    params: { groupId: id, workflowRunId: id },
    result: { state: "saved" },
    badParams: { groupId: id },
    badResult: { state: "unknown" },
  },
  "skills.savedPlans": {
    params: { groupId: id },
    result: {
      items: [
        {
          botId: id,
          skillId: id,
          name: "周报",
          description: "从一次通过的群计划保存",
          enabled: true,
          version: 1,
          stepCount: 2,
          estimatedCostUsd: 0.2,
        },
      ],
    },
    badParams: {},
    badResult: { items: [{ botId: id, stepCount: 0 }] },
  },
  "skills.workflowEstimate": {
    params: { botId: id, skillId: id },
    result: { estimateUsd: 0.3, samples: 5, capUsd: 1 },
    badParams: { botId: id },
    badResult: { estimateUsd: 0.3, samples: 6, capUsd: 1 },
  },
  "skills.pickWorkflowInput": {
    params: { botId: id, kind: "file", defaultPath: "/tmp" },
    result: "/tmp/input.txt",
    badParams: { botId: id, kind: "text" },
    badResult: "relative/input.txt",
  },
  "skills.runWorkflow": {
    params: { botId: id, skillId: id, inputs: { 资料: "/tmp/a" } },
    result: {
      status: "blocked",
      code: "workflow_precheck_failed",
      failures: [{ input: "资料", reason: "empty" }],
    },
    badParams: { botId: id },
    badResult: { status: "blocked", code: "workflow_precheck_failed", failures: [] },
  },
  "skills.create": {
    params: { requestId: id, botId: id, document: { name: "Daily", description: "D", body: "B" } },
    result: skill,
    badParams: { botId: id, document: { name: "Daily", description: "D", body: "B" } },
    badResult: { ...skill, enabled: "yes" },
  },
  "skills.update": {
    params: { skillId: id, requestId: id, patch: { body: "New" } },
    result: skill,
    badParams: { skillId: id, patch: {} },
    badResult: { ...skill, enabled: "yes" },
  },
  "skills.delete": {
    params: { skillId: id, confirmed: true },
    result: ok,
    badParams: { skillId: id },
    badResult: {},
  },
  "skills.setEnabled": {
    params: { skillId: id, enabled: false },
    result: { ...skill, enabled: false },
    badParams: { skillId: id },
    badResult: { ...skill, name: "" },
  },
  "skills.resolveLink": {
    params: { url: "https://github.com/owner/repo" },
    result: {
      sourceId: id,
      host: "github.com",
      subpath: "",
      bytes: null,
      estimateBytes: null,
      expiresAt: date,
    },
    badParams: {},
    badResult: { sourceId: id },
  },
  "skills.downloadLink": {
    params: { sourceId: id, confirmed: true },
    result: {
      sourceId: id,
      skills: [],
      components: { mcp: false, commands: false, externalPlugins: 0 },
      externalSources: [],
      expiresAt: date,
    },
    badParams: { sourceId: id },
    badResult: {},
  },
  "skills.previewLink": {
    params: { sourceId: id, candidateId: id, botId: id },
    result: {
      previewId: id,
      botId: id,
      document: doc,
      source: "folder",
      sourceName: "skill",
      files: [{ path: "SKILL.md", bytes: 20, script: false, text: true }],
      totalBytes: 20,
      skipped: 0,
      expiresAt: date,
    },
    badParams: { sourceId: id },
    badResult: {},
  },
  "skills.cancelLink": { params: { sourceId: id }, result: ok, badParams: {}, badResult: {} },
  "skills.preview": {
    params: { botId: id },
    result: {
      previewId: id,
      botId: id,
      document: doc,
      source: "file",
      sourceName: "SKILL.md",
      files: [{ path: "SKILL.md", bytes: 20, script: false, text: true }],
      totalBytes: 20,
      skipped: 0,
      expiresAt: date,
    },
    badParams: {},
    badResult: { previewId: id },
  },
  "skills.previewFile": {
    params: { previewId: id, path: "scripts/run.sh" },
    result: { path: "scripts/run.sh", text: "echo hi\n" },
    badParams: { previewId: id },
    badResult: { path: "scripts/run.sh" },
  },
  "skills.readFile": {
    params: { skillId: id, path: "scripts/run.sh" },
    result: { path: "scripts/run.sh", text: null },
    badParams: { skillId: id, uploadId: id, path: "scripts/run.sh" },
    badResult: { path: "scripts/run.sh" },
  },
  "skills.pickFiles": {
    params: { botId: id, from: "drop", dropId: id },
    result: {
      uploadId: id,
      files: [{ path: "scripts/run.sh", bytes: 8, script: true, text: true }],
    },
    badParams: { botId: id, from: "drop", dropped: [{ name: "x", data: "eA==" }] },
    badResult: { uploadId: id, files: [] },
  },
  "skills.cancelPreview": { params: { previewId: id }, result: ok, badParams: {}, badResult: {} },
  "skills.cancelPreviewBatch": {
    params: { batchId: id },
    result: ok,
    badParams: { batchId: "bad" },
    badResult: {},
  },
  "skills.secretChoices": {
    params: { botId: id },
    result: ["SEARCH_KEY"],
    badParams: { botId: "bad" },
    badResult: ["bad name"],
  },
  "skills.secretBindings": {
    params: { skillId: id },
    result: {
      bindings: [{ variable: "API_KEY", secretName: "SEARCH_KEY" }],
      available: ["SEARCH_KEY"],
    },
    badParams: { skillId: "bad" },
    badResult: { bindings: [], available: ["bad name"] },
  },
  "skills.setSecretBindings": {
    params: { skillId: id, bindings: [{ variable: "API_KEY", secretName: "SEARCH_KEY" }] },
    result: ok,
    badParams: { skillId: id, bindings: [{ variable: "bad name", secretName: null }] },
    badResult: {},
  },
  "skills.import": {
    params: { previewId: id },
    result: { ...skill, source: "imported" },
    badParams: { previewId: "bad" },
    badResult: { ...skill, source: "unknown" },
  },
  "skills.checkUpdate": {
    params: { skillId: id, from: "folder" },
    result: {
      sourceVersion: "1.2.0",
      digest: "a".repeat(64),
      importedAt: date,
      checkedAt: date,
      available: null,
      rollback: null,
    },
    badParams: { skillId: id, from: "zip" },
    badResult: { sourceVersion: null, digest: "abc", importedAt: date, checkedAt: null },
  },
  "skills.applyUpdate": {
    params: { skillId: id, requestId: id },
    result: {
      sourceVersion: "1.3.0",
      digest: "b".repeat(64),
      importedAt: date,
      checkedAt: date,
      available: null,
      rollback: { packageId: null, version: null, digest: "a".repeat(64), at: date },
    },
    badParams: { skillId: id },
    badResult: { sourceVersion: null, digest: "b".repeat(64), importedAt: date, checkedAt: null },
  },
  "skills.rollbackUpdate": {
    params: { skillId: id, requestId: id },
    result: {
      sourceVersion: null,
      digest: "a".repeat(64),
      importedAt: date,
      checkedAt: null,
      available: null,
      rollback: null,
    },
    badParams: { requestId: id },
    badResult: { sourceVersion: null, digest: "a".repeat(63), importedAt: date, checkedAt: null },
  },
  "skills.catalog": {
    params: { limit: 50 },
    result: {
      items: [
        {
          key: "a".repeat(32),
          skillId: id,
          botId: id,
          name: "Review",
          description: "Review a change",
          origin: "imported" as const,
          originTool: "claude-code" as const,
          bots: [id],
          groups: [],
          copies: 1,
        },
      ],
      nextCursor: null,
      total: 1,
    },
    badParams: { limit: 101 },
    badResult: { items: [], total: 0 },
  },
  "skills.catalogAssign": {
    params: { skillId: id, botId: id, enabled: true },
    result: ok,
    badParams: { skillId: id, enabled: true },
    badResult: {},
  },
  "skills.catalogDelete": {
    params: { skillId: id, confirmed: true as const },
    result: ok,
    badParams: { skillId: id },
    badResult: {},
  },
  "skills.proposals": {
    params: { messageId: id },
    result: [proposal],
    badParams: { limit: 201 },
    badResult: [{ ...proposal, status: "pending" }],
  },
  "skills.propose.resolve": {
    params: { proposalId: id, accept: true, edits: { name: "Weekly sheet" } },
    result: { proposal: { ...proposal, status: "accepted", resolvedSkillId: id }, skill },
    badParams: { proposalId: id, accept: true, edits: {} },
    badResult: { proposal, skill: { id } },
  },
  "teach.start": {
    params: { botId: id, url: "https://example.com/" },
    result: { ...recording, status: "recording", endedAt: null, steps: [] },
    badParams: { botId: id, apps: ["com.apple.Notes"] },
    badResult: { ...recording, status: "paused" },
  },
  "teach.current": {
    params: { botId: id },
    result: null,
    badParams: {},
    badResult: { ...recording, status: "paused" },
  },
  "teach.pause": {
    params: { recordingId: id, paused: true },
    result: { paused: true },
    badParams: { recordingId: id },
    badResult: {},
  },
  "teach.stop": {
    params: { recordingId: id },
    result: recording,
    badParams: {},
    badResult: { ...recording, steps: [{ ...recording.steps[0], value: "hunter2" }] },
  },
  "teach.review": {
    params: { recordingId: id },
    result: recording,
    badParams: { recordingId: "bad" },
    badResult: { ...recording, steps: [{ ...recording.steps[0], index: 3 }] },
  },
  "teach.thumbnail": {
    params: { recordingId: id, index: 0 },
    result: thumbnail,
    badParams: { recordingId: id, index: 500 },
    badResult: {},
  },
  "teach.draft": {
    params: { recordingId: id, keep: [0] },
    result: { draft },
    badParams: { recordingId: id, keep: [0, 0] },
    badResult: { draft: { ...draft, trigger: "hotkey" } },
  },
  "teach.trial": {
    params: { botId: id, draft },
    result: { runId: id, topicId: id },
    badParams: { botId: id, draft: { ...draft, permissions: {} } },
    badResult: {},
  },
  "teach.save": {
    params: { botId: id, draft },
    result: skill,
    badParams: { draft },
    badResult: {},
  },
  "teach.discard": { params: { recordingId: id }, result: ok, badParams: {}, badResult: {} },
  // One entry per runtime method, with a state the twenty-one-line status schema accepts.
  "skills.runtime": {
    params: { skillId: id },
    result: runtimeStatus,
    badParams: {},
    badResult: { ...runtimeStatus, state: "installing" },
  },
  "skills.runtime.prepare": {
    params: { skillId: id, runtime: "python", requestId: id, planHash: planHash },
    result: { ...runtimeStatus, state: "preparing" },
    badParams: { skillId: id, requestId: id },
    badResult: { ...runtimeStatus, envId: "NOT-HEX" },
  },
  "skills.runtime.cancel": {
    params: { skillId: id },
    result: runtimeStatus,
    badParams: {},
    badResult: { ...runtimeStatus, skillId: "" },
  },
  "skills.runtime.remove": {
    params: { skillId: id },
    result: { ...runtimeStatus, state: "not_prepared" },
    badParams: {},
    badResult: { ...runtimeStatus, state: "removing" },
  },
  "skills.runtime.log": {
    params: { skillId: id },
    result: { path: null, text: "" },
    badParams: {},
    badResult: { path: null, text: 1 },
  },
} satisfies Cases<
  Exclude<
    Extract<keyof MethodParams, `${"skills" | "teach"}.${string}`>,
    "browser.debug" | "browser.inspectPoint"
  >
>;

export const skillEventCases = {
  "skills.linkProgress": {
    payload: { sourceId: id, phase: "downloading", bytes: 0, totalBytes: null },
    bad: { sourceId: id, phase: "downloading" },
  },
  "skills.importProgress": {
    payload: {
      botId: id,
      previewId: id,
      phase: "copying",
      files: 0,
      bytes: 0,
      totalFiles: 1,
      totalBytes: 1,
    },
    bad: { botId: id, phase: "copying" },
  },
  "skills.changed": {
    payload: { botId: id, reason: "created", skillId: id },
    bad: { botId: id, reason: "renamed" },
  },
  "skills.runtimeProgress": {
    payload: { skillId: id, state: "preparing", phase: "dependencies", done: 1, total: 3 },
    bad: { skillId: id, state: "preparing", phase: "copying", done: 1, total: 3 },
  },
  "teach.progress": {
    payload: {
      recordingId: id,
      botId: id,
      status: "recording",
      elapsedMs: 1000,
      maxMs: 900000,
      stepCount: 1,
      paused: false,
      lastStep: { kind: "click", target: "Export" },
    },
    bad: { recordingId: id, botId: id, status: "recording", elapsedMs: 1000, maxMs: 1 },
  },
} satisfies {
  [K in Extract<keyof EventPayloads, `${"skills" | "teach"}.${string}`>]: {
    payload: EventPayloads[K];
    bad: unknown;
  };
};

/** host.browser.record.read / pause fixtures, spread into the host table. */
export function teachHostCases() {
  return {
    "host.browser.record.read": {
      params: { botId: id, after: 0 },
      result: {
        events: [{ kind: "click" as const, tab: "t1", at: 1 }],
        active: true,
        paused: false,
      },
      badParams: { botId: id },
      badResult: { events: [], active: true },
    },
    "host.browser.record.pause": {
      params: { botId: id, paused: true },
      result: null,
      badParams: { botId: id },
      badResult: 1,
    },
  };
}
