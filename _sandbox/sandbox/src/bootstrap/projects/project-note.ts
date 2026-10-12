import { join } from "node:path";
import { MEMORY_FILE } from "@intentic/constants";
import { mergeFenced } from "../../migrations/merge.js";
import { textFile } from "../../store/plain-files/text-file.js";

// A project sandbox's agents learn which folder is the owner's from the workspace's own AGENTS.md, which the daemon
// composes into every turn whichever runtime serves it (agent/prompt/workspace-memory.ts), and a projects host's learn
// the same of every folder attached to it. The note is a fenced block of its own (migrations/merge.ts), so the owner's
// rules around it are never touched, and it is converged every boot and every attach rather than written once, so its
// wording follows the release and its list follows the folders. Here in the boot wiring rather than beside
// workspace-memory: merge.ts's subsystem imports that one, so importing it back would close a cycle.

export const PROJECT_NOTE_FENCE = "intentic:project";

/** Where an attached folder is on the owner's computer (system/projects-registry.ts): its `/work` name and their path. */
export interface ProjectPlace {
    readonly name: string;
    readonly hostPath: string;
    readonly machine: string | undefined;
}

// "`a`", "`a` and `b`", "`a`, `b` and `c`".
const listed = (folders: readonly string[]): string => {
    const quoted = folders.map((folder) => `\`${folder}\``);
    const last = quoted.pop();
    return quoted.length === 0 ? (last ?? "") : `${quoted.join(", ")} and ${last ?? ""}`;
};

// Where each folder is on the owner's computer, one line each, so a path an agent works with turns into the one the owner
// opens, and back: `/work/code-app/src/x.ts` is `C:\Users\radar\code\app\src\x.ts`. Nothing when none is known.
// One folder's place, by the `/work` path agents reach it by.
interface PlacedPath {
    readonly path: string;
    readonly hostPath: string;
    readonly machine: string | undefined;
}

const placesNote = (places: readonly PlacedPath[]): string[] =>
    places.length === 0
        ? []
        : [
              "",
              "Where each is on their computer, for turning a path here into the one they open, and back:",
              "",
              ...places.map((place) => `- \`${place.path}\` is \`${place.hostPath}\`${place.machine === undefined ? "" : ` on ${place.machine}`}`),
          ];

// `folders` are the paths agents reach them by: `/work/<name>` in the container. One folder (a project sandbox's, or the
// only one attached to a projects host) reads as it always has; several are named together, in the order they came.
// `places` are where the ones the sandbox knows of are on the owner's computer, by the same `/work` path.
export const projectNote = (
    folders: readonly [string, ...string[]],
    places: readonly PlacedPath[] = [],
): string => {
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
            ...placesNote(places),
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
        ...placesNote(places),
    ].join("\n");
};

// True when it wrote. A boot that finds the note current leaves the file alone, so it never reads as a change in the
// review, and so does an empty list: a projects host nothing has attached to yet has no folder to name. Through textFile,
// whose read takes only a missing file as empty and whose write is atomic and queued: the write replaces the whole file,
// and those are the owner's own rules, which a boot's converge and an attach's must not race to drop.
export const convergeProjectNote = async (workspaceRoot: string, names: readonly string[], places: readonly ProjectPlace[] = []): Promise<boolean> => {
    const [first, ...rest] = names.map((name) => join(workspaceRoot, name));
    if (first === undefined) {
        return false;
    }
    const known = new Set(names);
    const placed = places
        .filter((place) => known.has(place.name))
        .map((place) => ({ path: join(workspaceRoot, place.name), hostPath: place.hostPath, machine: place.machine }));
    let wrote = false;
    await textFile(join(workspaceRoot, MEMORY_FILE)).update((existing) => {
        const next = mergeFenced(existing, PROJECT_NOTE_FENCE, projectNote([first, ...rest], placed));
        wrote = next !== existing;
        return wrote ? next : undefined;
    });
    return wrote;
};
