import type { LocalToolCall, LocalToolResult, SkillPromptEntry } from "@pibot/agent";
import type {
  Skill,
  SkillDocument,
  SkillDocumentInput,
  SkillImportDetails,
  SkillImportPreview,
  SkillImportSource,
  SkillManagedRuntime,
  SkillSource,
  TeamSkill,
  TeamSkillReimport,
} from "@pibot/protocol-base";
import type { PackageFile } from "../../../resources/packages/skill-package.ts";
import type {
  ScannedSkillPackage,
  SkillPackageSummary,
} from "../../../resources/packages/skill-scan.ts";
import type { WorkflowSkill } from "../../workflows/workflow-prepare.ts";

export interface SkillConfirmation {
  assertCurrent(): void;
  audit(): void;
}
export interface SkillProposalContext {
  botId: string;
  runId: string;
  messageId: string;
  conversationId?: string;
  language?: "zh" | "en";
}

export interface PluginSkillLocaleInput {
  skillMd: string;
  files?: readonly { path: string; content: string | Uint8Array }[];
}
export interface PluginSkillInput {
  id: string;
  /** Brain-only source capability, never an IPC/JSON payload. */
  scannedPackage?: ScannedSkillPackage;
  locales: Readonly<Record<"zh" | "en", PluginSkillLocaleInput>>;
}
export interface PluginSkillsHost {
  /** Removes files older versions materialized; safe to replay during uninstall recovery. */
  remove(installationId: string): Promise<void>;
}

/**
 * Trusted app resources: the methods a Bot's role ships, which the built-in sync installs into its
 * own skills. `known` maps every released version's fingerprint (both languages, from
 * the pack history) to its version, so an untouched older copy can be recognised and updated.
 */
export interface BuiltinMethodsPort {
  /** Display labels only; this must not bind a method key or change a copy's provenance. */
  skillLabels?(
    botId: string,
    groupId: string | undefined,
    name: string,
    description: string,
  ):
    | { zh: { name: string; description: string }; en: { name: string; description: string } }
    | undefined;
  methods(
    botId: string,
    groupId?: string,
    language?: "zh" | "en",
  ): readonly (WorkflowSkill & {
    key: string;
    // No baseDir: the packaged pack lives in app.asar. The model only ever sees the installed
    // copy under the Bot's own skills folder, which it can read without an approval card.
    files: readonly PackageFile[];
    known: ReadonlyMap<string, number>;
  })[];
  /**
   * One released method by key, whichever role ships it, so the connections page can give
   * it to any Bot through the trusted install (it stays a bound built-in copy, never a user skill).
   */
  method?(
    key: string,
    language?: "zh" | "en",
  ): (WorkflowSkill & { key: string; files: readonly PackageFile[] }) | undefined;
}

/** The run engine and team import ask the capability; no service or repository crosses back. */
export interface SkillsPort {
  commandEntries?(
    botId: string,
    groupId: string | undefined,
    signal: AbortSignal,
  ): readonly { name: string; description: string }[];

  /** Effective, enabled skill body with the shared reference fence; no caller-supplied paths. */
  readReference?(
    botId: string,
    name: string,
    groupId: string | undefined,
    language: "zh" | "en",
    signal: AbortSignal,
  ): Promise<string>;

  /** T4 link importer owns download/confirmation, limits, source validation and preview lifecycle. */
  previewLink?(
    botId: string,
    source: SkillImportSource,
    expectedHash: string,
    signal: AbortSignal,
  ): Promise<SkillImportDetails>;

