import { z } from "zod";
import type { SideInput } from "../../../../workbench/side/sideTabs";

// The core's skill side view: one skill's page beside whatever section is open, so pressing a skill in Settings never
// takes the reader away from Settings. Its input is built and parsed here, so the opener (AgentSkills), the body
// (SideSkill.vue) and the registration (coreSideViews.ts) cannot disagree about what a skill tab holds.

export const SKILL_SIDE_VIEW = `skill`;

export const SkillSideInputSchema = z.object({
    // The daemon's id for it, or NEW_SKILL for one being written.
    skill: z.string().min(1),
    // Its name as the list showed it, so the tab is labelled before the list has answered after a reload.
    name: z.string().min(1),
});

export const skillSideInput = (skill: string, name: string): SideInput => ({ skill, name });
