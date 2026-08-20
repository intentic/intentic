import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { OriginAgent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { headSha, materializedPaths } from "../git/changes.js";
import type { AgentsRegistry } from "./agents-registry.js";
import { landedMessageOf } from "./agents-store.js";
import { type ExpiryTracker, pathWeight } from "./expiry.js";

// WHO PUT THIS FILE IN MY WORKING TREE, the Changes panel's per-file attribution, DERIVED, not recorded.
//
// Every isolated agent's work reaches the main tree through exactly one door: land patches `landedTip ?? base
// → tip` into it and records the tip on the registry entry (agents/land.ts). So the paths an agent is
// responsible for are just the diff from that tip back to where its branch left the main line, the registry
// already persists the shas, and the objects live in the main repo (a worktree shares its object store), so
// nothing new has to be written down and no ledger can drift out of sync with the tree it describes.
//
// WHERE the claim is measured from is the MERGE-BASE of HEAD and the landed tip, never the `base` recorded at
// worktree creation, for the reason anchorOf spells out in land.ts. That base is a sha frozen in time, and a
// rebased branch CONTAINS the main-line commits it was rebased onto: diffing from the frozen base yields "this
// agent's work PLUS everything main did since", so the agent gets a chip on dozens of files it never touched,
// and whichever session the user clicks fills the commit box with the wrong title. The merge-base moves with
// the rebase and the delta stays exactly the agent's own work. land.ts got this treatment for its patch span;
// this file needs it for the same reason, computed the same way.
//
// WHAT the claim covers is that span INTERSECTED with `landedHead..landedTip`, the branch against the main
// line the patch actually went in on, i.e. the paths this land really put in the tree. The span alone is the
// agent's CUMULATIVE work, and an agent that lands twice has usually had its first delta committed by the time
// the second one goes in: against the second land's head those paths read as already-there, because that
// commit is what put them there. The per-path expiry below cannot retire them, it only sees commits AFTER
// `landedHead`, and that one landed before, so they stay claimed for the life of the entry. Invisible while
// the file is clean, and then the moment anything makes it dirty again (the user, a terminal, another agent's
// land) a session that finished days ago has its chip back on the row. The intersection ends that: a path main
// already matched when the patch went in had nothing of this land applied to it, so this land claims nothing
// there. The merge-base span stays as the other half of the AND, `landedHead..landedTip` on its own also
// names every path the MAIN LINE has run ahead on, which a stale branch would then be credited with reverting.
//
// The claim EXPIRES PER PATH, when history moves on that path. `landedHead` is where main's HEAD stood when
// the patch went in; a path whose committed content has not changed since (`landedHead..HEAD` doesn't name it)
// still carries the agent's uncommitted lines and the credit is exact. Once the user commits that path the
// agent's lines are in history, and a path that goes dirty again after that is the user's own work, so
// continuing to name the agent would be a confident lie. Dropping to "unattributed" is the honest answer.
// The expiry span is the one whose far end MOVES with every commit, so it is read through the shared
// incremental tracker (agents/expiry.ts), one diff per repo per head move instead of one per landing.
//
// The expiry keeps `landedHead` and must NOT be folded into the merge-base anchor above, tempting as the
// symmetry looks. The anchor can sit OLDER than `landedHead`, main commits while an agent works, and the
// branch need not be rebased onto them, and every commit between the two landed BEFORE this agent's patch
// did. Expiring from the anchor would read those as "history has absorbed this path" and hand the agent's
// still-uncommitted lines to the user, which is the very lie the per-path expiry exists to avoid. Only commits
// after the land can retire it, and `landedHead` is where the land was.
//
// Per path, not per repo: the user reviews and commits ONE agent's work at a time, and a repo-wide "has HEAD
// moved" test would let each such commit silently strip the chips off every OTHER agent's landed-but-still-
// uncommitted work, leaving a tree full of agent lines that the panel blames on the user.
//
// Not covered, by design: main-tree (non-isolated) turns, terminal edits, and your own typing. None of them
// pass through land, so none of them can be attributed, which is exactly why the panel shows a chip for an
// agent and NOTHING for everyone else, rather than badging most rows "you".

// One landing, identified by what it did rather than by who did it: the same agent landing twice is two
// claims, and the second must be measured even when the first is spent.
const landingKey = (repo: string, head: string, tip: string): string => `${repo} ${head} ${tip}`;

export interface AgentOrigins {
    // path → agent ids that landed it, newest land first. Empty when nothing in this repo is attributable.
    // `head` is the repo's current HEAD when the caller already holds it (the Changes scan reads it off the
    // same status pass that produced the rows), absent, it is read here, one spawn.
    readonly forRepo: (repo: string, dir: string, head?: string) => Promise<Record<string, string[]>>;
    // Who those ids ARE, resolved here rather than in the client: attribution reads the whole registry
    // (archived entries included, see below), while the roster the client mirrors carries only the live half.
    readonly identify: (ids: Iterable<string>) => Record<string, OriginAgent>;
    // Cardinalities and text weight of the caches, for the durable resource series (composition resourceOwners):
    // these maps were the daemon's memory leak once, and the accounting is what keeps a regrowth visible.
    readonly metrics: () => Readonly<Record<string, number>>;
}

export const createAgentOrigins = (
    options: { readonly agents: AgentsRegistry; readonly logger: Logger; readonly expiry: ExpiryTracker },
    git: GitRunner = defaultGit,
): AgentOrigins => {
    const { agents, logger, expiry } = options;
    // Every span in HERE is immutable, both ends are fixed shas, so one diff per span is all it ever costs,
    // however often the panel polls. Bounded by the UNABSORBED landings: a landing history has taken whole is
    // marked on its registry entry (markLandingAbsorbed) and skipped before any git, and its cached spans are
    // dropped the moment the mark goes down. The one span whose far end MOVES (the expiry, measured to the
    // current head) lives in the shared tracker instead, see agents/expiry.ts.
    const cache = new Map<string, readonly string[]>();
    const anchors = new Map<string, string>();
    /* LANDINGS WHOSE SHAS CANNOT BE RESOLVED, a pruned branch, a rewritten history, a repo whose objects are
     * gone. Attribution for them fails identically on every scan, and each failure is a spawn that throws; the
     * set remembers the verdict so a broken landing costs nothing after its first failure. In memory on
     * purpose: a repo that was merely mid-upload heals on the next restart, and attribution is decoration,
     * the honest cost of the cache being wrong is a missing chip until then. */
    const unresolvable = new Set<string>();

    /* EVERY PATH A SPAN TOUCHES, and for a rename that is TWO, which is why `--no-renames` is here rather
     * than at any one call site.
     *
     * Attribution is a question about PATHS IN A WORKING TREE: which rows of the Changes panel is this agent
     * answerable for. A rename produces two of those rows, the source is deleted, the destination is added,
     * and the agent did both. But `--name-only` reports a rename at its destination and nowhere else, so a
     * span read with detection on names one row and orphans the other.
     *
     * That orphan is not cosmetic. A row with no origin reads as YOURS, and the panel's origin filter HIDES
     * it while the user is looking at that agent's work, so "Stage all" cannot stage what it is not showing,
     * the commit records the addition alone, and the deletion is left in the tree for the user to find and
     * commit by hand. land.ts hit the identical trap from the other end and documents it at DeltaChange; this
     * is the same lesson on the reporting side.
     *
     * Detection has to be turned OFF EXPLICITLY. Omitting `-M` does not do it, git has defaulted
     * diff.renames to true since 2.9, so a span with no flag at all still collapses renames.
     *
     * The two spans below want this identically (they are INTERSECTED, so they must name a rename alike or the
     * intersection drops it), and the tracker's expiry span states the same flag for the same reason. */
    const pathsBetween = async (dir: string, key: string, args: readonly string[]): Promise<readonly string[]> => {
        const hit = cache.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
        // Copied out of the stdout, never sliced from it: these lists live in a process-lifetime cache, and a
        // sliced path pins its whole parent listing, see materializedPaths for the gigabytes that cost.
        const paths = materializedPaths(stdout);
        cache.set(key, paths);
        return paths;
    };

    // What the agent wrote, read as it wrote it.
    const landedPaths = (dir: string, repo: string, anchor: string, tip: string): Promise<readonly string[]> =>
        pathsBetween(dir, `landed ${repo} ${anchor} ${tip}`, [anchor, tip]);

    // What the land actually put in the tree: the branch against the main line the patch went in on. Both ends
    // are shas fixed at land time, so this is read once per landing and never again, however far HEAD runs.
    const appliedPaths = (dir: string, repo: string, landedHead: string, tip: string): Promise<readonly string[]> =>
        pathsBetween(dir, `applied ${repo} ${landedHead} ${tip}`, [landedHead, tip]);

    /* Where the branch left the main line, so the claim is the agent's own work and not the main-line commits a
     * rebase pulled into its branch (see the header). Falls back to the recorded base when there is no common
     * ancestor at all, unrelated histories, the one question a merge-base cannot answer, and the same fallback
     * land.ts makes.
     *
     * Keyed on the TIP alone, deliberately not on `head` as well. A merge-base does not move as HEAD advances:
     * the branch left the main line at one commit, and that commit goes on being the best common ancestor
     * however far main runs past it. What moves it is a REBASE, which is a new tip and so already a new key,
     * exactly the case the header says the anchor exists for. Keying on head too meant every commit re-ran a
     * merge-base per landing to be told the same sha, which was half the cost this file used to impose on the
     * Changes panel. (A main tree reset BEHIND the branch point would invalidate this; nothing else does, and
     * that tree has bigger problems than an attribution chip.) */
    const anchorOf = async (dir: string, repo: string, head: string, tip: string, base: string): Promise<string> => {
        const key = `anchor ${repo} ${tip}`;
        const hit = anchors.get(key);
        if (hit !== undefined) {
            return hit;
        }
        let anchor = base;
        try {
            const merged = (await git(dir, ["merge-base", head, tip])).stdout.trim();
            if (merged !== "") {
                anchor = merged;
            }
        } catch {
            // Unrelated histories, the recorded base is all there is.
        }
        anchors.set(key, anchor);
        return anchor;
    };

    // An absorbed landing is never read again (forRepo skips it before any git), so its cached spans are dead
    // weight the moment the mark goes down, dropped with it, which keeps every map here proportional to the
    // landings still doing attribution work rather than to everything the fleet has ever landed.
    const dropSpans = (repo: string, landedHead: string, tip: string, anchor: string): void => {
        cache.delete(`landed ${repo} ${anchor} ${tip}`);
        cache.delete(`applied ${repo} ${landedHead} ${tip}`);
        expiry.drop(repo, landedHead);
        anchors.delete(`anchor ${repo} ${tip}`);
    };

    return {
        metrics: () => ({
            spans: cache.size,
            anchors: anchors.size,
            unresolvable: unresolvable.size,
            pathCharacters: pathWeight(cache.values()),
        }),
        // Straight off the persisted entries, which is the point: `entry` finds an archived agent and
        // `AgentsRegistry.list` (what the client mirrors) does not. An id with no entry left at all is simply
        // omitted, the client renders the same id-shaped fallback it would for an unresolvable one.
        identify: (ids) => {
            const identities: Record<string, OriginAgent> = {};
            for (const id of ids) {
                const entry = agents.entry(id);
                if (entry === undefined) {
                    continue;
                }
                const landed = landedMessageOf(entry);
                identities[id] = {
                    provider: entry.provider,
                    ...(entry.title !== undefined ? { title: entry.title } : {}),
                    // What the landed work did, for the chip to file into the commit box, written at land
                    // time from the diff, so it describes the change rather than the ask the title names. The
                    // agent's card carries the same message live; this copy is the one an ARCHIVED agent's
                    // still-uncommitted lines are read through, which is what this whole record is for.
                    ...(landed === undefined ? {} : { landedMessage: landed }),
                };
            }
            return identities;
        },
        forRepo: async (repo, dir, knownHead) => {
            // One entry per agent that has landed something into THIS repo, newest land first, the order the
            // panel shows chips in, so the most recent author reads first.
            const landings = agents
                .ids()
                .flatMap((id) => {
                    const composed = agents.entry(id)?.repos.find((candidate) => candidate.repo === repo);
                    if (composed?.landedTip === undefined || composed.landedHead === undefined) {
                        return [];
                    }
                    // An absorbed landing is skipped BEFORE the head read below, which is the point: it costs
                    // nothing at all, rather than diffs that conclude what the registry entry already records.
                    // A further land by the same agent writes a fresh row, so it arrives unmarked and is
                    // measured afresh. Unresolvable landings are the same short-circuit for the failure case.
                    if (composed.absorbed !== undefined || unresolvable.has(landingKey(repo, composed.landedHead, composed.landedTip))) {
                        return [];
                    }
                    return [{ id, base: composed.base, tip: composed.landedTip, head: composed.landedHead, at: composed.landedAt ?? 0 }];
                })
                .toSorted((a, b) => b.at - a.at);
            if (landings.length === 0) {
                return {};
            }
            const head = knownHead ?? (await headSha(dir, git));
            if (head === undefined) {
                return {};
            }
            const origins: Record<string, string[]> = {};
            for (const landing of landings) {
                try {
                    // The agent's own paths, narrowed to the ones this land put in the tree, minus the ones
                    // history has since absorbed. When HEAD hasn't moved at all the expiry answers from memory
                    // and every applied path still counts, which is the common case.
                    const applied = new Set(await appliedPaths(dir, repo, landing.head, landing.tip));
                    const retired = await expiry.committedSince(dir, repo, landing.head, head);
                    const anchor = await anchorOf(dir, repo, head, landing.tip, landing.base);
                    let total = 0;
                    let claimed = 0;
                    for (const path of await landedPaths(dir, repo, anchor, landing.tip)) {
                        if (!applied.has(path)) {
                            continue;
                        }
                        total += 1;
                        if (retired.has(path)) {
                            continue;
                        }
                        claimed += 1;
                        (origins[path] ??= []).push(landing.id);
                    }
                    /* Nothing left to claim, history has taken every path this land put in the tree (or it put
                     * none there at all). That is the end of the claim, not a quiet scan: record it on the
                     * registry entry (with the landing's size, for the presence fraction's denominator) so no
                     * later scan, including the first one after a restart, spends a spawn rediscovering it,
                     * and drop the cached spans with it. The mark is fire-and-forget: it is a memo about an
                     * outcome that already happened, and a failed persist only costs re-deriving it. */
                    if (claimed === 0) {
                        dropSpans(repo, landing.head, landing.tip, anchor);
                        void agents
                            .markLandingAbsorbed(landing.id, repo, landing.head, landing.tip, total)
                            .catch((error: unknown) =>
                                logger.debug({ err: error, repo, agent: landing.id }, "agent origins: absorbed mark not persisted"),
                            );
                    }
                } catch (error) {
                    // A pruned branch or a rewritten history leaves the shas unresolvable, that agent simply
                    // goes unattributed, which is the same outcome as never having landed. Remembered so the
                    // next scan skips it outright instead of re-failing the same spawns. Debug: even the first
                    // failure is routine on a repo whose objects are gone.
                    unresolvable.add(landingKey(repo, landing.head, landing.tip));
                    logger.debug({ err: error, repo, agent: landing.id }, "agent origins: delta unresolvable");
                }
            }
            return origins;
        },
    };
};
