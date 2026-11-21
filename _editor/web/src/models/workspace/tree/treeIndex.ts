import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";

// Flattens the tree to a path → entry map so a file's size/type resolves in O(1) without re-walking the tree
// (useWorkspaceTree's `entriesByPath`).
const buildMap = (nodes: readonly WorkspaceTreeEntry[]): Map<string, WorkspaceTreeEntry> => {
    const map = new Map<string, WorkspaceTreeEntry>();
    const walk = (list: readonly WorkspaceTreeEntry[]): void => {
        for (const node of list) {
            map.set(node.path, node);
            if (node.children) {
                walk(node.children);
            }
        }
    };
    walk(nodes);
    return map;
};

/*
 * ONE PATH INDEX PER SNAPSHOT, shared by every caller. useWorkspaceTree() is called by each surface that draws or searches
 * files (the explorer, each composer's mention picker, the palette), and each of them walked the whole tree into a map of
 * its own, then copied it, on every delta the watcher pushed: in a workspace agents are writing in, that was the tree
 * walked and copied several times a second, most of the page's garbage after its animations (2026-11-21). The maps are
 * read, never written, so callers can share them.
 */
const eagerIndexes = new WeakMap<readonly WorkspaceTreeEntry[], Map<string, WorkspaceTreeEntry>>();
export const eagerIndex = (nodes: readonly WorkspaceTreeEntry[]): Map<string, WorkspaceTreeEntry> => {
    const known = eagerIndexes.get(nodes);
    if (known !== undefined) {
        return known;
    }
    const built = buildMap(nodes);
    eagerIndexes.set(nodes, built);
    return built;
};

// The eager index with every lazy listing laid over it, for the last pair of inputs: the same snapshot and the same
// listings (a listing is replaced, never edited, when it is read again) give back the same map.
// allow(module-state): a cache of a derivation, keyed by the very objects it was derived from, so it cannot cross sandboxes.
let lastSpanning:
    { eager: Map<string, WorkspaceTreeEntry>; lazy: [string, readonly WorkspaceTreeEntry[]][]; map: Map<string, WorkspaceTreeEntry> } | undefined;
export const spanningIndex = (
    eager: Map<string, WorkspaceTreeEntry>,
    lazy: ReadonlyMap<string, readonly WorkspaceTreeEntry[]>,
): Map<string, WorkspaceTreeEntry> => {
    if (lazy.size === 0) {
        return eager;
    }
    const listings = [...lazy.entries()];
    const last = lastSpanning;
    if (
        last !== undefined &&
        last.eager === eager &&
        last.lazy.length === listings.length &&
        listings.every(([path, entries], index) => last.lazy[index]?.[0] === path && last.lazy[index]?.[1] === entries)
    ) {
        return last.map;
    }
    const map = new Map(eager);
    for (const [, entries] of listings) {
        for (const child of entries) {
            map.set(child.path, child);
        }
    }
    lastSpanning = { eager, lazy: listings, map };
    return map;
};
