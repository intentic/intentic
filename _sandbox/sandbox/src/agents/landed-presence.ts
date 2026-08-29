import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { headSha, materializedPaths } from "../git/changes.js";
import { anchorOf } from "./agent-changes.js";
import type { IsolatedAgent } from "./agents-store.js";
import { type ExpiryTracker, pathWeight } from "./expiry.js";
import type { AgentWorktrees } from "./worktrees.js";

/* IS THE WORK THIS AGENT LANDED STILL IN THE MAIN TREE, the one question every other land reading cannot ask.
 *
 * A land puts its delta in the main WORKING TREE as uncommitted changes (land.ts); nothing about it is
 * committed, and main's HEAD never moves. Every reading of where an agent stands is measured between two
 * COMMITS, standing.ts says so in its own header, and it is right to: a verdict keyed on shas is cheap and
 * cannot drift. But it also means the entire product of a land is invisible to it. Discard those changes in
 * the Changes panel and no sha anywhere moves, so the standing stays `landed`, the card keeps its landed
 * chip, and the session menu goes on saying "Already in your workspace" over a tree that no longer holds a
 * line of it. The work is not lost, the agent's branch still has all of it, and the discard checkpoints
 * first, but nothing on the board says so, and the next turn's land carries only the NEW delta, dropping
 * turn 2 onto a tree missing turn 1.
 *
 * So this asks the working tree, per path, and reports how much of a landing survived. Present means EITHER
 * of the two honest endings a landed path can have:
 *
 *   - still dirty, the land's content is sitting there waiting to be committed, the steady state;
 *   - absorbed by history, `landedHead..HEAD` names it, so the user committed it and it is theirs now.
 *
 * Anything else was taken back out: discarded, or reverted by hand. Both are the user's own act, so this
 * never fires on its own, what it produces is a card that stops claiming otherwise, and an offer to put it
 * back (the cumulative land span, agent-changes.ts).
 *
 * ITS RELATIONSHIP TO origins.ts, which reads the same two spans and answers a DIFFERENT question. That file
 * asks which uncommitted rows of the Changes panel an agent is answerable for, so a commit ENDS its claim,
 * the lines are in history and the user owns them. Here a commit is the strongest possible "still present".
 * The expiry rule is inverted, which is why the two are not one function with a flag: they agree on where an
 * agent's landed paths are and disagree, deliberately, on what a commit means about them. The expiry span
 * itself, the one whose far end moves with every commit, is the SAME span, so both read it through the one
 * shared incremental tracker (agents/expiry.ts).
 *
 * NOT probed: agents that never landed (nothing to be missing), archived ones, an archived card is a record
 * rather than a control, and there is no button on it to offer, and landings the registry entry already
 * marks ABSORBED (agents-store.ts): history has taken every path of those, which is this module's strongest
 * "present", recorded once instead of re-derived per roster read.
 */

export interface LandedPresence {
    // Paths this agent's lands put in the main tree, across every repo of its composition.
    readonly landed: number;
    // How many of them are still there. Never above `landed`, and below it only by the user's own hand.
    readonly present: number;
}

export interface LandedPresences {
    /* A reading ONLY for an agent missing some of it. Absence is the overwhelmingly common answer and the
     * quiet one, an agent that never landed, and an agent whose landed work is exactly where it left it,
     * are both "nothing to say", and a card that had to tell the two apart from numbers would be a card
     * spending a line on the steady state. */
    readonly of: (id: string) => LandedPresence | undefined;
    // Re-read these agents, and say whether any reading MOVED (the caller broadcasts on true).
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
    // Cache cardinalities and text weight, for the durable resource series, same accounting, and the same
    // reason, as origins.metrics.
    readonly metrics: () => Readonly<Record<string, number>>;
}

/* One landing's two numbers: how many paths it put in the main tree, and how many of those are still there. A
 * path is still there on either of the two honest endings the header names, the working tree is dirty for it,
 * or history has taken it. `applied` is what narrows the agent's own work to what this patch actually carried. */
const tallyLanding = (
    own: readonly string[],
    applied: ReadonlySet<string>,
    committed: ReadonlySet<string>,
    uncommitted: ReadonlySet<string>,
): { readonly count: number; readonly here: number } => {
    let count = 0;
    let here = 0;
    for (const path of own) {
        if (!applied.has(path)) {
            continue;
        }
        count += 1;
        if (committed.has(path) || uncommitted.has(path)) {
            here += 1;
        }
    }
    return { count, here };
};

