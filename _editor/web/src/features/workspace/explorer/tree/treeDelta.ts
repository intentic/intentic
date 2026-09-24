import type { WorkspaceTree, WorkspaceTreeDelta, WorkspaceTreeEntry } from "@intentic/sandbox-contract";

// The shared tree patched with what moved since the generation it holds, as the daemon's resident copy re-listed it.
// A folder's new entries replace its old ones, and a folder kept among them keeps the contents it already had: each
// folder whose own entries moved arrives as an item of its own.

// A folder's entries as the delta lists them, each kept folder with what it already held.
const merged = (before: readonly WorkspaceTreeEntry[] | undefined, after: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry[] => {
    const held = new Map((before ?? []).map((entry) => [entry.path, entry]));
    return after.map((entry) => {
        const previous = held.get(entry.path);
        return entry.type === `dir` && previous?.type === `dir` && previous.children !== undefined ? { ...entry, children: previous.children } : entry;
    });
};

// The entries with the folder at `path` holding `entries`; the same array when no folder there is held.
const placed = (entries: readonly WorkspaceTreeEntry[], path: string, after: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] => {
    let moved = false;
    const next = entries.map((entry) => {
        if (entry.path === path) {
            if (entry.type !== `dir`) {
                return entry;
            }
            moved = true;
            return { ...entry, children: merged(entry.children, after) };
        }
        if (entry.type === `dir` && entry.children !== undefined && path.startsWith(`${entry.path}/`)) {
            const children = placed(entry.children, path, after);
            if (children !== entry.children) {
                moved = true;
                return { ...entry, children: [...children] };
            }
        }
        return entry;
    });
    return moved ? next : entries;
};

/** The tree with the delta applied, or undefined when it holds another generation and must be fetched afresh. */
export const patchedTree = (tree: WorkspaceTree, delta: WorkspaceTreeDelta): WorkspaceTree | undefined => {
    if (tree.generation !== delta.from) {
        return undefined;
    }
    let entries: readonly WorkspaceTreeEntry[] = tree.tree;
    for (const dir of delta.dirs) {
        entries = dir.path === `` ? merged(entries, dir.entries) : placed(entries, dir.path, dir.entries);
    }
    return { ...tree, tree: [...entries], barren: delta.barren ?? tree.barren, generation: delta.generation };
};