  /** Copies untrusted import data into an exact own-skill scope; never into instruction messages. */
  copyImported?(
    botId: string,
    input: PluginSkillInput,
    options: {
      groupId?: string;
      signal: AbortSignal;
      onProgress?: () => void;
      assertCurrent(): void;
      afterInsert(skillId: string): void;
    },
  ): Promise<void>;
  /**
   * Saves a skill folder another AI tool keeps on this computer as one of `botId`'s own
   * skills, turned off (nobody uses it until the user gives it to a Bot). Same untrusted-package
   * rules as a picked folder; a name any Bot already uses gets a number. `origin.key` is the
   * scan's stable key of that folder, so a later scan recognises it even after a rename.
   */
  bringOver?(
    botId: string,
    folder: string,
    origin: { tool: string; key: string },
    signal: AbortSignal,
  ): Promise<{ name: string }>;
  /** T7 resolves an opaque discovery key before calling this brain-only preview entry. */
  previewBringOver?(
    botId: string,
    folder: string,
    origin: { tool: string; key: string },
    signal: AbortSignal,
  ): Promise<SkillImportPreview & { summary?: SkillPackageSummary }>;
  /**
   * Drops a preview this batch created when the person cancels or the batch fails before
   * the renderer ever saw its id. Resolves after the brain has released it.
   */
  cancelPreview?(previewId: string): Promise<void>;
  /** Names and origin keys of every saved skill, to mark clashes in a scan. */
  knownSkills?(): { names: ReadonlySet<string>; originKeys: ReadonlySet<string> };
  /** The name a brought-over skill called `name` would be saved under. */
  freeSkillName?(name: string): string;
  /** Trusted app content only; cannot be called through RPC or imported team documents. */
  ensureBuiltin?(
    botId: string,
    input: { key: string; document: SkillDocument; files: readonly PackageFile[] },
    signal: AbortSignal,
    groupId?: string,
  ): Promise<void>;
  /** UI orchestration may materialize a writable copy in the exact source scope. */
  copyAsOwn?(skillId: string, botId: string, signal: AbortSignal, groupId?: string): Promise<Skill>;
  root(botId: string, groupId?: string): string;
  /** Exact effective-set read roots, never the shared parent. Local targets only. */
  roots?(botId: string, groupId?: string): string[];
  packageIds?(botId: string, groupId?: string): string[];
  commandRuntime?(
    botId: string,
    groupId: string | undefined,
    paths: readonly string[],
    runtime?: SkillManagedRuntime,
  ): Promise<
    | {
        environment?: NonNullable<import("@pibot/execution").RunCommandOptions["skillEnv"]>;
        missing?: {
          skillId: string;
          name: string;
          groupId?: string;
          runtime?: SkillManagedRuntime;
        };
        secretBindingsAmbiguous?: true;
        secretBindings?: {
          folder: string;
          skillId: string;
          name: string;
          consent: { zh: string; en: string };
          uses: { variable: string; name: string; revision: number }[];
        };
      }
    | undefined
  >;
  commandSecretsCurrent?(
    botId: string,
    groupId: string | undefined,
    skillId: string,
    uses: readonly { variable: string; name: string }[],
  ): boolean;
  /** Startup validation may still be running; never publish unverified roots to a session. */
  promptEntries(
    botId: string,
    groupId: string | undefined,
    language: "zh" | "en",
    signal: AbortSignal,
  ): Promise<SkillPromptEntry[]>;
  /** Background consumers may wait for the startup sweep without blocking capability registration. */
  waitForPackageMaintenance?(signal: AbortSignal): Promise<void>;
  markUsedAt(
    botId: string,
    path: string,
    groupId?: string,
    language?: "zh" | "en",
  ): string | undefined;
  create(
    botId: string,
    input: SkillDocumentInput,
    source: SkillSource,
    options?: {
      enabled?: boolean;
      files?: readonly PackageFile[];
      folder?: string;
      importSource?: SkillImportSource;
    },
  ): Promise<Skill>;
  exportDocuments(botId: string): Promise<TeamSkill[]>;
  exportPackages(
    botId: string,
    signal: AbortSignal,
    budget?: { bytes: number; files: number },
    options?: { source?: "team" },
  ): Promise<
    {
      folder: string;
      enabled: boolean;
      document: SkillDocument;
      files: PackageFile[];
      reimport?: TeamSkillReimport["reimport"];
    }[]
  >;
  propose(
    context: SkillProposalContext,
    call: LocalToolCall,
    automatic?: SkillConfirmation,
    onPending?: (accept: (confirmation: SkillConfirmation) => Promise<void>) => void,
  ): Promise<LocalToolResult>;
  /**
   * A Bot's own skills with a content fingerprint read from disk (`skillFingerprint`), so
   * a built-in update can tell installed copies nobody touched from edited or renamed ones.
   * `fingerprint` is null when the files cannot be read (treated as changed).
   */
  inventory(
    botId: string,
    signal: AbortSignal,
    /** Role upgrades need external rows for name/folder collisions, not their content hashes. */
    options?: { skipSharedContent?: boolean },
  ): Promise<SkillInventoryItem[]>;
  /** Replaces one of a Bot's own skills with a new package (same row and folder); audited. */
  replace(
    botId: string,
    skillId: string,
    input: SkillDocumentInput,
    files: readonly PackageFile[],
  ): Promise<Skill>;
  /** Removes one of a Bot's own skills (row and folder); audited like the panel's delete. */
  remove(botId: string, skillId: string): Promise<void>;
  /**
   * One skill of the Bot's effective set with its document and folder,
   * for a workflow run (a routine bound to a workflow asks here before each run).
   */
  workflowSkill(botId: string, skillId: string, groupId?: string): Promise<WorkflowSkill>;
  /**
   * An enabled contract skill of the Bot's effective set named by the coordinator in
   * `assign_task` (display name, folder name or id); undefined when there is no such workflow.
   */
  findWorkflow(botId: string, name: string, groupId?: string): Promise<WorkflowSkill | undefined>;
  /** Enabled, readable single-step method keys from the same effective set as findWorkflow. */
  planMethodKeys(
    botId: string,
    groupId: string | undefined,
    signal: AbortSignal,
  ): Promise<string[]>;
  /**
   * Id of the Bot's one enabled contract skill whose deliverables include one of these
   * file names; undefined when none or several match.
   */
  workflowForFiles(
    botId: string,
    files: readonly string[],
    groupId: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
export interface SkillInventoryItem {
  id: string;
  /** Folder name under the Bot's skills directory (a built-in package keeps its own). */
  folder: string;
  name: string;
  source: SkillSource;
  fingerprint: string | null;
  /** `pibot-version` of the installed copy (null when it has none or is unreadable). */
  version: number | null;
}