export const createLandedPresences = (
    worktrees: AgentWorktrees,
    logger: Logger,
    expiry: ExpiryTracker,
    git: GitRunner = defaultGit,
): LandedPresences => {
    const readings = new Map<string, LandedPresence>();
    /* Every span in HERE is between two FIXED shas, so one diff per span is all it ever costs however often the
     * board polls; a landing's entries are dropped when its registry row is marked absorbed, so the map is
     * bounded by the landings still being measured. `--no-renames` for the reason origins.ts spells out at
     * length, a rename is TWO paths in a working tree, and detection reports it at the destination alone,
     * which would leave the source uncounted on both sides of the comparison. The paths are COPIED out of the
     * stdout (materializedPaths): a cached sliced path pins its whole parent listing. The expiry span, the one
     * whose far end is the MOVING head, lives in the shared tracker (agents/expiry.ts), one increment per
     * repo per head move instead of one full diff per landing. */
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
    /* Where the branch left the main line, so the count is the agent's own work and not the main-line commits a
     * rebase pulled into its branch. Keyed on the TIP alone, for the reason origins.ts spells out at its own
     * anchor: a merge-base does not move as HEAD advances, only a rebase moves it, and a rebase is a new tip
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

    return {
        metrics: () => ({
            spans: spans.size,
            anchors: anchors.size,
            readings: readings.size,
            pathCharacters: pathWeight(spans.values()),
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
             * paths come from a diff against HEAD (which spans the index and the worktree alike, a landed
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
                    const { repo, base, landedTip, landedHead, absorbed } = composed;
                    // Nothing of this agent's went into this repo's tree through the one door that records it.
                    if (landedTip === undefined || landedHead === undefined) {
                        continue;
                    }
                    /* Answered from the entry itself, before the head read, which is the point: an absorbed
                     * landing costs nothing at all rather than three diffs that conclude it is still absorbed.
                     * It still counts on both sides, because every path of it is in history, this module's
                     * strongest "present" (see the header). Recorded by the attribution scan
                     * (registry.markLandingAbsorbed); a further land writes a fresh, unmarked row and is
                     * measured afresh. Absorption is a one-way door: a path the user edits and discards
                     * afterwards returns to the commit that holds the agent's work. */
                    if (absorbed !== undefined) {
                        landed += absorbed;
                        present += absorbed;
                        // The mark is down, so this landing's cached spans are dead weight, dropped here
                        // because the mark is written by ANOTHER module's scan (see below), which cannot reach
                        // this cache. Idempotent: deleting an already-absent key costs a map miss.
                        const anchor = anchors.get(`${repo} ${landedTip}`);
                        spans.delete(`applied ${repo} ${landedHead} ${landedTip}`);
                        if (anchor !== undefined) {
                            spans.delete(`own ${repo} ${anchor} ${landedTip}`);
                            anchors.delete(`${repo} ${landedTip}`);
                        }
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
                        // went in on. Either span alone over-counts, see origins.ts, same intersection.
                        const applied = new Set(await pathsBetween(dir, `applied ${repo} ${landedHead} ${landedTip}`, landedHead, landedTip));
                        const anchor = await anchorFor(dir, repo, landedTip, base);
                        const own = await pathsBetween(dir, `own ${repo} ${anchor} ${landedTip}`, anchor, landedTip);
                        const committed = await expiry.committedSince(dir, repo, landedHead, head);
                        const uncommitted = await dirtyIn(repo, dir);
                        const { count, here } = tallyLanding(own, applied, committed, uncommitted);
                        landed += count;
                        present += here;
                        /* Every path committed is the absorbed condition, and it is deliberately NOT acted on
                         * here: the durable mark is written by the attribution scan (origins.ts observes the
                         * identical condition and holds the registry handle, this module cannot, it is
                         * constructed BEFORE the registry), and the cached spans above keep the interim
                         * readings free until that mark arrives, at which point the short-circuit drops them.
                         * A landing is never retired merely because every path is still dirty, which the
                         * user's next gesture can undo. */
                    } catch (error) {
                        /* A pruned branch, a rewritten history or a main checkout that has gone leaves these
                         * shas unresolvable, and this repo simply reports nothing, the same outcome as never
                         * having landed into it, and what origins.ts does with the identical failure.
                         *
                         * It is caught HERE rather than left to propagate because of where this runs: the
                         * roster read awaits it (registry.refreshStandings), so one agent whose objects are
                         * gone would take down the whole board's answer, for every other agent on it. Debug
                         * rather than warn, on a repo in that state it would fire on every poll. */
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
