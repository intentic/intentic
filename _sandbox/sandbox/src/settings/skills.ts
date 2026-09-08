import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../workspace/layout/state-paths.js";
import type { Services } from "../composition.js";
import { loadedSkillFile, removeLoadedSkill, writeLoadedSkill } from "./loaded-skills.js";
import { parseSkillFile, skillDocument } from "./skill-file.js";

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

export const FILEQ_SKILL = `---
name: fileq
description: Read binary workspace files (docx, odt, xlsx, pptx, pdf, epub, ipynb, images, audio) as clean budgeted markdown with the \`fileq\` CLI, and read big text-shaped files (csv, json, logs, archives) without flooding your context. Use whenever a task needs the contents of a document, the text layer of a PDF, the metadata of an image or recording, or a look inside a file too large to cat — instead of guessing from the filename or shelling out to ad-hoc converters.
---

# fileq: binary files as markdown

The \`fileq\` CLI (on PATH) turns the workspace files you cannot open as text into markdown, and keeps a
sidecar copy fresh so reading twice derives once.

## Read a file
\`fileq <file>\` (or \`fileq read <file> --budget 8000\`)
- Prints a capsule (format, token cost), the content up to the budget, and \`saved:\` — the sidecar path
  carrying the whole thing. Over budget, the cut is announced with that exact path to Read.
- Formats: docx and odt (headings, lists, tables), xlsx (capped tables), pptx (slides + speaker notes),
  pdf (text layer; a scan is OCR'd when the image carries tesseract, and the note says the words are
  recognised, not exact), epub (chapters in reading order), ipynb (cells, fenced code, capped outputs),
  png/jpg/gif/webp (dimensions + EXIF), mp3/wav/flac/mp4/… (duration + tags), html.

## Check the sidecar first
A file may already have a shadow at \`.intentic/local/cache/derived/<path>.md\` — front matter says which
source hash it was derived from. \`fileq read\` checks freshness for you, so prefer it over trusting a
shadow's age by eye.

## What it refuses, and why
- A scanned PDF on an image without tesseract answers "no usable text layer … OCR is not part of this tier"
  rather than an empty page; images say "no visual description". Treat those notes as "not generated",
  never as "nothing there". An extension that ships tesseract (paperwork, office) turns the first into OCR.
- Plain text (md, csv, txt, code) is not fileq's business: Read it directly — but see below for the big ones.
- Web pages belong to \`webq\`; images for a vision model belong to the Read tool, which shows the pixels.

Exit codes: 0 content, 1 nothing derivable, 2 broken invocation or install.

## Text-shaped files that are too big to cat
The commonest way to lose a context window is \`cat\` on a file you have not sized. Stat first, then read
the shape, then only what the question needs:
- **Size first**: \`wc -c <file>\`. Under ~20 KB, Read it whole. Over, \`head -100\` and \`tail -100\` to
  orient, \`rg\` for what the task actually asks about, the whole file only if you genuinely need all of it.
- **CSV / TSV**: never \`head -n 5\` blindly — a 50 KB quoted cell in row 1 wrecks it. \`head -c 4000\` for
  a glance; for the shape, python with \`csv\` and a row cap, or \`fileq\` after converting to xlsx is
  overkill: \`python3 -c 'import csv,sys; r=csv.reader(open(sys.argv[1])); print(next(r)); print(sum(1 for _ in r))' <file>\`
  gives header and row count without loading it all.
- **JSON**: structure before content — \`jq 'type' <file>\`, then \`jq 'if type=="array" then length elif type=="object" then keys else . end'\`
  (guarded: \`keys\` errors on a scalar root). Drill only into what was asked. **JSONL**: never \`jq\` the
  whole file; \`head -3 <file> | jq .\` and \`wc -l\`.
- **Logs**: the end is what matters — \`tail -200\`, then \`rg\` for the error text.
- **Archives (zip, tar.*)**: list, never auto-extract — \`unzip -l\`, \`tar -tf\` (auto-detects compression).
  Extract one member with \`unzip -p <zip> <path>\` or \`tar -xOf <tar> <path>\`. A single \`.gz\` has no
  listing: \`zcat <file> | head -50\`.
- **Unknown extension**: \`file <path>\` then \`xxd <path> | head -5\`; if the bytes mean nothing to you,
  ask rather than guess.
`;

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

// Where the owner's own skills are kept, switched on or off.
const ownSkillsRoot = (root: string): string => statePath(root, ".intentic/config/skills/");
export const ownSkillDir = (root: string, name: string): string => join(ownSkillsRoot(root), name);
const ownSkillFile = (root: string, name: string): string => join(ownSkillDir(root, name), "SKILL.md");

export interface OwnSkill {
    readonly name: string;
    readonly description: string;
    readonly body: string;
}

// One of the owner's skills, as stored; undefined when the directory is missing or its file unreadable. Callers turn
// that into a 404, not an empty skill.
export const readOwnSkill = async (services: Services, name: string): Promise<OwnSkill | undefined> => {
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

// Deletes the durable copy and the loaded one together; a loaded copy left behind would stay in the agent's context.
export const removeOwnSkill = async (services: Services, name: string): Promise<void> => {
    await rm(ownSkillDir(services.workspace.root, name), { recursive: true, force: true });
    await removeLoadedSkill(services.files, services.workspace.root, name);
};

// Whether the agent can reach an own skill: its loaded copy is the only account of that, never the settings list.
export const ownSkillOn = async (services: Services, name: string): Promise<boolean> =>
    (await services.files.read(loadedSkillFile(services.workspace.root, name))) !== undefined;

// Writes or removes the loaded copy of a stored skill; the stored copy is never touched, so off keeps the text.
export const switchOwnSkill = async (services: Services, skill: OwnSkill, on: boolean): Promise<void> => {
    if (on) {
        await writeLoadedSkill(services.files, services.workspace.root, skill.name, skillDocument(skill.name, skill.description, skill.body));
        return;
    }
    await removeLoadedSkill(services.files, services.workspace.root, skill.name);
};

// Writes every baked tool named in `enabled` and removes the rest; a name that is no baked tool is ignored (it may
// belong to an extension). Never reaches an own skill: a reconcile cannot create or delete the owner's files.
export const reconcileBakedSkills = async (services: Services, enabled: readonly string[]): Promise<void> => {
    for (const [name, body] of Object.entries(SKILLS)) {
        if (enabled.includes(name)) {
            await writeLoadedSkill(services.files, services.workspace.root, name, body);
            continue;
        }
        await removeLoadedSkill(services.files, services.workspace.root, name);
    }
};
