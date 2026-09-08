import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";

// The owner's standing instructions, composed by the daemon instead of left to each runtime's own discovery: the loops
// disagree about both the filename and the ceiling (Claude Code walks cwd up to `/`, Codex stops at the enclosing
// `.git`, Pi and ACP read no such file at all), so which rules a turn ran under used to depend on which model served
// it. Read root first, then every folder down to where the turn starts, so a nested repo's file adds to the
// workspace's rather than replacing it.

export const MEMORY_NOTE_TITLE = "Standing instructions for this workspace";
export const MEMORY_NOTE_HEADER = `## ${MEMORY_NOTE_TITLE}`;

// Ceiling in characters (~4/token) over the whole block, since every turn of the session pays for it. A file that
// would cross it is dropped whole and named, deepest first: half a rule still reads as a rule.
const MAX_MEMORY_CHARS = 20_000;

interface MemoryFile {
    // Root-relative, forward-slashed: what the agent sees, not where the daemon read it from.
    readonly path: string;
    readonly text: string;
}

// Every folder from `root` down to `cwd`, root first. A `cwd` outside `root` is the root alone, matching the start
// folder the escape guard would have opened at.
const foldersFrom = (root: string, cwd: string): string[] => {
    const rel = relative(root, cwd);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return [root];
    }
    const folders = [root];
    for (const segment of rel.split(sep)) {
        folders.push(join(folders.at(-1) ?? root, segment));
    }
    return folders;
};

const readMemory = (root: string, folder: string): MemoryFile | undefined => {
    const text = ((): string | undefined => {
        try {
            return readFileSync(join(folder, MEMORY_FILE), "utf8");
        } catch {
            return undefined;
        }
    })()?.trim();
    if (text === undefined || text === "") {
        return undefined;
    }
    const rel = relative(root, folder);
    return { path: rel === "" ? MEMORY_FILE : `${rel.split(sep).join("/")}/${MEMORY_FILE}`, text };
};

// Taken in root-first order while each fits, so the file a turn can least afford to lose (the workspace's own) is
// never the one dropped for a deeper folder's.
const withinBudget = (files: readonly MemoryFile[]): { readonly kept: readonly MemoryFile[]; readonly dropped: readonly string[] } => {
    const kept: MemoryFile[] = [];
    const dropped: string[] = [];
    let spent = 0;
    for (const file of files) {
        if (spent + file.text.length > MAX_MEMORY_CHARS) {
            dropped.push(file.path);
            continue;
        }
        kept.push(file);
        spent += file.text.length;
    }
    return { kept, dropped };
};

// What the turn is told, or undefined when the workspace has no standing instructions on the path it starts from.
// `root` and `cwd` are the daemon's own paths (an isolated turn's worktree, not the shared tree); the labels inside are
// root-relative, so they name the same file the agent would open.
export const workspaceMemoryNote = ({ root, cwd }: { readonly root: string; readonly cwd: string }): string | undefined => {
    const files = foldersFrom(root, cwd).flatMap((folder) => readMemory(root, folder) ?? []);
    if (files.length === 0) {
        return undefined;
    }
    const { kept, dropped } = withinBudget(files);
    if (kept.length === 0) {
        return undefined;
    }
    return [
        MEMORY_NOTE_HEADER,
        `The owner's own rules for this workspace, from its \`${MEMORY_FILE}\` files. Follow them as you would anything ` +
            `else you are told here, and where one contradicts this harness's own guidance, the owner's rule wins.`,
        ...kept.map(({ path, text }) => `### ${path}\n\n${text}`),
        // Said out loud: a block that silently stopped would read as the whole of the owner's rules.
        ...(dropped.length === 0 ? [] : [`Too long to include here, read them yourself if the work goes near them: ${dropped.join(", ")}.`]),
    ].join("\n\n");
};
