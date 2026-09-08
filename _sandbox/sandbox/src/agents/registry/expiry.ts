import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";

// Tracks, per landing, which paths history has touched since landedHead as head moves; keyed by landedHead so
// agents/origins.ts and agents/landed-presence.ts share one computation despite reading it differently. Diffs
// accumulate per head move rather than per landing. The union is one-way: a path once touched stays expired even if
// reverted later.

export interface ExpiryTracker {
    /**
     * Paths touched in committed history between `landedHead` and `head` (one-way, see module header). One diff per
     * repo per head move, shared across all landings; one extra diff the first time a landing is asked about.
     */
    readonly committedSince: (dir: string, repo: string, landedHead: string, head: string) => Promise<ReadonlySet<string>>;
    /** Drops one landing's entry once its claim is over (absorbed or retired). */
    readonly drop: (repo: string, landedHead: string) => void;
    // Cardinality and text weight for the durable resource series, matching origins.metrics.
    readonly metrics: () => Readonly<Record<string, number>>;
}

/**
 * Total characters across path lists; the text weight reported by each of the three attribution caches (this module,
 * origins.ts, landed-presence.ts) for the durable resource series.
 */
export const pathWeight = (lists: Iterable<Iterable<string>>): number => {
    let total = 0;
    for (const paths of lists) {
        for (const path of paths) {
            total += path.length;
        }
    }
    return total;
};

export const createExpiryTracker = (git: GitRunner = defaultGit): ExpiryTracker => {
    // Per-repo head plus accumulated paths per landing; `chain` serializes updates so scans cannot interleave.
    const repos = new Map<string, { head: string; entries: Map<string, Set<string>>; chain: Promise<unknown> }>();

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
                            for (const path of moved) {
                                paths.add(path);
                            }
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
                return paths;
            });
            // A failed diff fails only its own caller; nothing is queued behind it.
            current.chain = step.catch(() => undefined);
            return step;
        },
        drop: (repo, landedHead) => {
            repos.get(repo)?.entries.delete(landedHead);
        },
        metrics: () => {
            let entries = 0;
            let pathCharacters = 0;
            for (const state of repos.values()) {
                entries += state.entries.size;
                pathCharacters += pathWeight(state.entries.values());
            }
            return { repos: repos.size, entries, pathCharacters };
        },
    };
};
