import { describe, expect, it } from "vitest";
import { desktopLaunchEnvironment, desktopRegistrationSkipReason } from "./login-item-scope.ts";

describe("Windows packaged test launch scope", () => {
  it("skips account-wide registration without relying on a data-dir argument surviving", () => {
    expect(desktopRegistrationSkipReason({ dev: false, env: { PIBOT_TEST_PACKAGE: "1" } })).toBe(
      "test_package",
    );
  });

  it("keeps the explicit registration boundary and pins the resolved child data root", () => {
    const scope = {
      dev: false,
      env: { PIBOT_DATA_DIR: "D:\\fixture", PIBOT_TEST_PACKAGE: "1" },
    };
    expect(desktopRegistrationSkipReason(scope)).toBe("separate_data_dir");
    expect(desktopLaunchEnvironment(scope, "D:\\canonical")).toEqual({
      PIBOT_DATA_DIR: "D:\\canonical",
      PIBOT_TEST_PACKAGE: "1",
    });
  });

  it("leaves default installed release registration available", () => {
    expect(desktopRegistrationSkipReason({ dev: false, env: {} })).toBeUndefined();
  });
});
