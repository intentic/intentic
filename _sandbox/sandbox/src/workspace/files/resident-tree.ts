import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    isLockedWorkspacePath,
    type WorkspaceLink,
    type WorkspaceTree,
    type WorkspaceTreeDelta,
    type WorkspaceTreeEntry,
} from "@intentic/sandbox-contract";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import { byKind, type Entry, followEntries } from "./dir-reads.js";
import { descendable, MAX_ENTRIES } from "./workspace-tree.js";
import { realPathOf } from "./workspace-files-paths.js";

// The shared workspace's tree kept in memory: listed once as the walk lists it, then re-listed only where a watcher
// batch says something moved. What it answers is the walk's own answer, its budget and barren list included, so the
// route stops walking /work on every request and every open tab stops asking.

// Past this many entries no further directory is listed, which leaves it unopened as the walk's budget does; it bounds
// the memory held, not a response.
export const MODEL_MAX_ENTRIES = 200_000;

// One entry of a listing, with what the walk decides about it: whether its name is ignored, and whether it is opened.
interface Node extends Entry {
    readonly path: string;
    readonly ignored: boolean;
    readonly opened: boolean;
}

// One listed directory, with the ignore state inside it (its parents' layers and its own .gitignore). `nodes` is
// undefined when it could not be read, which the walk shows as empty.
interface Listing {
    readonly abs: string;
    readonly real: string;
    readonly scope: IgnoreScope;
    readonly nodes: readonly Node[] | undefined;
}

export interface ResidentTree {
    // The first listing; everything else waits for it.
    readonly ready: Promise<void>;
    // The walk's view of the tree, stamped with the generation it reflects.
    readonly view: () => WorkspaceTree;
    // Re-lists what a batch of changed root-relative paths touched; nothing when nothing listed moved. An empty batch is
    // the watcher's "too many to name", answered by listing everything again.
    readonly apply: (paths: readonly string[]) => Promise<WorkspaceTreeDelta | undefined>;
    // Lists everything again and says what moved, for a batch too large to name or a watcher that may have missed one.
    readonly rebuild: () => Promise<WorkspaceTreeDelta | undefined>;
}

const parentOf = (path: string): string => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const childOf = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

// Whether `path` is `dir` or lies beneath it; the root holds everything.
const within = (path: string, dir: string): boolean => dir === "" || path === dir || path.startsWith(`${dir}/`);

const depthOf = (path: string): number => (path === "" ? 0 : path.split("/").length);

const shallow = (node: Node): WorkspaceTreeEntry => ({
    name: node.name,
    path: node.path,
    type: node.isDir ? "dir" : "file",
    ...(node.size === undefined ? {} : { size: node.size }),
    ...(node.ignored ? { ignored: true } : {}),
    ...(node.link === undefined ? {} : { link: node.link }),
});

const entriesOf = (listing: Listing): WorkspaceTreeEntry[] => (listing.nodes ?? []).map(shallow);

// Whether two listings show the same entries; the ignore state is compared through what it decided.
const sameEntries = (left: Listing, right: Listing): boolean =>
    left.nodes === undefined || right.nodes === undefined
        ? left.nodes === right.nodes
        : left.nodes.length === right.nodes.length &&
          left.nodes.every((node, index) => {
              const other = right.nodes![index]!;
              return node.opened === other.opened && JSON.stringify(shallow(node)) === JSON.stringify(shallow(other));
          });

