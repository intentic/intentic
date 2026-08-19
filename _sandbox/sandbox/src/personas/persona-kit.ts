import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSkillFile, skillDocument } from "../settings/skill-file.js";
import { statePath } from "../workspace/state-paths.js";

/* A PERSONA'S OWN KIT — the prompt it runs on, the skills it can reach, the tools that are its and nobody
 * else's. One folder per card, beside the card itself.
 *
 * IT IS A CLAUDE CODE PLUGIN, and that is the whole design rather than a convenient shape. The runtime already
 * loads plugin directories per turn (turn-plan's `plugins`, capabilities/plugin-dirs.ts) and its loader reads
 * everything inside one: `skills/<name>/SKILL.md`, `agents/<name>.md`, `commands/`, `hooks/`, `.mcp.json`. So a
 * persona's skills and tools are detected NATIVELY, by the loader that already exists, on the turn that wears
 * the card and no other. Nothing is copied into the workspace, nothing is projected, and nothing has to be
 * swept back out when the persona changes mid-conversation.
 *
 * WHICH IS ALSO WHY THIS FILE PARSES ALMOST NOTHING. The only thing the daemon writes into the folder is the
 * manifest the loader requires; the format of everything else tracks Claude Code through SDK upgrades, exactly
 * as the plugin capability's checkouts do. The two exceptions are PROMPT.md, which is ours because the card
 * points at it, and the skills listing, which the settings surface needs to show what a persona carries.
 *
 * SEPARATE FROM `.intentic/config/skills/`, deliberately. Those are the sandbox's skills — one list, one switch each,
 * every session gets them. These belong to one card: a persona that reviews contracts should not put its
 * checklist in front of a turn that is fixing a build, and the way to say that is for the skill to live where
 * only that persona's turns look. The two do not share the enabled list for the same reason; a kit skill is on
 * whenever its persona is worn, which is what "specific to that persona" has to mean.
 *
 * THE FOLDER IS TRACKED, like the card (workspace-state.ts). It holds prose and files the owner wrote, no
 * credential of any kind, and a persona's instructions are exactly the sort of thing that should arrive in a
 * pull request rather than appear one morning. */

// The card's own directory, and the two paths inside it the daemon knows the meaning of.
export const personaKitDir = (root: string, id: string): string => statePath(root, ".intentic/config/personas/", id);
const manifestPath = (root: string, id: string): string => join(personaKitDir(root, id), ".claude-plugin", "plugin.json");
export const personaPromptPath = (root: string, id: string): string => join(personaKitDir(root, id), "PROMPT.md");
export const personaSkillsRoot = (root: string, id: string): string => join(personaKitDir(root, id), "skills");
export const personaSkillFile = (root: string, id: string, name: string): string => join(personaSkillsRoot(root, id), name, "SKILL.md");

/* The manifest the plugin loader requires before it will read anything else in the folder. Written by the
 * daemon rather than asked of the owner: it carries no decision — the name is the card's id and the
 * description is what the card is already called — and a folder that silently loads nothing because a JSON file
 * is missing is the worst possible failure for a feature whose whole promise is "put a skill here".
 *
 * Rewritten whenever the kit is touched, so renaming a persona's label does not leave the loader announcing the
 * old one.
 *
 * THE NAME IS THE CARD'S ID, which every persona id already satisfies as a plugin name (non-empty, no spaces,
 * no path separators, never leading-dot). One consequence is worth knowing: a persona sharing its id with an
 * installed plugin capability is a name collision the loader resolves by loading one of them, so two things the
 * owner named the same thing will not both be there. Ids are theirs to choose and the manifest lists both. */
const manifest = (id: string, label: string | undefined): string =>
    `${JSON.stringify({ name: id, description: `The ${label ?? id} persona's own skills and tools.`, version: "0.0.0" }, undefined, 4)}\n`;

// Bring the kit into existence (or bring its manifest up to date). Called by every route that writes into the
// folder, so a skill or a prompt can never land in a directory the loader will skip.
export const ensurePersonaKit = async (root: string, id: string, label: string | undefined): Promise<void> => {
    const path = manifestPath(root, id);
    const next = manifest(id, label);
    if ((await readFile(path, "utf8").catch(() => undefined)) === next) {
        return;
    }
    await mkdir(join(personaKitDir(root, id), ".claude-plugin"), { recursive: true });
    await writeFile(path, next);
};

// The whole folder, when its card is deleted. A kit with no persona is unreachable — nothing can wear it — so
// leaving it would be leaving the owner's skills somewhere no list shows them.
export const removePersonaKit = async (root: string, id: string): Promise<void> => {
    await rm(personaKitDir(root, id), { recursive: true, force: true });
};

/* The kit as a plugin dir for the turn wearing this card, or undefined when there is nothing to load. Gated on
 * the MANIFEST rather than on the directory: a folder somebody made and left empty is one the loader would
 * refuse, and a refusal on the turn path reads as the persona being broken rather than as a kit not written
 * yet. Every card that has been given a prompt or a skill has one, because ensurePersonaKit writes it first. */
export const personaKitPlugin = async (root: string, id: string): Promise<string | undefined> =>
    (await readFile(manifestPath(root, id), "utf8").catch(() => undefined)) === undefined ? undefined : personaKitDir(root, id);

/* The persona's system prompt, when it has written one. Undefined for a card that has not — which is every card
 * until somebody types into it, and the state the resolver reads as "follow the sandbox" whatever the card's
 * mode says. Trailing whitespace goes: the file is edited through a textarea and a stored prompt that differs
 * from the typed one only by a newline would read as a permanently unsaved change. */
export const readPersonaPrompt = async (root: string, id: string): Promise<string | undefined> => {
    const text = await readFile(personaPromptPath(root, id), "utf8").catch(() => undefined);
    return text?.trimEnd();
};

export const writePersonaPrompt = async (root: string, id: string, label: string | undefined, prompt: string): Promise<void> => {
    await ensurePersonaKit(root, id, label);
    await writeFile(personaPromptPath(root, id), `${prompt.trimEnd()}\n`);
};

// The prompt file, gone. Called for an emptied prompt rather than storing a blank one, so "custom with nothing
// written" stays a single state the resolver already knows how to fall back from.
export const removePersonaPrompt = async (root: string, id: string): Promise<void> => {
    await rm(personaPromptPath(root, id), { force: true });
};

/* One kit skill, as stored — the DIRECTORY name over any frontmatter `name:` that disagrees, because the
 * directory is what the loader keys the skill by and a row named something the agent never sees is a row that
 * lies. Undefined when there is no such skill, which the route turns into a 404 rather than an empty skill. */
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

// Every skill this persona carries. A directory with no SKILL.md is half-written and skipped, exactly as the
// sandbox's own skills store treats one.
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

// Written through the same composer the sandbox's own skills use, so a kit skill's frontmatter is one the
// loader can always read — the failure this prevents is a saved skill that silently never loads.
export const writePersonaSkill = async (root: string, id: string, label: string | undefined, skill: PersonaSkill): Promise<void> => {
    await ensurePersonaKit(root, id, label);
    await mkdir(join(personaSkillsRoot(root, id), skill.name), { recursive: true });
    await writeFile(personaSkillFile(root, id, skill.name), skillDocument(skill.name, skill.description, skill.body));
};

export const removePersonaSkill = async (root: string, id: string, name: string): Promise<void> => {
    await rm(join(personaSkillsRoot(root, id), name), { recursive: true, force: true });
};
