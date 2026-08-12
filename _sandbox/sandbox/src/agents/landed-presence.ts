import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { headSha, materializedPaths } from "../git/changes.js";
import { anchorOf } from "./agent-changes.js";
import type { IsolatedAgent } from "./agents-store.js";
import type { AgentWorktrees } from "./worktrees.js";

/* IS THE WORK THIS AGENT LANDED STILL IN THE MAIN TREE — the one question every other land reading cannot ask.
 *
 * A land puts its delta in the main WORKING TREE as uncommitted changes (land.ts); nothing about it is
 * committed, and main's HEAD never moves. Every reading of where an agent stands is measured between two
 * COMMITS — standing.ts says so in its own header, and it is right to: a verdict keyed on shas is cheap and
 * cannot drift. But it also means the entire product of a land is invisible to it. Discard those changes in
 * the Changes panel and no sha anywhere moves, so the standing stays `landed`, the card keeps its landed
 * chip, and the session menu goes on saying "Already in your workspace" over a tree that no longer holds a
 * line of it. The work is not lost — the agent's branch still has all of it, and the discard checkpoints
 * first — but nothing on the board says so, and the next turn's land carries only the NEW delta, dropping
 * turn 2 onto a tree missing turn 1.
 *
 * So this asks the working tree, per path, and reports how much of a landing survived. Present means EITHER
 * of the two honest endings a landed path can have:
 *
 *   - still dirty — the land's content is sitting there waiting to be committed, the steady state;
 *   - absorbed by history — `landedHead..HEAD` names it, so the user committed it and it is theirs now.
 *
 * Anything else was taken back out: discarded, or reverted by hand. Both are the user's own act, so this
 * never fires on its own — what it produces is a card that stops claiming otherwise, and an offer to put it
 * back (the cumulative land span, agent-changes.ts).
 *
 * ITS RELATIONSHIP TO origins.ts, which reads the same two spans and answers a DIFFERENT question. That file
 * asks which uncommitted rows of the Changes panel an agent is answerable for, so a commit ENDS its claim —
 * the lines are in history and the user owns them. Here a commit is the strongest possible "still present".
 * The expiry rule is inverted, which is why the two are not one function with a flag: they agree on where an
 * agent's landed paths are and disagree, deliberately, on what a commit means about them.
 *
 * NOT probed: agents that never landed (nothing to be missing), and archived ones — an archived card is a
 * record rather than a control, and there is no button on it to offer.
 */

export interface LandedPresence {
    // Paths this agent's lands put in the main tree, across every repo of its composition.
    readonly landed: number;
    // How many of them are still there. Never above `landed`, and below it only by the user's own hand.
    readonly present: number;
}

export interface LandedPresences {
    /* A reading ONLY for an agent missing some of it. Absence is the overwhelmingly common answer and the
     * quiet one — an agent that never landed, and an agent whose landed work is exactly where it left it,
     * are both "nothing to say", and a card that had to tell the two apart from numbers would be a card
     * spending a line on the steady state. */
    readonly of: (id: string) => LandedPresence | undefined;
    // Re-read these agents, and say whether any reading MOVED (the caller broadcasts on true).
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
    // Cache cardinalities and text weight, for the durable resource series — same accounting, and the same
    // reason, as origins.metrics.
    readonly metrics: () => Readonly<Record<string, number>>;
}

// A landing, identified by what it did rather than by who did it — the same key origins.ts retires on, and for
// the same reason: an agent landing twice is two landings, and the second is measured even when the first is done.
const landingKey = (repo: string, head: string, tip: string): string => `${repo} ${head} ${tip}`;

