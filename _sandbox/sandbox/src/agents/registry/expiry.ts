import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";

// Tracks, per landing, which paths history has touched since landedHead as head moves; keyed by landedHead so
// agents/origins.ts and agents/landed-presence.ts share one computation despite reading it differently. Diffs
// accumulate per head move rather than per landing. The union is one-way: a path once touched stays expired even if
// reverted later.

export interface ExpiryTracker {
/** Paths touched in committed history between `landedHead` and `head` (one-way, see module header). */
    readonly committedSince: (dir: string, repo: string, landedHead: string, head: string) => Promise<ReadonlySet<string>>;
    /** Drops one landing's entry once its claim is over (absorbed or retired). */
    readonly drop: (repo: string, landedHead: string) => void;
    // Cardinality and text weight for the durable resource series, matching origins.metrics.
    readonly metrics: () => Readonly<Record<string, number>>;
}

// Characters across one path list: the unit every attribution cache reports its text weight in.
const listWeight = (paths: Iterable<string>): number => {
    let total = 0;
    for (const path of paths) {
        total += path.length;
    }
    return total;
};

/** A keyed cache of path lists whose total text weight moves with every write, so reading the weight never walks
 * the paths: the caches hold tens of millions of characters and are sampled once a minute on the main thread. */
export interface PathLists {
    readonly get: (key: string) => readonly string[] | undefined;
    readonly set: (key: string, paths: readonly string[]) => void;
    readonly delete: (key: string) => void;
    readonly size: () => number;
    readonly weight: () => number;
}

export const createPathLists = (): PathLists => {
    const lists = new Map<string, { readonly paths: readonly string[]; readonly weight: number }>();
    let weight = 0;
    return {
        get: (key) => lists.get(key)?.paths,
        set: (key, paths) => {
            const own = listWeight(paths);
            weight += own - (lists.get(key)?.weight ?? 0);
            lists.set(key, { paths, weight: own });
        },
        delete: (key) => {
            weight -= lists.get(key)?.weight ?? 0;
            lists.delete(key);
        },
        size: () => lists.size,
        weight: () => weight,
    };
};

// Adds each path the set lacks; returns the characters that joined, the only change to its weight.
const addNew = (paths: Set<string>, incoming: readonly string[]): number => {
    let added = 0;
    for (const path of incoming) {
        if (!paths.has(path)) {
            paths.add(path);
            added += path.length;
        }
    }
    return added;
};

export const createExpiryTracker = (git: GitRunner = defaultGit): ExpiryTracker => {
    // Per-repo head plus accumulated paths per landing; `chain` serializes updates so scans cannot interleave.
    const repos = new Map<string, { head: string; entries: Map<string, Set<string>>; chain: Promise<unknown> }>();
    // Characters across every entry's paths, moved on each insert and drop; see PathLists for why it is not summed.
    let pathCharacters = 0;

    const diffPaths = async (dir: string, from: string, to: string): Promise<string[]> =>
        materializedPaths((await git(dir, ["diff", "--name-only", "--no-renames", "-z", from, to])).stdout);

    return {
        committedSince: (dir, repo, landedHead, head) => {
            let state = repos.get(repo);
            if (state === undefined) {
                state = { head, entries: new Map(), chain: Promise.resolve() };
                repos.set(repo, state);
            }
            const current = state;
            const step = current.chain.then(async (): Promise<ReadonlySet<string>> => {
                // Shared increment before this landing's lookup, so entries advance together; a content diff, not
                // ancestry.
                if (current.head !== head) {
                    if (current.entries.size > 0) {
                        const moved = await diffPaths(dir, current.head, head);
                        for (const paths of current.entries.values()) {
                            pathCharacters += addNew(paths, moved);
                        }
                    }
                    current.head = head;
                }
                const hit = current.entries.get(landedHead);
                if (hit !== undefined) {
                    return hit;
                }
                // First sight of this landing: the full span, once. Later calls ride the increments.
                const paths = new Set(await diffPaths(dir, landedHead, head));
                current.entries.set(landedHead, paths);
                pathCharacters += listWeight(paths);
                return paths;
            });
            // A failed diff fails only its own caller; nothing is queued behind it.
            current.chain = step.catch(() => undefined);
            return step;
        },
        drop: (repo, landedHead) => {
            const entries = repos.get(repo)?.entries;
            const dropped = entries?.get(landedHead);
            if (entries === undefined || dropped === undefined) {
                return;
            }
            pathCharacters -= listWeight(dropped);
            entries.delete(landedHead);
        },
        metrics: () => {
            let entries = 0;
            for (const state of repos.values()) {
                entries += state.entries.size;
            }
            return { repos: repos.size, entries, pathCharacters };
        },
    };
};
