import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillFile, skillDocument } from "../settings/skill-file.js";
import { statePath } from "../workspace/layout/state-paths.js";

// A persona's own kit: prompt, skills and tools in one folder per card, read natively by the runtime's own Claude Code
// plugin loader, so nothing here is copied, projected, or swept back on a persona change. Separate from
// `.intentic/config/skills/`: a kit skill activates only when its persona is worn.

// The card's own directory, and the two paths inside it the daemon knows the meaning of.
export const personaKitDir = (root: string, id: string): string => statePath(root, ".intentic/config/personas/", id);
const manifestPath = (root: string, id: string): string => join(personaKitDir(root, id), ".claude-plugin", "plugin.json");
export const personaPromptPath = (root: string, id: string): string => join(personaKitDir(root, id), "PROMPT.md");
export const personaSkillsRoot = (root: string, id: string): string => join(personaKitDir(root, id), "skills");
export const personaSkillFile = (root: string, id: string, name: string): string => join(personaSkillsRoot(root, id), name, "SKILL.md");

// Daemon-written so a missing manifest never means a silently empty kit; rewritten on every touch so a renamed label
// doesn't linger. A persona id colliding with an installed plugin's name is resolved arbitrarily by the loader.
const manifest = (id: string, label: string | undefined): string =>
    `${JSON.stringify({ name: id, description: `The ${label ?? id} persona's own skills and tools.`, version: "0.0.0" }, undefined, 4)}\n`;

// Creates the kit or refreshes its manifest; called by every route that writes into the folder, so nothing lands where
// the loader would skip it.
export const ensurePersonaKit = async (root: string, id: string, label: string | undefined): Promise<void> => {
    const path = manifestPath(root, id);
    const next = manifest(id, label);
    if ((await readFile(path, "utf8").catch(() => undefined)) === next) {
        return;
    }
    await mkdir(join(personaKitDir(root, id), ".claude-plugin"), { recursive: true });
    await writeFile(path, next);
};

// Removes the whole folder when its card is deleted; an orphaned kit is unreachable, so leaving it would hide the
// owner's skills from every list.
export const removePersonaKit = async (root: string, id: string): Promise<void> => {
    await rm(personaKitDir(root, id), { recursive: true, force: true });
};

// Plugin dir for the turn wearing this card, gated on the manifest, not the directory: an empty folder the loader would
// refuse must read as "no kit yet", not "broken".
export const personaKitPlugin = async (root: string, id: string): Promise<string | undefined> =>
    (await readFile(manifestPath(root, id), "utf8").catch(() => undefined)) === undefined ? undefined : personaKitDir(root, id);

// Undefined until the card has one, the state the resolver reads as "follow the sandbox". Trims trailing whitespace,
// since a textarea-edited prompt otherwise reads as a permanently unsaved change.
export const readPersonaPrompt = async (root: string, id: string): Promise<string | undefined> => {
    const text = await readFile(personaPromptPath(root, id), "utf8").catch(() => undefined);
    return text?.trimEnd();
};

export const writePersonaPrompt = async (root: string, id: string, label: string | undefined, prompt: string): Promise<void> => {
    await ensurePersonaKit(root, id, label);
    await writeFile(personaPromptPath(root, id), `${prompt.trimEnd()}\n`);
};

// Deletes rather than stores a blank, so "nothing written" stays one state the resolver already falls back from.
export const removePersonaPrompt = async (root: string, id: string): Promise<void> => {
    await rm(personaPromptPath(root, id), { force: true });
};

// Directory name wins over a disagreeing frontmatter `name:`, since the directory is what the loader keys by. Undefined
// for no such skill; the route turns that into a 404.
export const readPersonaSkill = async (root: string, id: string, name: string): Promise<PersonaSkill | undefined> => {
    const text = await readFile(personaSkillFile(root, id, name), "utf8").catch(() => undefined);
    if (text === undefined) {
        return undefined;
    }
    const parsed = parseSkillFile(text);
    return { name, description: parsed.description ?? "", body: parsed.body };
};

export interface PersonaSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// Every skill this persona carries; a directory with no SKILL.md is half-written and skipped.
export const listPersonaSkills = async (root: string, id: string): Promise<PersonaSkill[]> => {
    const entries = await readdir(personaSkillsRoot(root, id), { withFileTypes: true }).catch(() => []);
    const skills: PersonaSkill[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const skill = await readPersonaSkill(root, id, entry.name);
        if (skill !== undefined) {
            skills.push(skill);
        }
    }
    return skills;
};

// Uses the same composer as the sandbox's own skills, so the frontmatter is always loader-readable; prevents a saved
// skill that silently never loads.
export const writePersonaSkill = async (root: string, id: string, label: string | undefined, skill: PersonaSkill): Promise<void> => {
    await ensurePersonaKit(root, id, label);
    await mkdir(join(personaSkillsRoot(root, id), skill.name), { recursive: true });
    await writeFile(personaSkillFile(root, id, skill.name), skillDocument(skill.name, skill.description, skill.body));
};

export const removePersonaSkill = async (root: string, id: string, name: string): Promise<void> => {
    await rm(join(personaSkillsRoot(root, id), name), { recursive: true, force: true });
};
