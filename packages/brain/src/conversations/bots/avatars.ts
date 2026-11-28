import { randomInt } from "node:crypto";
import { BOT_AVATAR_COLORS, type Bot, RpcError } from "@pibot/protocol-base";

// Keep the backend choices aligned with ui/Avatar; brain must not depend on React.
export const avatarShapes = [
  "blob",
  "pill",
  "drop",
  "pebble",
  "flower",
  "cloud",
  "ghost",
  "cat",
  "hex",
  "circle",
  "bean",
  "tri",
];
export const avatarColors: readonly string[] = BOT_AVATAR_COLORS;
export const avatarEyes = ["marks", "dot", "oval", "pixel", "sleepy"];
export function checkAvatar(patch: Partial<Bot>) {
  for (const [value, choices] of [
    [patch.avatarShape, avatarShapes],
    [patch.avatarColor, avatarColors],
    [patch.avatarEyes, avatarEyes],
  ] as const)
    if (value !== undefined && !choices.includes(value))
      throw new RpcError(-32602, "Invalid avatar choice");
}
export function unusedAvatar(used: ReadonlySet<string>) {
  const choices = avatarShapes
    .flatMap((avatarShape) => avatarColors.map((avatarColor) => ({ avatarShape, avatarColor })))
    .filter((v) => !used.has(`${v.avatarShape}:${v.avatarColor}`));
  if (!choices.length) throw new RpcError(-32011, "No unused avatar combination");
  const choice = choices[randomInt(choices.length)];
  if (!choice) throw new RpcError(-32011, "No unused avatar combination");
  return { ...choice, avatarEyes: "marks" };
}
