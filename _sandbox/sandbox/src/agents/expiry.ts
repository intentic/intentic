import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { materializedPaths } from "../git/changes.js";

/* WHICH PATHS HISTORY HAS TOUCHED SINCE A LANDING WENT IN — the one span in the whole attribution machinery
 * whose far end is the MOVING head, shared by both of its readers (agents/origins.ts, which reads a touched
 * path as "the claim ended", and agents/landed-presence.ts, which reads it as "the work is safe in history").
 * They disagree — deliberately — about what the answer MEANS; this module only makes sure they pay for it once.
 *
 * WHY IT IS INCREMENTAL. The naive cache is keyed on (landedHead, head), and a commit moves `head` — so every
 * commit invalidated every unspent landing's entry, and the next scan re-derived all of them as one
 * `git diff landedHead..head` EACH, sequentially, inside the repo lock, on the commit's own response path. On
 * a workspace with 150 unspent landings that was 150 spawns per commit; the daemon's perf log clocked the
 * commit route at a 7s mean with a 34s tail, and this loop was most of it. But when head moves H1→H2, every
 * landing's new answer is its old answer plus the SAME increment: diff(H1, H2), one spawn, shared. So each
 * repo remembers the head it last answered for, and a head move costs one diff unioned into every entry.
 *
 * THE UNION IS A ONE-WAY DOOR, and that is a semantic choice, not an approximation. A commit-then-revert
 * leaves a path in diff(H1,H2) but out of a fresh diff(landedHead,H2) — the recompute would resurrect the
 * claim, the union keeps it expired. Expired is right: the commit put the agent's lines in a reachable commit,
 * and both readers already treat that as terminal at the landing granularity (the `absorbed` mark on the
 * registry entry, agents-store.ts) with exactly this reasoning. A tree reset hard behind a landing's head is
 * the one case the door answers loosely, and it is the case the codebase already accepts everywhere shas are
 * cached: that tree has bigger problems than an attribution chip.
 *
 * The fallback stays exact: a landing this tracker has never answered for (first sight, or the first scan
 * after a restart) gets the full diff(landedHead, head) once, and rides the increments from there. Paths are
 * COPIED out of the stdout (materializedPaths) — these sets live for the life of the landing, and a sliced
 * path pins its whole parent listing (see the leak documented at origins.ts). */

export interface ExpiryTracker {
    /** Paths whose committed content history has touched between `landedHead` and `head` (one-way — see the
     *  header). One spawn per repo per head move, shared across every landing; one extra spawn the first time
     *  a landing is asked about. */
    readonly committedSince: (dir: string, repo: string, landedHead: string, head: string) => Promise<ReadonlySet<string>>;
    /** Forget one landing's entry — its claim is over (absorbed, or retired), so its set is dead weight. */
    readonly drop: (repo: string, landedHead: string) => void;
    // Cardinality and text weight, for the durable resource series — the same accounting, and the same reason,
    // as origins.metrics.
    readonly metrics: () => Readonly<Record<string, number>>;
}

/** Total characters across lists of paths — the text weight of one of the attribution caches, for the durable
 *  resource series. Here because all three caches in this pair (this module's, origins.ts's spans,
 *  landed-presence.ts's) report the same figure the same way, and these maps were the daemon's memory leak
 *  once: the accounting is what keeps a regrowth visible, so it should not be three near-copies. */
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
    // Per repo: the head every entry below is current AT, and one accumulated path set per landing (keyed by
    // its landedHead — the same key both consumers retire on). `chain` serializes the state transitions: two
    // overlapping scans (the commit route's one-repo read racing a workspace-wide one) must not interleave the
    // increment mid-union, or entries end up current at mixed heads and the per-entry union stops being sound.
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
                /* The shared increment, taken BEFORE this landing's own lookup so every entry in the repo
                 * advances together. `head` regressing or jumping sideways (a reset, a checkout) still diffs
                 * correctly: the increment is a content comparison, not an ancestry walk. */
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
                // First sight of this landing: the exact full span, once. Everything after rides the increments.
                const paths = new Set(await diffPaths(dir, landedHead, head));
                current.entries.set(landedHead, paths);
                return paths;
            });
            // A failed diff fails ITS caller and nobody queued behind it — the push-store idiom.
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
