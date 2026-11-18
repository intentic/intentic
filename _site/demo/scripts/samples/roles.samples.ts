import type { GroupSamples } from "./context.ts";

// A card is saved, given a prompt and a skill, read back, and removed with its kit, so the run leaves the list as it was.
export const rolesSamples: GroupSamples<`roles`> = () => ({
    list: undefined,
    save: { id: `smoke-role`, capabilities: [] },
    kit: { id: `maya-support` },
    savePrompt: { id: `smoke-role`, prompt: `Answer in one sentence.` },
    saveSkill: { id: `smoke-role`, name: `smoke-skill`, description: `Use when the smoke run asks.`, body: `# Smoke\n\nSay so.` },
    readSkill: { id: `smoke-role`, name: `smoke-skill` },
    removeSkill: { id: `smoke-role`, name: `smoke-skill` },
    remove: { id: `smoke-role` },
});
