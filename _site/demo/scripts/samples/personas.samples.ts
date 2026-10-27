import type { GroupSamples } from "./context.ts";

// A card is saved, given a prompt and a skill, read back, and removed with its kit, so the run leaves the list as it was.
export const personasSamples: GroupSamples<`personas`> = () => ({
    list: undefined,
    save: { id: `smoke-persona`, capabilities: [] },
    kit: { id: `maya-support` },
    savePrompt: { id: `smoke-persona`, prompt: `Answer in one sentence.` },
    saveSkill: { id: `smoke-persona`, name: `smoke-skill`, description: `Use when the smoke run asks.`, body: `# Smoke\n\nSay so.` },
    readSkill: { id: `smoke-persona`, name: `smoke-skill` },
    removeSkill: { id: `smoke-persona`, name: `smoke-skill` },
    remove: { id: `smoke-persona` },
});
