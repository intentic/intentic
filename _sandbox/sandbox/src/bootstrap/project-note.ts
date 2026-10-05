import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { MEMORY_FILE } from "@intentic/constants";
import { mergeFenced } from "../migrations/merge.js";

// A project sandbox's agents learn which folder is the owner's from the workspace's own AGENTS.md, which the daemon
// composes into every turn whichever runtime serves it (agent/prompt/workspace-memory.ts), and a projects host's learn
// the same of every folder attached to it. The note is a fenced block of its own (migrations/merge.ts), so the owner's
// rules around it are never touched, and it is converged every boot and every attach rather than written once, so its
// wording follows the release and its list follows the folders. Here in the boot wiring rather than beside
// workspace-memory: merge.ts's subsystem imports that one, so importing it back would close a cycle.

export const PROJECT_NOTE_FENCE = "intentic:project";

// "`a`", "`a` and `b`", "`a`, `b` and `c`".
const listed = (folders: readonly string[]): string => {
    const quoted = folders.map((folder) => `\`${folder}\``);
    const last = quoted.pop();
    return quoted.length === 0 ? (last ?? "") : `${quoted.join(", ")} and ${last ?? ""}`;
};

// `folders` are the paths agents reach them by: `/work/<name>` in the container. One folder (a project sandbox's, or the
// only one attached to a projects host) reads as it always has; several are named together, in the order they came.
export const projectNote = (folders: readonly [string, ...string[]]): string => {
    const [only] = folders;
    if (folders.length === 1) {
        return [
            "## The owner's project folder",
            "",
            `\`${only}\` is the owner's own folder, synced live with their computer: an edit made there is on their disk at ` +
                "once, and theirs arrive here the same way. So does a deletion: clearing it out (`rm -rf` of what it holds, " +
                "`git clean`, `git stash -u`, `git reset --hard`) clears their copy, and nothing on the way stops it, so never do " +
                "that unless they ask. Its git history stays on their computer. The sandbox tracks the " +
                "folder in a repository of its own, so their commits and branches are not here, and nothing committed here " +
                "reaches theirs. Work inside it, not at the workspace root, unless they ask otherwise.",
        ].join("\n");
    }
    return [
        "## The owner's project folders",
        "",
        `${listed(folders)} are the owner's own folders, each synced live with their computer: an edit made in one is on ` +
            "their disk at once, and theirs arrive here the same way. So does a deletion: clearing one out (`rm -rf` of what " +
            "it holds, `git clean`, `git stash -u`, `git reset --hard`) clears their copy, and nothing on the way stops it, so " +
            "never do that unless they ask. Their git history stays on their computer. The sandbox tracks each folder in a " +
            "repository of its own, so their commits and branches are not here, and nothing committed here reaches theirs. " +
            "Work inside the folder the task is about, not at the workspace root, unless they ask otherwise.",
    ].join("\n");
};

// True when it wrote. A boot that finds the note current leaves the file alone, so it never reads as a change in the
// review, and so does an empty list: a projects host nothing has attached to yet has no folder to name. Only a missing
// file reads as empty: the write replaces the whole file, and those are the owner's own rules.
export const convergeProjectNote = async (workspaceRoot: string, names: readonly string[]): Promise<boolean> => {
    const [first, ...rest] = names.map((name) => join(workspaceRoot, name));
    if (first === undefined) {
        return false;
    }
    const path = join(workspaceRoot, MEMORY_FILE);
    const existing = (await readFile(path, "utf8").catch(undefinedIfMissing)) ?? "";
    const next = mergeFenced(existing, PROJECT_NOTE_FENCE, projectNote([first, ...rest]));
    if (next === existing) {
        return false;
    }
    await writeFile(path, next);
    return true;
};
