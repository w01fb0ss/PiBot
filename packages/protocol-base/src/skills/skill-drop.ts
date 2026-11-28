import { z } from "zod";
import { AbsolutePathSchema } from "../core/boundaries.ts";

export const SKILL_DROP_CHANNEL = "pibot:skills-drop";
export const SKILL_DROP_MAX_FILES = 32;
export const SkillDropPathsSchema = z.array(AbsolutePathSchema).min(1).max(SKILL_DROP_MAX_FILES);