export const createResidentTree = (root: string, { maxEntries = MODEL_MAX_ENTRIES } = {}): ResidentTree => {
    const base = resolve(root);
    let realRoot = base;
    let listings = new Map<string, Listing>();
    let held = 0;
    let generation = 0;
    let barrenAt = -1;
    let barren: string[] = [];

    const nodeOf = (entry: Entry, dir: string, dirReal: string, scope: IgnoreScope): Node => {
        const path = childOf(dir, entry.name);
        const ignored = scope.isIgnored(entry.name, path, entry.isDir);
        return { ...entry, path, ignored, opened: entry.isDir && !ignored && !isLockedWorkspacePath(path) && descendable(entry, dirReal) };
    };

    // One directory as the walk lists it: its own .gitignore layered on first, then every entry followed and sorted.
    const list = async (abs: string, real: string, rel: string, parentScope: IgnoreScope): Promise<Listing> => {
        const scope = await parentScope.descend(abs, rel);
        // allow(silent-catch): a directory that cannot be read lists as unknown, which is not empty.
        const dirents = await readdir(abs, { withFileTypes: true }).catch(() => undefined);
        if (dirents === undefined) {
            return { abs, real, scope, nodes: undefined };
        }
        const entries = await followEntries(abs, real, realRoot, dirents);
        return { abs, real, scope, nodes: entries.map((entry) => nodeOf(entry, rel, real, scope)) };
    };

    // Breadth-first from one directory, in the walk's order, into `into`; stops opening directories at the cap.
    const listFrom = async (
        start: { readonly abs: string; readonly real: string; readonly rel: string; readonly parentScope: IgnoreScope },
        into: Map<string, Listing>,
    ): Promise<void> => {
        let level = [start];
        while (level.length > 0) {
            const next: (typeof start)[] = [];
            for (const job of level) {
                if (held >= maxEntries) {
                    return;
                }
                const listing = await list(job.abs, job.real, job.rel, job.parentScope);
                into.set(job.rel, listing);
                held += listing.nodes?.length ?? 0;
                for (const node of listing.nodes ?? []) {
                    if (node.opened) {
                        next.push({ abs: join(job.abs, node.name), real: node.real, rel: node.path, parentScope: listing.scope });
                    }
                }
            }
            level = next;
        }
    };

    // Drops a directory's listing and every listing beneath it, giving back what they held.
    const forget = (dir: string): void => {
        for (const [path, listing] of listings) {
            if (within(path, dir)) {
                held -= listing.nodes?.length ?? 0;
                listings.delete(path);
            }
        }
    };

    // The ignore state a directory's own layer goes onto: its parent's, or nothing above the root.
    const scopeAbove = (dir: string): IgnoreScope | undefined =>
        dir === "" ? createIgnoreScope() : listings.get(parentOf(dir))?.scope;

    // Re-lists one directory, re-following only the names the batch named and any it never held; a folder that
    // appeared is listed whole, one that went is forgotten whole.
    const relist = async (dir: string, names: ReadonlySet<string>, changed: Map<string, Listing>): Promise<void> => {
        const old = listings.get(dir);
        if (old === undefined) {
            return;
        }
        // allow(silent-catch): a directory that cannot be read becomes unknown, which is not empty.
        const dirents = await readdir(old.abs, { withFileTypes: true }).catch(() => undefined);
        const kept = new Map((old.nodes ?? []).map((node) => [node.name, node]));
        const fresh = (dirents ?? []).filter((dirent) => names.has(dirent.name) || !kept.has(dirent.name));
        const followed = new Map((await followEntries(old.abs, old.real, realRoot, fresh)).map((entry) => [entry.name, entry]));
        const nodes =
            dirents === undefined
                ? undefined
                : dirents
                      .map((dirent) => {
                          const entry = followed.get(dirent.name);
                          return entry === undefined ? kept.get(dirent.name)! : nodeOf(entry, dir, old.real, old.scope);
                      })
                      .sort(byKind);
        const listing: Listing = { ...old, nodes };
        held += (nodes?.length ?? 0) - (old.nodes?.length ?? 0);
        listings.set(dir, listing);
        if (!sameEntries(old, listing)) {
            changed.set(dir, listing);
        }
        const opened = new Set((nodes ?? []).filter((node) => node.opened).map((node) => node.path));
        for (const node of old.nodes ?? []) {
            if (node.opened && !opened.has(node.path)) {
                forget(node.path);
            }
        }
        for (const node of nodes ?? []) {
            if (node.opened && !listings.has(node.path)) {
                const added = new Map<string, Listing>();
                await listFrom({ abs: join(old.abs, node.name), real: node.real, rel: node.path, parentScope: listing.scope }, added);
                for (const [path, sub] of added) {
                    listings.set(path, sub);
                    changed.set(path, sub);
                }
            }
        }
    };

    // Lists a directory and everything beneath it again from the ignore state above it: its own .gitignore moved, so
    // every verdict below may have too. Only the listings that came out different are news.
    const relistSubtree = async (dir: string, changed: Map<string, Listing>): Promise<void> => {
        const old = listings.get(dir);
        const above = scopeAbove(dir);
        if (old === undefined || above === undefined) {
            return;
        }
        const before = new Map([...listings].filter(([path]) => within(path, dir)));
        forget(dir);
        const after = new Map<string, Listing>();
        await listFrom({ abs: old.abs, real: old.real, rel: dir, parentScope: above }, after);
        for (const [path, listing] of after) {
            listings.set(path, listing);
            const previous = before.get(path);
            if (previous === undefined || !sameEntries(previous, listing)) {
                changed.set(path, listing);
            }
        }
    };

    // Every barren directory, as the empty-dirs scan finds it: a plain folder, neither ignored nor locked, whose every
    // entry is itself a barren folder. Anything unlisted or unreadable is unknown, and unknown is never barren.
    const barrenDirs = (): string[] => {
        if (barrenAt === generation) {
            return barren;
        }
        const visit = (dir: string): { readonly empty: boolean; readonly found: string[] } => {
            const nodes = listings.get(dir)?.nodes;
            if (nodes === undefined) {
                return { empty: false, found: [] };
            }
            let empty = true;
            const found: string[] = [];
            for (const node of nodes) {
                const plain = node.isDir && node.link === undefined && !node.ignored && !isLockedWorkspacePath(node.path);
                if (!plain) {
                    empty = false;
                    continue;
                }
                const inner = visit(node.path);
                empty &&= inner.empty;
                found.push(...inner.found);
            }
            return empty ? { empty, found: [dir, ...found] } : { empty, found };
        };
        barren = visit("").found.filter((path) => path !== "");
        barrenAt = generation;
        return barren;
    };

    // What moved, as one delta: every changed listing, parents first, and the barren list when that moved too.
    const deltaOf = (changed: ReadonlyMap<string, Listing>): WorkspaceTreeDelta | undefined => {
        if (changed.size === 0) {
            return undefined;
        }
        const before = barrenDirs();
        const from = generation;
        generation += 1;
        const after = barrenDirs();
        const dirs = [...changed]
            .sort(([left], [right]) => depthOf(left) - depthOf(right) || left.localeCompare(right))
            .map(([path, listing]) => ({ path, entries: entriesOf(listing) }));
        const moved = before.length !== after.length || before.some((path, index) => path !== after[index]);
        return { from, generation, dirs, ...(moved ? { barren: after } : {}) };
    };

    const build = async (): Promise<Map<string, Listing>> => {
        realRoot = await realPathOf(base);
        held = 0;
        const built = new Map<string, Listing>();
        await listFrom({ abs: base, real: realRoot, rel: "", parentScope: createIgnoreScope() }, built);
        return built;
    };

    const ready = build().then((built) => {
        listings = built;
    });

    const rebuild = async (): Promise<WorkspaceTreeDelta | undefined> => {
        const before = listings;
        const after = await build();
        const changed = new Map([...after].filter(([path, listing]) => {
            const previous = before.get(path);
            return previous === undefined || !sameEntries(previous, listing);
        }));
        listings = after;
        return deltaOf(changed);
    };

    const apply = async (paths: readonly string[]): Promise<WorkspaceTreeDelta | undefined> => {
        if (paths.length === 0) {
            return rebuild();
        }
        const named = new Map<string, Set<string>>();
        const layered = new Set<string>();
        for (const path of paths) {
            if (path === "") {
                continue;
            }
            const dir = parentOf(path);
            if (nameOf(path) === ".gitignore") {
                layered.add(dir);
            }
            const names = named.get(dir) ?? new Set<string>();
            names.add(nameOf(path));
            named.set(dir, names);
        }
        const changed = new Map<string, Listing>();
        // Topmost first, and a layer inside one already re-listed is covered by it.
        const deep = [...layered].sort((left, right) => depthOf(left) - depthOf(right));
        const redone: string[] = [];
        for (const dir of deep) {
            if (redone.some((done) => within(dir, done))) {
                continue;
            }
            await relistSubtree(dir, changed);
            redone.push(dir);
        }
        for (const dir of [...named.keys()].sort((left, right) => depthOf(left) - depthOf(right))) {
            if (!redone.some((done) => within(dir, done))) {
                await relist(dir, named.get(dir)!, changed);
            }
        }
        return deltaOf(changed);
    };

    // The walk's own breadth-first cut over what is held: a folder that won't fit the remaining budget stays unopened
    // whole, and only the root counts what it drops.
    const view = (): WorkspaceTree => {
        type Draft = { name: string; path: string; type: "file" | "dir"; size?: number; ignored?: boolean; link?: WorkspaceLink; children?: Draft[] };
        let budget = MAX_ENTRIES;
        const tree: Draft[] = [];
        let hidden = 0;
        let level: { readonly dir: string; readonly owner?: Draft }[] = [{ dir: "" }];
        while (level.length > 0 && budget > 0) {
            const next: (typeof level)[number][] = [];
            for (const job of level) {
                if (budget <= 0) {
                    break;
                }
                const listing = listings.get(job.dir);
                if (listing === undefined) {
                    continue;
                }
                if (listing.nodes === undefined) {
                    if (job.owner !== undefined) {
                        job.owner.children = [];
                    }
                    continue;
                }
                if (job.owner !== undefined && listing.nodes.length > budget) {
                    continue;
                }
                const children: Draft[] = [];
                for (const node of listing.nodes) {
                    if (budget <= 0) {
                        break;
                    }
                    budget -= 1;
                    const entry: Draft = {
                        name: node.name,
                        path: node.path,
                        type: node.isDir ? "dir" : "file",
                        ...(node.size === undefined ? {} : { size: node.size }),
                        ...(node.ignored ? { ignored: true } : {}),
                        ...(node.link === undefined ? {} : { link: node.link }),
                    };
                    children.push(entry);
                    if (node.opened) {
                        next.push({ dir: node.path, owner: entry });
                    }
                }
                if (job.owner === undefined) {
                    tree.push(...children);
                    hidden = listing.nodes.length - children.length;
                    continue;
                }
                job.owner.children = children;
            }
            level = next;
        }
        return { root: base, tree, hidden, barren: barrenDirs(), generation };
    };

    return { ready, view, apply, rebuild };
};
