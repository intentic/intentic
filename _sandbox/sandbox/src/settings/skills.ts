import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../workspace/state-paths.js";
import type { Services } from "../composition.js";
import { removeLoadedSkill, writeLoadedSkill } from "./loaded-skills.js";
import { parseSkillFile, skillDocument } from "./skill-file.js";

/* THE SKILLS THIS DAEMON OWNS, the baked tools it ships and the ones the owner wrote, and the one pass that
 * converges both into the directory the agents read.
 *
 * Baked-tool skills exist because the tool binaries are always on PATH (baked by the Dockerfile) while the
 * SKILL.md is what actually surfaces one to the agent: writing it gates the feature and keeps it out of the
 * prompt otherwise. Which are present is driven by the settings `skills` array (SandboxSettings), adding a new
 * baked tool is one registry entry here plus its name in that array, with no settings-contract change.
 *
 * OWN SKILLS are the same mechanism pointed at text the owner typed. They live under `.intentic/config/skills/<name>/`
 * and are copied into `.agents/skills/` by the same pass (loaded-skills.ts owns that folder, its Claude loader
 * projection and the cross-runtime prompt catalogue), for one reason: switching a skill off must not delete
 * what you wrote. The loaded folder holds only what is currently on, so the durable copy has to sit beside the
 * daemon's other state, and then "off" is simply "not copied", with the text intact.
 *
 * The two share the `skills` array as their enabled set rather than having one each: from the owner's side there
 * is one question ("which skills are on"), and one list is what makes the Skills surface's switch mean the same
 * thing on every row it offers one. */

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

export const FILEQ_SKILL = `---
name: fileq
description: Read binary workspace files (docx, xlsx, pptx, pdf, images, audio) as clean budgeted markdown with the \`fileq\` CLI. Use whenever a task needs the contents of an office document, the text layer of a PDF, or the metadata of an image or recording — instead of guessing from the filename or shelling out to ad-hoc converters.
---

# fileq: binary files as markdown

The \`fileq\` CLI (on PATH) turns the workspace files you cannot open as text into markdown, and keeps a
sidecar copy fresh so reading twice derives once.

## Read a file
\`fileq <file>\` (or \`fileq read <file> --budget 8000\`)
- Prints a capsule (format, token cost), the content up to the budget, and \`saved:\` — the sidecar path
  carrying the whole thing. Over budget, the cut is announced with that exact path to Read.
- Formats: docx, xlsx (capped tables), pptx (slides + speaker notes), pdf (text layer), png/jpg/gif/webp
  (dimensions + EXIF), mp3/wav/flac/mp4/… (duration + tags), html.

## Check the sidecar first
A file may already have a shadow at \`.intentic/local/cache/derived/<path>.md\` — front matter says which
source hash it was derived from. \`fileq read\` checks freshness for you, so prefer it over trusting a
shadow's age by eye.

## What it refuses, and why
- A scanned PDF answers "no usable text layer … OCR is not part of this tier" rather than an empty page;
  images say "no visual description". Treat those notes as "not generated", never as "nothing there".
- Plain text (md, csv, txt, code) is not fileq's business: Read it directly.
- Web pages belong to \`webq\`; images for a vision model belong to the Read tool, which shows the pixels.

Exit codes: 0 content, 1 nothing derivable, 2 broken invocation or install.
`;

// skill name → SKILL.md body. The settings `skills` array selects which of these are written to disk.
const SKILLS: Record<string, string> = {
    lsp: LSP_SKILL,
    fileq: FILEQ_SKILL,
};

// The baked tools this image can teach the agent about, whether or not they are currently on, what the Skills
// list draws its `builtin` rows from, so a switched-off one is visible as available rather than missing.
export const bakedSkillNames = (): readonly string[] => Object.keys(SKILLS);

export const isBakedSkill = (name: string): boolean => name in SKILLS;

// A baked tool's skill file as this image ships it, the text the reconciler writes, so the Skills list can read a
// switched-off tool's description out of the same string rather than out of a second copy of it.
export const bakedSkillText = (name: string): string | undefined => SKILLS[name];

// Where the owner's own skills are kept, switched on or off.
const ownSkillsRoot = (root: string): string => statePath(root, ".intentic/config/skills/");
export const ownSkillDir = (root: string, name: string): string => join(ownSkillsRoot(root), name);
const ownSkillFile = (root: string, name: string): string => join(ownSkillDir(root, name), "SKILL.md");

export interface OwnSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// One of the owner's skills, as stored. Undefined when there is no such directory or its file is unreadable,
// callers turn that into a 404 rather than an empty skill, which would read as "this does nothing".
export const readOwnSkill = async (services: Services, name: string): Promise<OwnSkill | undefined> => {
    const text = await services.files.read(ownSkillFile(services.workspace.root, name));
    if (text === undefined) {
        return undefined;
    }
    const parsed = parseSkillFile(text);
    // The DIRECTORY name wins over the declared one: it is what the loader keys the skill by, so trusting a
    // frontmatter line that disagrees would name a row something the agent never sees.
    return { name, description: parsed.description ?? "", body: parsed.body };
};

// Every skill the owner has written, by name. A directory with no readable SKILL.md is skipped rather than
// listed empty, it is a half-written skill, not one that does nothing.
export const listOwnSkills = async (services: Services): Promise<OwnSkill[]> => {
    const entries = await readdir(ownSkillsRoot(services.workspace.root), { withFileTypes: true }).catch(() => []);
    const skills: OwnSkill[] = [];
    for (const entry of entries.filter((candidate) => candidate.isDirectory()).toSorted((a, b) => a.name.localeCompare(b.name))) {
        const skill = await readOwnSkill(services, entry.name);
        if (skill !== undefined) {
            skills.push(skill);
        }
    }
    return skills;
};

export const writeOwnSkill = async (services: Services, skill: OwnSkill): Promise<void> => {
    await services.files.write(ownSkillFile(services.workspace.root, skill.name), skillDocument(skill.name, skill.description, skill.body));
};

// Delete the durable copy AND the loaded one. Only the durable half is this function's own state, but leaving the
// copy behind would keep a deleted skill in the agents' context until the next reconcile happened to notice.
export const removeOwnSkill = async (services: Services, name: string): Promise<void> => {
    await rm(ownSkillDir(services.workspace.root, name), { recursive: true, force: true });
    await removeLoadedSkill(services.files, services.workspace.root, name);
};

/* Converge every skill this daemon owns against the enabled list: written when its name is present (so the agent
 * learns it), removed otherwise. Called at boot and after every settings save, so a change takes effect on the
 * next turn without a restart. An enabled name that names neither a baked tool nor a stored skill is ignored,
 * there is nothing to write, and the name may belong to a skill an extension ships.
 *
 * The owner's own skills are read from disk on each pass rather than being handed in: the list this converges
 * against is a set of NAMES, and the text behind one of them may have been edited by the agent's own file tools
 * since the last save. Reading is what makes that edit reach the next turn. */
export const reconcileSkills = async (services: Services, enabled: readonly string[]): Promise<void> => {
    const own = await listOwnSkills(services);
    const sources: readonly (readonly [string, string])[] = [
        ...Object.entries(SKILLS),
        ...own.map((skill) => [skill.name, skillDocument(skill.name, skill.description, skill.body)] as const),
    ];
    for (const [name, body] of sources) {
        if (enabled.includes(name)) {
            await writeLoadedSkill(services.files, services.workspace.root, name, body);
            continue;
        }
        await removeLoadedSkill(services.files, services.workspace.root, name);
    }
};
