export interface LoginItemScope {
  dev: boolean;
  env: Readonly<NodeJS.ProcessEnv>;
}

export type DesktopRegistrationSkipReason = "development" | "separate_data_dir" | "test_package";

// The entry point folds CLI overrides into the env. Even an override naming the default
// directory must not give this launch authority over account-wide registrations.
export function desktopRegistrationSkipReason({
  dev,
  env,
}: LoginItemScope): DesktopRegistrationSkipReason | undefined {
  if (dev) return "development";
  if (env.PIBOT_DATA_DIR !== undefined) return "separate_data_dir";
  if (env.PIBOT_TEST_PACKAGE === "1") return "test_package";
  return undefined;
}

export function loginItemSyncEnabled(scope: LoginItemScope): boolean {
  return desktopRegistrationSkipReason(scope) === undefined;
}

export function createLoginItemSync(
  scope: LoginItemScope,
  synchronize: (openAtLogin: boolean) => Promise<void>,
) {
  const enabled = loginItemSyncEnabled(scope);
  return async (openAtLogin: boolean): Promise<void> => {
    if (enabled) await synchronize(openAtLogin);
  };
}

export function desktopLaunchEnvironment(
  scope: LoginItemScope,
  dataDir: string,
  dataDirDisplayPath?: string,
) {
  // Propagating the resolved default as an override would disable login sync in the next role.
  // Explicit/test roots still travel canonically so GUI and owner retain the same writer root.
  return {
    ...scope.env,
    ...(loginItemSyncEnabled(scope) ? {} : { PIBOT_DATA_DIR: dataDir }),
    ...(dataDirDisplayPath && dataDirDisplayPath !== dataDir
      ? { PIBOT_DATA_DIR_DISPLAY_PATH: dataDirDisplayPath }
      : {}),
  };
}
