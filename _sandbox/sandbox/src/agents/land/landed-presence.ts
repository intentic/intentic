import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { headSha } from "../../git/changes/changes.js";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import { anchorOf } from "./agent-changes.js";
import type { IsolatedAgent } from "../registry/agents-store.js";
import { type ExpiryTracker, pathWeight } from "../registry/expiry.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Whether a land's uncommitted work is still in the main tree, the one thing sha-keyed standing (standing.ts) can't
// see: discard those changes and no sha moves, yet nothing of the land remains. Present means still dirty, or absorbed
// into history; opposite of origins.ts, where a commit ENDS a claim instead of confirming it.

export interface LandedPresence {
    // Paths this agent's lands put in the main tree, across the whole composition.
    readonly landed: number;
    // How many are still there; never above `landed`, below it only by the user's own hand.
    readonly present: number;
}

export interface LandedPresences {
    // Only for an agent missing some of it; both 'never landed' and 'fully present' read as nothing to say.
    readonly of: (id: string) => LandedPresence | undefined;
    // Re-reads these agents; returns whether any reading moved (caller broadcasts on true).
    readonly refresh: (entries: readonly IsolatedAgent[]) => Promise<boolean>;
    readonly forget: (ids: readonly string[]) => void;
    // Cache sizes and text weight, for the durable resource series (same accounting as origins.metrics).
    readonly metrics: () => Readonly<Record<string, number>>;
}

// How many paths a landing put in the tree, and how many are still there (dirty or committed). `applied` narrows the
// agent's own paths to what this patch actually carried.
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
    // One diff per fixed span, cached; `--no-renames` so a rename's source isn't lost; paths copied out.
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
    // Keyed on tip alone: a rebase already mints a new tip; keying on head too would waste an entry per commit.
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
            // Tracked paths diff HEAD (catches a staged landed path); untracked come from the file walk instead.
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
                    // Nothing of this agent's landed into this repo through the one door that records it.
                    if (landedTip === undefined || landedHead === undefined) {
                        continue;
                    }
                    // Already-absorbed counts on both sides for free: history holds every path (markLandingAbsorbed).
                    if (absorbed !== undefined) {
                        landed += absorbed;
                        present += absorbed;
                        // Cached spans are dead weight once absorbed; dropped here since another module wrote the mark.
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
                        // Own work narrowed to what the patch carried, same intersection origins.ts uses.
                        const applied = new Set(await pathsBetween(dir, `applied ${repo} ${landedHead} ${landedTip}`, landedHead, landedTip));
                        const anchor = await anchorFor(dir, repo, landedTip, base);
                        const own = await pathsBetween(dir, `own ${repo} ${anchor} ${landedTip}`, anchor, landedTip);
                        const committed = await expiry.committedSince(dir, repo, landedHead, head);
                        const uncommitted = await dirtyIn(repo, dir);
                        const { count, here } = tallyLanding(own, applied, committed, uncommitted);
                        landed += count;
                        present += here;
                        // Every-path-committed is the absorbed condition, but the durable mark is written elsewhere.
                    } catch (error) {
                        // Unresolvable shas report nothing; caught so one agent can't sink the whole roster read.
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
