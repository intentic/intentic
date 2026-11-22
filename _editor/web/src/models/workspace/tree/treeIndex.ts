import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { parentDir } from "@intentic/ui/path";

type Listing = readonly WorkspaceTreeEntry[];
type Lazy = ReadonlyMap<string, Listing>;

/*
 * A TREE'S ENTRIES BY PATH, FOUND FOLDER BY FOLDER RATHER THAN COPIED INTO ONE MAP. The tree store and the explorer's
 * rows each walked the whole tree, and every lazy listing with it, into a fresh map on every delta the watcher pushed:
 * a few milliseconds and a megabyte or two of garbage each time in a workspace agents are writing in, several times that
 * with a node_modules listing loaded (2026-11-21). A delta replaces only the listings on the way to what moved
 * (treeDelta.ts), and a lazy listing is replaced whole when read again, so each listing is keyed once, by its own
 * identity, and a lookup is one map read per folder down to the path. Only a reader that walks every entry (a cover's
 * search, its picker) builds the whole map, once per index, in the order the walk always gave.
 */

// allow(module-state): keyed by the listings themselves, which are replaced and never edited, so it cannot go stale or cross sandboxes.
const keyedListings = new WeakMap<Listing, ReadonlyMap<string, WorkspaceTreeEntry>>();
const keyed = (listing: Listing): ReadonlyMap<string, WorkspaceTreeEntry> => {
    const known = keyedListings.get(listing);
    if (known !== undefined) {
        return known;
    }
    const built = new Map(listing.map((entry) => [entry.path, entry]));
    keyedListings.set(listing, built);
    return built;
};

// The entry at `path`, from `root` down through the folders above it. A root that is a folder's contents lists entries
// whose paths start below the workspace's root, so above the first one found every longer prefix is tried at the root.
const descend = (root: Listing, childrenOf: (entry: WorkspaceTreeEntry) => Listing | undefined, path: string): WorkspaceTreeEntry | undefined => {
    let listing: Listing | undefined = root;
    let from = 0;
    while (listing !== undefined) {
        const slash = path.indexOf(`/`, from);
        const found = keyed(listing).get(slash === -1 ? path : path.slice(0, slash));
        if (slash === -1) {
            return found;
        }
        if (found !== undefined) {
            listing = childrenOf(found);
        } else if (listing !== root) {
            return undefined;
        }
        from = slash + 1;
    }
    return undefined;
};

// Every entry in the order a depth-first walk meets it, a later one under the same path replacing the earlier.
const walked = (
    root: Listing,
    childrenOf: (entry: WorkspaceTreeEntry) => Listing | undefined,
    into = new Map<string, WorkspaceTreeEntry>(),
): Map<string, WorkspaceTreeEntry> => {
    const walk = (list: Listing): void => {
        for (const node of list) {
            into.set(node.path, node);
            const children = childrenOf(node);
            if (children !== undefined && children.length > 0) {
                walk(children);
            }
        }
    };
    walk(root);
    return into;
};

// A read-only map over `find`, which builds the whole map (`all`) only for a reader that goes through every entry.
const pathIndex = (
    find: (path: string) => WorkspaceTreeEntry | undefined,
    all: () => Map<string, WorkspaceTreeEntry>,
): ReadonlyMap<string, WorkspaceTreeEntry> => {
    let built: Map<string, WorkspaceTreeEntry> | undefined;
    const whole = (): Map<string, WorkspaceTreeEntry> => {
        built ??= all();
        return built;
    };
    const index: ReadonlyMap<string, WorkspaceTreeEntry> = {
        get: find,
        has: (path) => find(path) !== undefined,
        get size() {
            return whole().size;
        },
        forEach: (visit) => whole().forEach((entry, path) => visit(entry, path, index)),
        entries: () => whole().entries(),
        keys: () => whole().keys(),
        values: () => whole().values(),
        [Symbol.iterator]: () => whole()[Symbol.iterator](),
    };
    return index;
};

/**
 * The tree store's index (useWorkspaceTree's `entriesByPath`): the eager walk's entries, each lazy listing's laid over
 * them. A lazy listing is a folder's own entries, so a path's listing is the one of the folder holding it. `lazy` is
 * copied, so the index keeps answering for the listings it was made with.
 */
export const storeIndex = (tree: Listing, lazy: Lazy): ReadonlyMap<string, WorkspaceTreeEntry> => {
    const listings = new Map(lazy);
    const eager = (entry: WorkspaceTreeEntry): Listing | undefined => entry.children;
    return pathIndex(
        (path) => {
            const listing = listings.get(parentDir(path));
            return (listing === undefined ? undefined : keyed(listing).get(path)) ?? descend(tree, eager, path);
        },
        () => {
            const map = walked(tree, eager);
            for (const listing of listings.values()) {
                for (const child of listing) {
                    map.set(child.path, child);
                }
            }
            return map;
        },
    );
};

/**
 * The explorer's index (useTreeRows' `byPath`): every entry a walk reaches from `tree`, a folder's lazy listing standing
 * for children the eager walk did not carry. `lazy` is copied, as storeIndex copies it.
 */
export const walkIndex = (tree: Listing, lazy: Lazy): ReadonlyMap<string, WorkspaceTreeEntry> => {
    const listings = new Map(lazy);
    const childrenOf = (entry: WorkspaceTreeEntry): Listing | undefined => entry.children ?? listings.get(entry.path);
    return pathIndex(
        (path) => descend(tree, childrenOf, path),
        () => walked(tree, childrenOf),
    );
};
