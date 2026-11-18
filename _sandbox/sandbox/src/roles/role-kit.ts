import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { parseSkillFile, scanSkillFolders, SKILL_FILE, skillDocument } from "../skill-file.js";
import { statePath } from "../state-paths.js";

// A role's own kit: prompt, skills and tools in one folder per role, read natively by the runtime's own Claude Code
// plugin loader, so nothing here is copied, projected, or swept back on a role change. Separate from
// `.intentic/config/skills/`: a kit skill activates only when its role is worn.

// The role's own directory, and the two paths inside it the daemon knows the meaning of.
export const roleKitDir = (root: string, id: string): string => statePath(root, ".intentic/config/roles/", id);
const manifestPath = (root: string, id: string): string => join(roleKitDir(root, id), ".claude-plugin", "plugin.json");
export const rolePromptPath = (root: string, id: string): string => join(roleKitDir(root, id), "PROMPT.md");
export const roleSkillsRoot = (root: string, id: string): string => join(roleKitDir(root, id), "skills");
export const roleSkillFile = (root: string, id: string, name: string): string => join(roleSkillsRoot(root, id), name, SKILL_FILE);

// Daemon-written so a missing manifest never means a silently empty kit; rewritten on every touch so a renamed label
// doesn't linger. A role id colliding with an installed plugin's name is resolved arbitrarily by the loader.
const manifest = (id: string, label: string | undefined): string =>
    `${JSON.stringify({ name: id, description: `The ${label ?? id} role's own skills and tools.`, version: "0.0.0" }, undefined, 4)}\n`;

// Creates the kit or refreshes its manifest; called by every route that writes into the folder, so nothing lands where
// the loader would skip it.
export const ensureRoleKit = async (root: string, id: string, label: string | undefined): Promise<void> => {
    const path = manifestPath(root, id);
    const next = manifest(id, label);
    if ((await readFile(path, "utf8").catch(() => undefined)) === next) {
        return;
    }
    await mkdir(join(roleKitDir(root, id), ".claude-plugin"), { recursive: true });
    await writeFile(path, next);
};

// Removes the whole folder when its role is deleted; an orphaned kit is unreachable, so leaving it would hide the
// owner's skills from every list.
export const removeRoleKit = async (root: string, id: string): Promise<void> => {
    await rm(roleKitDir(root, id), { recursive: true, force: true });
};

// Plugin dir for the turn wearing this role, gated on the manifest, not the directory: an empty folder the loader would
// refuse must read as "no kit yet", not "broken".
export const roleKitPlugin = async (root: string, id: string): Promise<string | undefined> =>
    (await readFile(manifestPath(root, id), "utf8").catch(undefinedIfMissing)) === undefined ? undefined : roleKitDir(root, id);

// Undefined until the role has one, the state the resolver reads as "follow the sandbox"; a prompt that exists but
// cannot be read throws rather than speak as the sandbox. Trims trailing whitespace, since a textarea-edited prompt
// otherwise reads as a permanently unsaved change.
export const readRolePrompt = async (root: string, id: string): Promise<string | undefined> => {
    const text = await readFile(rolePromptPath(root, id), "utf8").catch(undefinedIfMissing);
    return text?.trimEnd();
};

export const writeRolePrompt = async (root: string, id: string, label: string | undefined, prompt: string): Promise<void> => {
    await ensureRoleKit(root, id, label);
    await writeFile(rolePromptPath(root, id), `${prompt.trimEnd()}\n`);
};

// Deletes rather than stores a blank, so "nothing written" stays one state the resolver already falls back from.
export const removeRolePrompt = async (root: string, id: string): Promise<void> => {
    await rm(rolePromptPath(root, id), { force: true });
};

// allow(silent-catch): a kit is a folder the owner edits by hand, so a skill file that cannot be read is one the kit lacks
const readKitFile = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

// Directory name wins over a disagreeing frontmatter `name:`, since the directory is what the loader keys by. Undefined
// for no such skill; the route turns that into a 404.
export const readRoleSkill = async (root: string, id: string, name: string): Promise<RoleSkill | undefined> => {
    const text = await readKitFile(roleSkillFile(root, id, name));
    if (text === undefined) {
        return undefined;
    }
    const parsed = parseSkillFile(text);
    return { name, description: parsed.description ?? "", body: parsed.body };
};

export interface RoleSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// Every skill this role carries; a directory with no SKILL.md is half-written and skipped.
export const listRoleSkills = (root: string, id: string): Promise<RoleSkill[]> => scanSkillFolders(roleSkillsRoot(root, id), readKitFile);

// Uses the same composer as the sandbox's own skills, so the frontmatter is always loader-readable; prevents a saved
// skill that silently never loads.
export const writeRoleSkill = async (root: string, id: string, label: string | undefined, skill: RoleSkill): Promise<void> => {
    await ensureRoleKit(root, id, label);
    await mkdir(join(roleSkillsRoot(root, id), skill.name), { recursive: true });
    await writeFile(roleSkillFile(root, id, skill.name), skillDocument(skill.name, skill.description, skill.body));
};

export const removeRoleSkill = async (root: string, id: string, name: string): Promise<void> => {
    await rm(join(roleSkillsRoot(root, id), name), { recursive: true, force: true });
};
