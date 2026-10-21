import { join } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";
import { mergeFenced } from "../../migrations/merge.js";
import { textFile } from "../../store/plain-files/text-file.js";

// A project sandbox's agents learn which folder is the owner's from the workspace's own AGENTS.md, which the daemon
// composes into every turn whichever runtime serves it (agent/prompt/workspace-memory.ts). The note is a fenced block of
// its own (migrations/merge.ts), so the owner's rules around it are never touched, and it is converged every boot rather
// than written once, so its wording follows the release. Here in the boot wiring rather than beside workspace-memory:
// merge.ts's subsystem imports that one, so importing it back would close a cycle.
//
// (2026-10-21) The desktop app's one sandbox per computer that folders attached to named every attached folder in the
// same block, with where each was on the owner's computer. That sandbox went, and the sync of its folders with it, so a
// sandbox with no project folder of its own drops the block (dropProjectNote): it would tell agents their edits reach
// the owner's disk, which they no longer do.

export const PROJECT_NOTE_FENCE = "intentic:project";

const START = `<!-- ${PROJECT_NOTE_FENCE}:start -->`;
const END = `<!-- ${PROJECT_NOTE_FENCE}:end -->`;

// `folder` is the path agents reach it by: `/work/<name>` in the container.
export const projectNote = (folder: string): string =>
    [
        "## The owner's project folder",
        "",
        `\`${folder}\` is the owner's own folder, synced live with their computer: an edit made there is on their disk at ` +
            "once, and theirs arrive here the same way. So does a deletion: clearing it out (`rm -rf` of what it holds, " +
            "`git clean`, `git stash -u`, `git reset --hard`) clears their copy, and nothing on the way stops it, so never do " +
            "that unless they ask. Its git history stays on their computer. The sandbox tracks the " +
            "folder in a repository of its own, so their commits and branches are not here, and nothing committed here " +
            "reaches theirs. Work inside it, not at the workspace root, unless they ask otherwise.",
    ].join("\n");

// True when it wrote. A boot that finds the note current leaves the file alone, so it never reads as a change in the
// review. Through textFile, whose read takes only a missing file as empty and whose write is atomic and queued: the write
// replaces the whole file, and those are the owner's own rules.
export const convergeProjectNote = async (workspaceRoot: string, name: string): Promise<boolean> => {
    let wrote = false;
    await textFile(join(workspaceRoot, MEMORY_FILE)).update((existing) => {
        const next = mergeFenced(existing, PROJECT_NOTE_FENCE, projectNote(join(workspaceRoot, name)));
        wrote = next !== existing;
        return wrote ? next : undefined;
    });
    return wrote;
};

// The text without the note's block and the blank lines it stood between; the text itself when it holds none. Pure.
export const withoutProjectNote = (existing: string): string => {
    const start = existing.indexOf(START);
    if (start === -1) {
        return existing;
    }
    const endAt = existing.indexOf(END, start);
    const end = endAt === -1 ? existing.length : endAt + END.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end).trimStart();
    if (before === "") {
        return after;
    }
    return after === "" ? `${before}\n` : `${before}\n\n${after}`;
};

// True when it wrote: a sandbox with no project folder whose AGENTS.md still carries the note (one that folders were
// attached to) has the block taken out; every other file, a missing one included, is left alone.
export const dropProjectNote = async (workspaceRoot: string): Promise<boolean> => {
    let wrote = false;
    await textFile(join(workspaceRoot, MEMORY_FILE)).update((existing) => {
        const next = withoutProjectNote(existing);
        wrote = next !== existing;
        return wrote ? next : undefined;
    });
    return wrote;
};
