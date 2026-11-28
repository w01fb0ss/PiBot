import { createTranslator } from "@pibot/i18n";
import { describe, expect, it } from "vitest";
import { isWindowsDirectRunApproval } from "../src/approvals/facts.ts";
import { toolDenialReason } from "../src/tools/presentation.ts";

const windowsCard = {
  category: "run_command",
  facts: [],
  isolation: { available: false, reason: "windows_unisolated" },
} as const;

describe("Windows command risk disclosure", () => {
  it("recognizes structured isolation metadata", () => {
    expect(isWindowsDirectRunApproval({ ...windowsCard, facts: [] })).toBe(true);
  });

  it.each(["windows_unisolated", "windows_requires_approval", "windows_ordinary_command"])(
    "recognizes older delegated cards from %s even when the fact was translated",
    (code) => {
      expect(
        isWindowsDirectRunApproval({
          ...windowsCard,
          isolation: { available: false },
          facts: [{ kind: "warning", value: "This command runs on Windows with your permissions" }],
          explanation: [{ axis: "boundary", code, effect: "ask" }],
        }),
      ).toBe(true);
    },
  );

  it("excludes non-command approvals, isolated commands and Docker", () => {
    expect(isWindowsDirectRunApproval({ ...windowsCard, facts: [], category: "write_file" })).toBe(
      false,
    );
    expect(
      isWindowsDirectRunApproval({ ...windowsCard, facts: [], isolation: { available: true } }),
    ).toBe(false);
    expect(
      isWindowsDirectRunApproval({
        ...windowsCard,
        facts: [],
        explanation: [{ axis: "boundary", code: "docker_access", effect: "ask" }],
      }),
    ).toBe(false);
  });

  it.each([
    ["en", /no command sandbox.*your account.*files.*network/],
    ["zh", /没有命令沙箱.*你的账户.*文件.*网络/],
  ] as const)("discloses the command's permissions in %s", (language, wording) => {
    expect(createTranslator(language)("facts.value.windows_unisolated")).toMatch(wording);
  });
});

it.each([
  ["en", /permanent permission.*“Always allow”/],
  ["zh", /永久授权.*「以后都允许」/],
] as const)("explains the ACP refusal in %s", (language, wording) => {
  expect(
    toolDenialReason(
      { status: "blocked", denialReason: "external_agent_explicit_always_required" },
      createTranslator(language),
    ),
  ).toMatch(wording);
});
