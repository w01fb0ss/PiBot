import { z } from "zod";

export const IsolationProbeStageSchema = z.enum([
  "dependencies",
  "prepare_profile",
  "start_host",
  "setup_network",
  "initialize_runtime",
  "wrap_command",
  "spawn_command",
  "run_sandbox",
]);
export type IsolationProbeStage = z.infer<typeof IsolationProbeStageSchema>;

// Keep fixed excerpts of stderr. Paths, arbitrary error messages and command text stay local.
const stderrFeatures = [
  ["ripgrep: not found", /(?:^|: |, )ripgrep \([^\r\n]*\) not found/m],
  ["bubblewrap (bwrap) not installed", /(?:^|: |, )bubblewrap \(bwrap\) not installed/m],
  ["socat not installed", /(?:^|: |, )socat not installed/m],
  ["apply-seccomp: write /proc/self/setgroups", /^apply-seccomp: write \/proc\/self\/setgroups\b/m],
  ["apply-seccomp: write /proc/self/uid_map", /^apply-seccomp: write \/proc\/self\/uid_map\b/m],
  ["apply-seccomp: write /proc/self/gid_map", /^apply-seccomp: write \/proc\/self\/gid_map\b/m],
  ["apply-seccomp: unshare(CLONE_NEWUSER)", /^apply-seccomp: unshare\(CLONE_NEWUSER\)/m],
  [
    "apply-seccomp: unshare(CLONE_NEWPID|CLONE_NEWNS)",
    /^apply-seccomp: unshare\(CLONE_NEWPID\|CLONE_NEWNS\)/m,
  ],
  ["apply-seccomp: mount(/proc)", /^apply-seccomp: mount\(\/proc\)/m],
  ["apply-seccomp: prctl(PR_SET_SECCOMP)", /^apply-seccomp: prctl\(PR_SET_SECCOMP[,)]/m],
  [
    "apply-seccomp: unavailable (not found or not executable)",
    /apply-seccomp[^\r\n]*(?:not found|No such file or directory|Permission denied)/i,
  ],
  [
    "bwrap: No space left on device",
    /^bwrap: [^\r\n]*(?:No space left on device|\(ENOSPC\)|max_\*_namespaces exceeded)/m,
  ],
  [
    "bwrap: namespace creation denied",
    /^bwrap: [^\r\n]*(?:creating new namespace failed|no permissions to create)[^\r\n]*/im,
  ],
  ["bwrap: Operation not permitted", /^bwrap: [^\r\n]*(?:Operation not permitted|\(EPERM\))/m],
  ["bwrap: No such file or directory", /^bwrap: [^\r\n]*No such file or directory/m],
  ["bwrap: Permission denied", /^bwrap: [^\r\n]*Permission denied/m],
  ["sandbox host: module not found", /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/],
  ["sandbox host: resources invalid", /"code":"runner_resources_invalid"/],
  ["sandbox host: resource verification timed out", /"code":"runner_resources_timeout"/],
  ["sandbox runtime: address already in use", /\bEADDRINUSE\b/],
  ["sandbox runtime: permission denied", /\b(?:EACCES|EPERM)\b/],
] as const;

const diagnosticText = new Set<string>(stderrFeatures.map(([text]) => text));
const IsolationProbeSchema = z.object({
  stage: IsolationProbeStageSchema,
  stderr: z
    .string()
    .refine((text) => diagnosticText.has(text))
    .optional(),
});
export type IsolationProbe = z.infer<typeof IsolationProbeSchema>;

export const IsolationStatusSchema = z.object({
  available: z.boolean(),
  reason: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/)
    .optional(),
  probe: IsolationProbeSchema.optional(),
});
export type IsolationStatus = z.infer<typeof IsolationStatusSchema>;

export function isolationProbeStderr(output: string): string | undefined {
  for (const line of output.split("\n")) if (diagnosticText.has(line)) return line;
  return stderrFeatures.find(([, pattern]) => pattern.test(output))?.[0];
}
