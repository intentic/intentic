import { rm } from "node:fs/promises";
import { fileqSkill } from "@intentic/fileq/skill";
import { join } from "node:path";
import { statePath } from "../state-paths.js";
import type { Services } from "../composition.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "../store/loaded-skills.js";
import { parseSkillFile, scanSkillFolders, SKILL_FILE, skillDocument } from "../skill-file.js";

// Baked-tool skills gate a tool already on PATH; writing its SKILL.md surfaces it, so adding one is a registry entry
// here plus its name in the settings `skills` array. That array names baked tools only: an own skill is the owner's
// file, on exactly while its loaded copy exists, and only the owner's own save, switch or delete moves that copy.

export const LSP_SKILL = `---
name: lsp
description: Rename a TypeScript/JavaScript symbol across the project and read compiler diagnostics with the \`lsp\` CLI. Use whenever renaming a symbol, refactoring code other files import, or checking a file for type errors without a full build.
---

# lsp: TypeScript rename & diagnostics

The \`lsp\` CLI (on PATH) drives the native TypeScript compiler. Prefer it over hand-editing imports or eyeballing types: it updates every usage and reports real compiler errors.

## Rename a symbol (updates every usage)
\`lsp rename <file> <symbolName> <newName>\`
- Renames the declaration and every reference across the file's TypeScript project: imports, exports, and call sites all move together, so you never leave a dangling old name or introduce an alias.
- \`<file>\` is the file that DECLARES the symbol; \`<symbolName>\` is its current name.
- Example: \`lsp rename src/user.ts getUser fetchUser\`
- Scope: the invoked file's own tsconfig project. For a symbol also used in OTHER packages of a monorepo, run \`lsp rename\` in each package that declares/re-exports it, then \`lsp diag\` the consumers to catch any stragglers.

## Check files for errors
\`lsp diag <file...>\`
- Prints syntactic + semantic diagnostics as \`path:line:col: error TS<code>: message\`; "no diagnostics" means the file type-checks. Faster than a full build for confirming an edit is sound, run it after edits to verify you updated all usages.

Both verbs refuse rather than guess: when a file's tsconfig or type foundations cannot be loaded (say the dependencies are not installed where the checker runs), they print an \`unavailable\` message and exit 2 instead of answering from a half-loaded project. Treat that as "not checked", use the package's own typecheck or tests, never as a verdict on the code.

Notes: TypeScript/JavaScript only. Pass workspace paths.
`;

// fileq's teaching is fileq's own (@intentic/fileq/skill), the same text the Claude Code plugin ships; the sandbox host
// adds what its image carries (the `ocr` command's PaddleOCR models through the privacy pack, fileq wired as git's
// textconv).
export const FILEQ_SKILL = fileqSkill({ host: "sandbox" });

// skill name → SKILL.md body; the settings `skills` array selects which are written to disk.
const SKILLS: Record<string, string> = {
    lsp: LSP_SKILL,
    fileq: FILEQ_SKILL,
};

// Baked tools this image can teach, on or off; what the Skills list draws its `builtin` rows from.
export const bakedSkillNames = (): readonly string[] => Object.keys(SKILLS);

export const isBakedSkill = (name: string): boolean => name in SKILLS;

// A baked tool's skill text as shipped; the Skills list reads a switched-off tool's description from this same string.
export const bakedSkillText = (name: string): string | undefined => SKILLS[name];

// The two seams every skill read and write here goes through.
type SkillSeams = Pick<Services, "files" | "workspace">;

// Where the owner's own skills are kept, switched on or off.
const ownSkillsRoot = (root: string): string => statePath(root, ".intentic/config/skills/");
export const ownSkillDir = (root: string, name: string): string => join(ownSkillsRoot(root), name);
const ownSkillFile = (root: string, name: string): string => join(ownSkillDir(root, name), SKILL_FILE);

export interface OwnSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// One of the owner's skills, as stored; undefined when the directory is missing or its file unreadable. Callers turn
// that into a 404, not an empty skill.
export const readOwnSkill = async (services: SkillSeams, name: string): Promise<OwnSkill | undefined> => {
    const text = await services.files.read(ownSkillFile(services.workspace.root, name));
    if (text === undefined) {
        return undefined;
    }
    const parsed = parseSkillFile(text);
    // The directory name wins over the declared one: it's what the loader keys the skill by.
    return { name, description: parsed.description ?? "", body: parsed.body };
};

// Every skill the owner has written. A directory with no readable SKILL.md is skipped, not listed empty: it's
// half-written, not a skill that does nothing.
export const listOwnSkills = (services: SkillSeams): Promise<OwnSkill[]> =>
    scanSkillFolders(ownSkillsRoot(services.workspace.root), (path) => services.files.read(path));

export const writeOwnSkill = async (services: SkillSeams, skill: OwnSkill): Promise<void> => {
    await services.files.write(ownSkillFile(services.workspace.root, skill.name), skillDocument(skill.name, skill.description, skill.body));
};

// Deletes the durable copy and the loaded one together; a loaded copy left behind would stay in the agent's context.
export const removeOwnSkill = async (services: SkillSeams, name: string): Promise<void> => {
    await rm(ownSkillDir(services.workspace.root, name), { recursive: true, force: true });
    await removeLoadedSkill(services.files, services.workspace.root, name);
};

// Whether the agent can reach an own skill: its loaded copy is the only account of that, never the settings list.
export const ownSkillOn = async (services: SkillSeams, name: string): Promise<boolean> =>
    (await services.files.read(loadedSkillFile(services.workspace.root, name))) !== undefined;

// Writes or removes the loaded copy of a stored skill; the stored copy is never touched, so off keeps the text.
export const switchOwnSkill = async (services: SkillSeams, skill: OwnSkill, on: boolean): Promise<void> => {
    if (on) {
        await writeLoadedSkill(services.files, services.workspace.root, skill.name, skillDocument(skill.name, skill.description, skill.body));
        return;
    }
    await removeLoadedSkill(services.files, services.workspace.root, skill.name);
};

// Writes every baked tool named in `enabled` and removes the rest; a name that is no baked tool is ignored (it may
// belong to an extension). Never reaches an own skill: a reconcile cannot create or delete the owner's files.
export const reconcileBakedSkills = async (services: SkillSeams, enabled: readonly string[]): Promise<void> => {
    for (const [name, body] of Object.entries(SKILLS)) {
        if (enabled.includes(name)) {
            await writeLoadedSkill(services.files, services.workspace.root, name, body);
            continue;
        }
        await removeLoadedSkill(services.files, services.workspace.root, name);
    }
};
