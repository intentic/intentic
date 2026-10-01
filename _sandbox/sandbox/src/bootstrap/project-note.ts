import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { MEMORY_FILE } from "@intentic/constants";
import { mergeFenced } from "../migrations/merge.js";

// A project sandbox's agents learn which folder is the owner's from the workspace's own AGENTS.md, which the daemon
// composes into every turn whichever runtime serves it (agent/prompt/workspace-memory.ts). The note is a fenced block
// of its own (migrations/merge.ts), so the owner's rules around it are never touched, and it is converged every boot
// rather than written once, so its wording follows the release. Here in the boot wiring rather than beside
// workspace-memory: merge.ts's subsystem imports that one, so importing it back would close a cycle.

export const PROJECT_NOTE_FENCE = "intentic:project";

// `folder` is the path agents reach it by: `/work/<name>` in the container. Copy-first is the default (the machine agent's
// README, "Copy-first projects"), and which way a folder syncs is the owner's switch on their computer, which this
// daemon does not see: so the note says what copy-first does, and keeps the warning two-way would need.
export const projectNote = (folder: string): string =>
    [
        "## The owner's project folder",
        "",
        `\`${folder}\` is a copy of the owner's own folder on their computer. Their edits arrive here as they make them; ` +
            "what you change here stays in the sandbox until they bring it back, after a restore point, and a file you " +
            "delete is put back from their copy. If they have switched this folder to two-way sync, an edit made here is on " +
            "their disk at once and so is a deletion: clearing it out (`rm -rf` of what it holds, `git clean`, `git stash -u`, " +
            "`git reset --hard`) would clear their copy, so never do that unless they ask. Its git history stays on their " +
            "computer. The sandbox tracks the folder in a repository of its own, so their commits and branches are not here, " +
            "and nothing committed here reaches theirs. Work inside it, not at the workspace root, unless they ask otherwise.",
    ].join("\n");

// True when it wrote. A boot that finds the note current leaves the file alone, so it never reads as a change in the
// review. Only a missing file reads as empty: the write replaces the whole file, and those are the owner's own rules.
export const convergeProjectNote = async (workspaceRoot: string, name: string): Promise<boolean> => {
    const path = join(workspaceRoot, MEMORY_FILE);
    const existing = (await readFile(path, "utf8").catch(undefinedIfMissing)) ?? "";
    const next = mergeFenced(existing, PROJECT_NOTE_FENCE, projectNote(join(workspaceRoot, name)));
    if (next === existing) {
        return false;
    }
    await writeFile(path, next);
    return true;
};
