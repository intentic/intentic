import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { OriginAgent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { headSha } from "../git/changes.js";
import type { AgentsRegistry } from "./agents-registry.js";

// WHO PUT THIS FILE IN MY WORKING TREE — the Changes panel's per-file attribution, DERIVED, not recorded.
//
// Every isolated agent's work reaches the main tree through exactly one door: land patches `landedTip ?? base
// → tip` into it and records the tip on the registry entry (agents/land.ts). So the paths an agent is
// responsible for are just the diff from that tip back to where its branch left the main line — the registry
// already persists the shas, and the objects live in the main repo (a worktree shares its object store), so
// nothing new has to be written down and no ledger can drift out of sync with the tree it describes.
//
// WHERE the claim is measured from is the MERGE-BASE of HEAD and the landed tip, never the `base` recorded at
// worktree creation — for the reason anchorOf spells out in land.ts. That base is a sha frozen in time, and a
// rebased branch CONTAINS the main-line commits it was rebased onto: diffing from the frozen base yields "this
// agent's work PLUS everything main did since", so the agent gets a chip on dozens of files it never touched,
// and whichever session the user clicks fills the commit box with the wrong title. The merge-base moves with
// the rebase and the delta stays exactly the agent's own work. land.ts got this treatment for its patch span;
// this file needs it for the same reason, computed the same way.
//
// WHAT the claim covers is that span INTERSECTED with `landedHead..landedTip` — the branch against the main
// line the patch actually went in on, i.e. the paths this land really put in the tree. The span alone is the
// agent's CUMULATIVE work, and an agent that lands twice has usually had its first delta committed by the time
// the second one goes in: against the second land's head those paths read as already-there, because that
// commit is what put them there. The per-path expiry below cannot retire them — it only sees commits AFTER
// `landedHead`, and that one landed before — so they stay claimed for the life of the entry. Invisible while
// the file is clean, and then the moment anything makes it dirty again (the user, a terminal, another agent's
// land) a session that finished days ago has its chip back on the row. The intersection ends that: a path main
// already matched when the patch went in had nothing of this land applied to it, so this land claims nothing
// there. The merge-base span stays as the other half of the AND — `landedHead..landedTip` on its own also
// names every path the MAIN LINE has run ahead on, which a stale branch would then be credited with reverting.
//
// The claim EXPIRES PER PATH, when history moves on that path. `landedHead` is where main's HEAD stood when
// the patch went in; a path whose committed content has not changed since (`landedHead..HEAD` doesn't name it)
// still carries the agent's uncommitted lines and the credit is exact. Once the user commits that path the
// agent's lines are in history — and a path that goes dirty again after that is the user's own work, so
// continuing to name the agent would be a confident lie. Dropping to "unattributed" is the honest answer.
//
// The expiry keeps `landedHead` and must NOT be folded into the merge-base anchor above, tempting as the
// symmetry looks. The anchor can sit OLDER than `landedHead` — main commits while an agent works, and the
// branch need not be rebased onto them — and every commit between the two landed BEFORE this agent's patch
// did. Expiring from the anchor would read those as "history has absorbed this path" and hand the agent's
// still-uncommitted lines to the user, which is the very lie the per-path expiry exists to avoid. Only commits
// after the land can retire it, and `landedHead` is where the land was.
//
// Per path, not per repo: the user reviews and commits ONE agent's work at a time, and a repo-wide "has HEAD
// moved" test would let each such commit silently strip the chips off every OTHER agent's landed-but-still-
// uncommitted work — leaving a tree full of agent lines that the panel blames on the user.
//
// Not covered, by design: main-tree (non-isolated) turns, terminal edits, and your own typing. None of them
// pass through land, so none of them can be attributed — which is exactly why the panel shows a chip for an
// agent and NOTHING for everyone else, rather than badging most rows "you".

// One landing, identified by what it did rather than by who did it: the same agent landing twice is two
// claims, and the second must be measured even when the first is spent.
const landingKey = (repo: string, head: string, tip: string): string => `${repo} ${head} ${tip}`;

export interface AgentOrigins {
    // path → agent ids that landed it, newest land first. Empty when nothing in this repo is attributable.
    readonly forRepo: (repo: string, dir: string) => Promise<Record<string, string[]>>;
    // Who those ids ARE, resolved here rather than in the client: attribution reads the whole registry
    // (archived entries included — see below), while the roster the client mirrors carries only the live half.
    readonly identify: (ids: Iterable<string>) => Record<string, OriginAgent>;
}

export const createAgentOrigins = (
    options: { readonly agents: AgentsRegistry; readonly logger: Logger },
    git: GitRunner = defaultGit,
): AgentOrigins => {
    const { agents, logger } = options;
    // Every span this reads is immutable — both ends are shas — so one diff per span is all this ever costs,
    // however often the panel polls. Keyed by the span, and kept for the life of the process: a span nothing
    // asks about again simply stops being read, and `spent` below is what stops the set growing with the fleet.
    const cache = new Map<string, readonly string[]>();
    const anchors = new Map<string, string>();
    /* LANDINGS WHOSE CLAIM IS OVER, so the panel never pays for them again.
     *
     * A landing is spent once history has absorbed every path it put in the tree — the per-path expiry in the
     * header, reached for all of its paths at once. That is a one-way door, and the reason this can be
     * remembered rather than re-derived: the header's own answer to a path that goes dirty again after the
     * commit is "the user's own work, and naming the agent would be a confident lie".
     *
     * Without it, every agent that ever landed was re-measured on every scan, because the two reads below are
     * keyed on the CURRENT head and a commit moves it — 2 git spawns per landing, per commit, forever. On this
     * workspace that was 161 landings (165 of the 203 agents long archived) re-deriving 322 diffs to conclude
     * what the previous scan already knew, which is what made the Changes panel take 10-20s to answer while
     * the user was committing. It is memo, not ledger: nothing is written down, and a restart re-derives it.
     */
    const spent = new Set<string>();

    /* EVERY PATH A SPAN TOUCHES — and for a rename that is TWO, which is why `--no-renames` is here rather
     * than at any one call site.
     *
     * Attribution is a question about PATHS IN A WORKING TREE: which rows of the Changes panel is this agent
     * answerable for. A rename produces two of those rows — the source is deleted, the destination is added —
     * and the agent did both. But `--name-only` reports a rename at its destination and nowhere else, so a
     * span read with detection on names one row and orphans the other.
     *
     * That orphan is not cosmetic. A row with no origin reads as YOURS, and the panel's origin filter HIDES
     * it while the user is looking at that agent's work — so "Stage all" cannot stage what it is not showing,
     * the commit records the addition alone, and the deletion is left in the tree for the user to find and
     * commit by hand. land.ts hit the identical trap from the other end and documents it at DeltaChange; this
     * is the same lesson on the reporting side.
     *
     * Detection has to be turned OFF EXPLICITLY. Omitting `-M` does not do it — git has defaulted
     * diff.renames to true since 2.9, so a span with no flag at all still collapses renames.
     *
     * All three spans below want this, and want it identically: the two that are INTERSECTED must name a
     * rename alike or the intersection drops it, and the third (the expiry) has always said in its own comment
     * that a commit renaming a landed path must retire both names. One flag, one place, no caller to forget. */
    const pathsBetween = async (dir: string, key: string, args: readonly string[]): Promise<readonly string[]> => {
        const hit = cache.get(key);
        if (hit !== undefined) {
            return hit;
        }
        const { stdout } = await git(dir, ["diff", "--name-only", "--no-renames", "-z", ...args]);
        const paths = stdout.split("\0").filter((path) => path !== "");
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
     * ancestor at all — unrelated histories, the one question a merge-base cannot answer, and the same fallback
     * land.ts makes.
     *
     * Keyed on the TIP alone, deliberately not on `head` as well. A merge-base does not move as HEAD advances:
     * the branch left the main line at one commit, and that commit goes on being the best common ancestor
     * however far main runs past it. What moves it is a REBASE, which is a new tip and so already a new key —
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
            // Unrelated histories — the recorded base is all there is.
        }
        anchors.set(key, anchor);
        return anchor;
    };

    // What history has done to those paths since the land — the claim's expiry, one path at a time. A commit
    // that renamed a landed path has to retire BOTH names, which is one of the reasons pathsBetween turns
    // rename detection off; leave the source claimed and an agent keeps a chip on a path that no longer exists.
    const committedSince = (dir: string, repo: string, landedHead: string, head: string): Promise<readonly string[]> =>
        pathsBetween(dir, `since ${repo} ${landedHead} ${head}`, [landedHead, head]);

    return {
        // Straight off the persisted entries, which is the point: `entry` finds an archived agent and
        // `AgentsRegistry.list` (what the client mirrors) does not. An id with no entry left at all is simply
        // omitted — the client renders the same id-shaped fallback it would for an unresolvable one.
        identify: (ids) => {
            const identities: Record<string, OriginAgent> = {};
            for (const id of ids) {
                const entry = agents.entry(id);
                if (entry === undefined) {
                    continue;
                }
                identities[id] = {
                    provider: entry.provider,
                    ...(entry.title !== undefined ? { title: entry.title } : {}),
                    // What the landed work did, for the chip to file into the commit box — written at land
                    // time from the diff, so it describes the change rather than the ask the title names.
                    ...(entry.landedSubject !== undefined ? { subject: entry.landedSubject } : {}),
                    // …and the same landing said to a user, for a repo that keeps a changelog. Travels beside
                    // the subject rather than inside it so the box can compose the commit's trailer.
                    ...(entry.landedNote !== undefined ? { note: entry.landedNote } : {}),
                };
            }
            return identities;
        },
        forRepo: async (repo, dir) => {
            // One entry per agent that has landed something into THIS repo, newest land first — the order the
            // panel shows chips in, so the most recent author reads first.
            const landings = agents
                .ids()
                .flatMap((id) => {
                    const composed = agents.entry(id)?.repos.find((candidate) => candidate.repo === repo);
                    if (composed?.landedTip === undefined || composed.landedHead === undefined) {
                        return [];
                    }
                    // A spent landing is skipped BEFORE the head read below, which is the point: it costs
                    // nothing at all, rather than two diffs that conclude it is still spent. A further land by
                    // the same agent advances both shas, so it arrives as a new key and is measured afresh.
                    if (spent.has(landingKey(repo, composed.landedHead, composed.landedTip))) {
                        return [];
                    }
                    return [{ id, base: composed.base, tip: composed.landedTip, head: composed.landedHead, at: composed.landedAt ?? 0 }];
                })
                .toSorted((a, b) => b.at - a.at);
            if (landings.length === 0) {
                return {};
            }
            const head = await headSha(dir, git);
            if (head === undefined) {
                return {};
            }
            const origins: Record<string, string[]> = {};
            for (const landing of landings) {
                try {
                    // The agent's own paths, narrowed to the ones this land put in the tree, minus the ones
                    // history has since absorbed. When HEAD hasn't moved at all the last diff is empty and
                    // every applied path still counts, which is the common case.
                    const applied = new Set(await appliedPaths(dir, repo, landing.head, landing.tip));
                    const retired = new Set(await committedSince(dir, repo, landing.head, head));
                    const anchor = await anchorOf(dir, repo, head, landing.tip, landing.base);
                    let claimed = 0;
                    for (const path of await landedPaths(dir, repo, anchor, landing.tip)) {
                        if (!applied.has(path) || retired.has(path)) {
                            continue;
                        }
                        claimed += 1;
                        (origins[path] ??= []).push(landing.id);
                    }
                    // Nothing left to claim — history has taken every path this land put in the tree (or it
                    // put none there at all). That is the end of the claim, not a quiet scan: retire it so no
                    // later scan spends a spawn rediscovering it.
                    if (claimed === 0) {
                        spent.add(landingKey(repo, landing.head, landing.tip));
                    }
                } catch (error) {
                    // A pruned branch or a rewritten history leaves the shas unresolvable — that agent simply
                    // goes unattributed, which is the same outcome as never having landed. Debug: on a repo
                    // whose objects are gone this would fire on every poll.
                    logger.debug({ err: error, repo, agent: landing.id }, "agent origins: delta unresolvable");
                }
            }
            return origins;
        },
    };
};