export const createLandedPresences = (worktrees: AgentWorktrees, logger: Logger, git: GitRunner = defaultGit): LandedPresences => {
    const readings = new Map<string, LandedPresence>();
    /* Every span in HERE is between two FIXED shas, so one diff per span is all it ever costs however often the
     * board polls; a landing's entries are dropped when it settles, so the map is bounded by the unsettled
     * landings. `--no-renames` for the reason origins.ts spells out at length — a rename is TWO paths in a
     * working tree, and detection reports it at the destination alone, which would leave the source uncounted
     * on both sides of the comparison. The paths are COPIED out of the stdout (materializedPaths): a cached
     * sliced path pins its whole parent listing, which is the leak origins.ts documents at `expiries`. */
    const spans = new Map<string, readonly string[]>();
    const pathsBetween = async (dir: string, key: string, from: string, to: string): Promise<readonly string[]> => {
        const hit = spans.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", from, to]);
        const paths = materializedPaths(stdout);
        spans.set(key, paths);
        return paths;
    };
    /* The expiry span, whose far end is the MOVING head — one REPLACED slot per landing, never one cache entry
     * per (landing, head): keying the shared map on the head minted a fresh dead entry per landing at every
     * commit, which was this file's half of the daemon's memory leak (origins.ts documents the whole of it). */
    const expiries = new Map<string, { readonly head: string; readonly paths: readonly string[] }>();
    const committedSince = async (dir: string, repo: string, landedHead: string, head: string): Promise<readonly string[]> => {
        const key = `${repo} ${landedHead}`;
        const hit = expiries.get(key);
        if (hit !== undefined && hit.head === head) {
            return hit.paths;
        }
        const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", landedHead, head]);
        const paths = materializedPaths(stdout);
        expiries.set(key, { head, paths });
        return paths;
    };
    /* LANDINGS HISTORY HAS TAKEN WHOLE, so this never pays for them again. Once every path a landing put in
     * the tree has been committed, no later act of the user's can make it missing: a path they edit and
     * discard afterwards returns to the commit that holds the agent's work. That is a one-way door, which is
     * what makes it safe to remember rather than re-derive — the same short-circuit, and the same reasoning,
     * as origins.ts's `spent`. It is memo, not ledger: nothing is written down and a restart re-derives it.
     *
     * It remembers the landing's SIZE rather than just its name, because the reading is a fraction and a
     * settled repo is still part of the denominator. Dropping it would tell an agent that landed across two
     * repos "3 of 5 still in your workspace" over work that was 10 files — a smaller lie than the one this
     * module exists to end, but the same kind. */
    const settled = new Map<string, number>();
    /* Where the branch left the main line, so the count is the agent's own work and not the main-line commits a
     * rebase pulled into its branch. Keyed on the TIP alone, for the reason origins.ts spells out at its own
     * anchor: a merge-base does not move as HEAD advances — only a rebase moves it, and a rebase is a new tip
     * and so already a new key. Keying on the head as well minted one dead entry per landing per commit. */
    const anchors = new Map<string, string>();
    const anchorFor = async (dir: string, repo: string, tip: string, base: string): Promise<string> => {
        const key = `${repo} ${tip}`;
        const hit = anchors.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const anchor = await anchorOf(dir, dir, tip, undefined, base, git);
        anchors.set(key, anchor);
        return anchor;
    };

    const pathChars = (lists: Iterable<readonly string[]>): number => {
        let total = 0;
        for (const paths of lists) {
            for (const path of paths) {
                total += path.length;
            }
        }
        return total;
    };

    return {
        metrics: () => ({
            spans: spans.size,
            expiries: expiries.size,
            anchors: anchors.size,
            settled: settled.size,
            readings: readings.size,
            pathCharacters: pathChars(spans.values()) + pathChars([...expiries.values()].map((entry) => entry.paths)),
        }),
        of: (id) => readings.get(id),
        forget: (ids) => {
            for (const id of ids) {
                readings.delete(id);
            }
        },
        refresh: async (entries) => {
            /* WHAT THE TREE HOLDS RIGHT NOW, once per repo for the whole pass rather than once per agent: a
             * fleet shares its workspace, so every agent in it is asking about the same two reads. Tracked
             * paths come from a diff against HEAD (which spans the index and the worktree alike — a landed
             * path the user has since staged is still there), untracked ones from the walk, because a land
             * that created a file leaves it untracked and a diff cannot see it at all. */
            const dirty = new Map<string, Promise<ReadonlySet<string>>>();
            const dirtyIn = (repo: string, dir: string): Promise<ReadonlySet<string>> => {
                let paths = dirty.get(repo);
                if (paths === undefined) {
                    paths = (async () => {
                        const [tracked, untracked] = await Promise.all([
                            git(dir, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]),
                            git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
                        ]);
                        return new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((path) => path !== ""));
                    })();
                    dirty.set(repo, paths);
                }
                return paths;
            };
            const heads = new Map<string, Promise<string | undefined>>();
            const headOf = (repo: string, dir: string): Promise<string | undefined> => {
                let head = heads.get(repo);
                if (head === undefined) {
                    head = headSha(dir, git);
                    heads.set(repo, head);
                }
                return head;
            };
            let moved = false;
            for (const entry of entries) {
                let landed = 0;
                let present = 0;
                for (const composed of entry.repos) {
                    const { repo, base, landedTip, landedHead } = composed;
                    // Nothing of this agent's went into this repo's tree through the one door that records it.
                    if (landedTip === undefined || landedHead === undefined) {
                        continue;
                    }
                    /* Counted from memory, before the head read — which is the point: a settled landing costs
                     * nothing at all rather than three diffs that conclude it is still settled. It still
                     * counts on both sides, because every path of it is present. A further land by the same
                     * agent advances both shas and so arrives as a new key, measured afresh. */
                    const done = settled.get(landingKey(repo, landedHead, landedTip));
                    if (done !== undefined) {
                        landed += done;
                        present += done;
                        continue;
                    }
                    const dir = worktrees.mainDir(repo);
                    try {
                        const head = await headOf(repo, dir);
                        if (head === undefined) {
                            continue;
                        }
                        // The paths this land put in the tree: the agent's own work (from where its branch
                        // left the main line) narrowed to what the patch actually carried against the head it
                        // went in on. Either span alone over-counts — see origins.ts, same intersection.
                        const applied = new Set(await pathsBetween(dir, `applied ${repo} ${landedHead} ${landedTip}`, landedHead, landedTip));
                        const anchor = await anchorFor(dir, repo, landedTip, base);
                        const own = await pathsBetween(dir, `own ${repo} ${anchor} ${landedTip}`, anchor, landedTip);
                        const committed = new Set(await committedSince(dir, repo, landedHead, head));
                        const uncommitted = await dirtyIn(repo, dir);
                        let count = 0;
                        let here = 0;
                        let absorbed = 0;
                        for (const path of own) {
                            if (!applied.has(path)) {
                                continue;
                            }
                            count += 1;
                            if (committed.has(path)) {
                                absorbed += 1;
                                here += 1;
                                continue;
                            }
                            if (uncommitted.has(path)) {
                                here += 1;
                            }
                        }
                        landed += count;
                        present += here;
                        // Retired only when HISTORY accounts for every path — never merely because they are
                        // all still dirty, which the user's next gesture can undo. A landing that put nothing
                        // in the tree at all settles here too, at a size of zero. Its cached spans go with it:
                        // a settled landing is answered from `settled` before any of them is read again.
                        if (absorbed === count) {
                            settled.set(landingKey(repo, landedHead, landedTip), count);
                            spans.delete(`applied ${repo} ${landedHead} ${landedTip}`);
                            spans.delete(`own ${repo} ${anchor} ${landedTip}`);
                            expiries.delete(`${repo} ${landedHead}`);
                            anchors.delete(`${repo} ${landedTip}`);
                        }
                    } catch (error) {
                        /* A pruned branch, a rewritten history or a main checkout that has gone leaves these
                         * shas unresolvable, and this repo simply reports nothing — the same outcome as never
                         * having landed into it, and what origins.ts does with the identical failure.
                         *
                         * It is caught HERE rather than left to propagate because of where this runs: the
                         * roster read awaits it (registry.refreshStandings), so one agent whose objects are
                         * gone would take down the whole board's answer, for every other agent on it. Debug
                         * rather than warn — on a repo in that state it would fire on every poll. */
                        logger.debug({ err: error, repo, agent: entry.id }, "landed presence: landing unresolvable");
                    }
                }
                const reading = landed > present ? { landed, present } : undefined;
                const before = readings.get(entry.id);
                moved ||= before?.landed !== reading?.landed || before?.present !== reading?.present;
                if (reading === undefined) {
                    readings.delete(entry.id);
                    continue;
                }
                readings.set(entry.id, reading);
            }
            return moved;
        },
    };
};
