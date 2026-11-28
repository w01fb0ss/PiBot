import type { Credential, GoogleCompatScope, UserSecretMeta } from "@pibot/protocol-base";

export type SecretUse = { name: string; revision: number };
/** Only runtime needs: revision/assignment checks and transient values for an authorized command. */
export interface UserSecretsPort {
  ready(signal: AbortSignal): Promise<void>;
  choices?(botId: string): string[];
  metadata(name: string): UserSecretMeta | undefined;
  read(name: string, signal: AbortSignal): Promise<string | undefined>;
  command(command: string, botId: string): SecretUse[];
  assertUses(uses: SecretUse[], botId: string): void;
  environment(
    uses: SecretUse[],
    context: { botId: string },
    signal: AbortSignal,
  ): Promise<Record<string, string>>;
  prompt(botId: string): string;
}
export interface CredentialsPort {
  hasSite(botId: string, site: string): boolean;
  candidates(
    botId: string,
    pageUrl: string,
    site?: string,
  ): { site: string; accounts: { id: string; label: string }[] } | undefined;
  secretFor(
    botId: string,
    credentialId: string,
    pageUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    record: Credential;
    username: string;
    password: string;
    totp?: string;
    totpExpiresAt?: number;
    assertCurrent(): void;
  }>;
  takeChoice(runId: string, toolCallId: string): string | undefined;
  approvedInRun(runId: string, site: string): string | undefined;
  approveInRun(runId: string, site: string, credentialId: string): void;
  finishRun(runId: string): void;
  afterHandBack(botId: string): Promise<void>;
  dispose(): void;
}
export interface GoogleCompatPort {
  enabled(scope: GoogleCompatScope): boolean;
}
export interface CredentialServices {
  /** Optional for kernel-only adapters; product credentials owns shared startup preparation. */
  ready?(signal: AbortSignal): Promise<void>;
  userSecrets: UserSecretsPort;
  credentials: CredentialsPort;
  googleCompat: GoogleCompatPort;
}
