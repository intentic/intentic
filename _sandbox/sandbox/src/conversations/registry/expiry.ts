import { keyedLock } from "@intentic/base/async";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";

// Tracks, per landing, which paths history has touched since landedHead as head moves; keyed by landedHead so
// conversations/origins.ts and conversations/landed-presence.ts share one computation despite reading it differently. Diffs
// accumulate per head move rather than per landing. The union is one-way: a path once touched stays expired even if
// reverted later.

export interface ExpiryTracker {
    /** Paths touched in committed history between `landedHead` and `head`, restricted to candidates when supplied. */
    readonly committedSince: (dir: string, repo: string, landedHead: string, head: string, candidates?: ReadonlySet<string>) => Promise<ReadonlySet<string>>;
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

interface ExpiryEntry {
    readonly paths: Set<string>;
    readonly at: number;
    watched: Set<string> | undefined;
}

interface RepoExpiry {
    head: string;
    at: number;
    readonly entries: Map<string, ExpiryEntry>;
    // One copy per repository, so a candidate first asked after a revert still sees earlier observed touches.
    readonly touched: Map<string, number>;
}

const diffPaths = async (git: GitRunner, dir: string, from: string, to: string, candidates?: ReadonlySet<string>): Promise<string[]> => {
    if (candidates?.size === 0) {
        return [];
    }
    // Bound argv for large landings; filtering the full diff is still cheaper than retaining it per landing.
    const scoped = candidates !== undefined && [...candidates].reduce((size, path) => size + path.length + 12, 0) < 32_768;
    const args = ["diff", "--name-only", "--no-renames", "-z", from, to];
    // GitRunner makes filename operands literal itself, including names with pathspec syntax.
    const paths = materializedPaths((await git(dir, scoped ? [...args, "--", ...candidates] : args)).stdout);
    return candidates === undefined ? paths : paths.filter((path) => candidates.has(path));
};

export const createExpiryTracker = (git: GitRunner = defaultGit): ExpiryTracker => {
    // Per-repo head plus accumulated paths per landing; updates of one repo run one at a time so scans cannot interleave.
    const repos = new Map<string, RepoExpiry>();
    const inOrder = keyedLock<string>();
    // Characters across every entry's paths, moved on each insert and drop; see PathLists for why it is not summed.
    let pathCharacters = 0;

    const extend = async (entry: ExpiryEntry, state: RepoExpiry, dir: string, from: string, candidates?: ReadonlySet<string>): Promise<void> => {
        if (entry.watched === undefined) {
            return;
        }
        const missing = candidates === undefined ? undefined : new Set([...candidates].filter((path) => !entry.watched?.has(path)));
        if (missing?.size === 0) {
            return;
        }
        const expired = await diffPaths(git, dir, from, state.head, missing);
        for (const [path, at] of state.touched) {
            if (at > entry.at && (missing === undefined || missing.has(path))) {
                expired.push(path);
            }
        }
        pathCharacters += addNew(entry.paths, expired);
        entry.watched = candidates === undefined ? undefined : new Set([...entry.watched, ...candidates]);
    };

    const advance = async (state: RepoExpiry, dir: string, head: string): Promise<void> => {
        if (state.head === head) {
            return;
        }
        if (state.entries.size > 0) {
            const moved = await diffPaths(git, dir, state.head, head);
            state.at += 1;
            for (const path of moved) {
                state.touched.set(path, state.at);
            }
            for (const entry of state.entries.values()) {
                const relevant = entry.watched === undefined ? moved : moved.filter((path) => entry.watched?.has(path));
                pathCharacters += addNew(entry.paths, relevant);
            }
        }
        state.head = head;
    };

    return {
        committedSince: (dir, repo, landedHead, head, candidates) => {
            let state = repos.get(repo);
            if (state === undefined) {
                state = { head, at: 0, entries: new Map(), touched: new Map() };
                repos.set(repo, state);
            }
            const current = state;
            // A failed diff fails only its own caller; nothing is queued behind it.
            return inOrder(repo, async (): Promise<ReadonlySet<string>> => {
                // Shared increment before this landing's lookup, so entries advance together; a content diff, not
                // ancestry.
                await advance(current, dir, head);
                const hit = current.entries.get(landedHead);
                if (hit !== undefined) {
                    await extend(hit, current, dir, landedHead, candidates);
                    return hit.paths;
                }
                // First sight of this landing: the full span, once. Later calls ride the increments.
                const paths = new Set(await diffPaths(git, dir, landedHead, head, candidates));
                current.entries.set(landedHead, { paths, at: current.at, watched: candidates === undefined ? undefined : new Set(candidates) });
                pathCharacters += listWeight(paths);
                return paths;
            });
        },
        drop: (repo, landedHead) => {
            const entries = repos.get(repo)?.entries;
            const dropped = entries?.get(landedHead);
            if (entries === undefined || dropped === undefined) {
                return;
            }
            pathCharacters -= listWeight(dropped.paths);
            entries.delete(landedHead);
            const state = repos.get(repo);
            if (state !== undefined) {
                const oldest = Math.min(...[...entries.values()].map((entry) => entry.at));
                for (const [path, at] of state.touched) {
                    if (at <= oldest) {
                        state.touched.delete(path);
                    }
                }
            }
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
