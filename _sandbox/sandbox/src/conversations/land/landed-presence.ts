import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import { headSha } from "../../git/changes/changes.js";
import { materializedPaths } from "../../git/changes/changes-porcelain.js";
import { checkpointOf } from "./agent-changes.js";
import type { IsolatedAgent, Remover } from "../registry/agents-store.js";
import { createPathLists, type ExpiryTracker } from "../registry/expiry.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";

// Whether a land's uncommitted work is still in the main tree, the one thing sha-keyed standing (standing.ts) can't
// see: discard those changes and no sha moves, yet nothing of the land remains. Present means still dirty, or absorbed
// into history; opposite of origins.ts, where a commit ENDS a claim instead of confirming it.
//
// WHO TOOK IT OUT is read off who acted on the main tree between two readings: the people noted as they threw changes
// away (`note`) and the agents the caller saw at work there (`refresh`'s `active`). Only a sole candidate is named; two,
// or none, name nobody, since a guess that hides Land again from work a person wants back is worse than saying nothing.
// A reading this process has never taken before (a restart) keeps what the record says instead: the window it would be
// read off is gone.

export interface LandedPresence {
    // Paths this agent's lands put in the main tree, across the whole composition.
    readonly landed: number;
    // How many are still there; never above `landed`, below it only once someone took some out.
    readonly present: number;
    // Who took the missing part out, when a reading could tell.
    readonly removedBy?: Remover;
}

export interface LandedPresences {
    // Only for an agent missing some of it; both 'never landed' and 'fully present' read as nothing to say.
    readonly of: (id: string) => LandedPresence | undefined;
    // Someone who may take landed work out of the main tree, noted as they act; the next refresh reads every note since
    // the one before it.
    readonly note: (remover: Remover) => void;
    // Re-reads these agents, `active` being who the caller saw at work in the main tree since the last reading (an agent
    // whose turn runs there); returns whether any reading moved (caller broadcasts on true).
    readonly refresh: (entries: readonly IsolatedAgent[], active?: readonly Remover[]) => Promise<boolean>;
    // Whether this process has read the agent at all: only then does no reading mean nothing of it is missing.
    readonly measured: (id: string) => boolean;
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

// One key per candidate: an agent by its id, a person by their address (one with none is one unnamed person).
export const removerKey = (remover: Remover | undefined): string =>
    remover === undefined ? "" : remover.kind === "agent" ? `agent:${remover.id}` : `person:${remover.email ?? ""}`;

// The one candidate a window holds, or none when it holds two or more, or nobody.
const soleRemover = (candidates: readonly Remover[]): Remover | undefined => {
    const distinct = new Map(candidates.map((remover) => [removerKey(remover), remover]));
    return distinct.size === 1 ? [...distinct.values()][0] : undefined;
};

// Who a reading names. Nothing newly missing keeps the name it had; a first reading in this process takes the record's;
// something newly missing takes the window's sole candidate, and nobody when the window cannot say.
const removerOf = (
    entry: IsolatedAgent,
    before: LandedPresence | undefined,
    reading: { readonly landed: number; readonly present: number },
    seen: boolean,
    sole: Remover | undefined,
): Remover | undefined => {
    if (before !== undefined && reading.present >= before.present) {
        return before.removedBy;
    }
    return seen ? sole : entry.landing.removedBy;
};

// A reading of an agent's counts: nothing when all of it is there, else the counts and who, if anyone, is named.
const readingOf = (
    entry: IsolatedAgent,
    counts: { readonly landed: number; readonly present: number },
    before: LandedPresence | undefined,
    seen: boolean,
    sole: Remover | undefined,
): LandedPresence | undefined => {
    if (counts.landed <= counts.present) {
        return undefined;
    }
    const removedBy = removerOf(entry, before, counts, seen, sole);
    return removedBy === undefined ? { landed: counts.landed, present: counts.present } : { landed: counts.landed, present: counts.present, removedBy };
};

// Whether a reading says anything the one before it did not.
const readingMoved = (before: LandedPresence | undefined, reading: LandedPresence | undefined): boolean =>
    before?.landed !== reading?.landed || before?.present !== reading?.present || removerKey(before?.removedBy) !== removerKey(reading?.removedBy);

// Whose last land reached the main tree: a spawned child's that went into its parent's checkout did not, and the
// parent's own land is what brings it there (land-target.ts).
const landedInMainTree = (entry: IsolatedAgent): boolean => entry.placement.landedInto === undefined;

export const createLandedPresences = (
    worktrees: AgentWorktrees,
    logger: Logger,
    expiry: ExpiryTracker,
    git: GitRunner = defaultGit,
): LandedPresences => {
    const readings = new Map<string, LandedPresence>();
    // Agents read at least once by this process, and who was noted acting on the main tree since the last reading.
    const seen = new Set<string>();
    // Keyed by candidate, so a person discarding all afternoon between two readings is one entry, not a growing list.
    let noted = new Map<string, Remover>();
    // One diff per fixed span, cached; `--no-renames` so a rename's source isn't lost; paths copied out.
    const spans = createPathLists();
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
        const anchor = await checkpointOf(dir, dir, tip, undefined, base, git);
        anchors.set(key, anchor);
        return anchor;
    };

    return {
        metrics: () => ({
            spans: spans.size(),
            anchors: anchors.size,
            readings: readings.size,
            seen: seen.size,
            pathCharacters: spans.weight(),
        }),
        of: (id) => readings.get(id),
        measured: (id) => seen.has(id),
        note: (remover) => {
            noted.set(removerKey(remover), remover);
        },
        forget: (ids) => {
            for (const id of ids) {
                readings.delete(id);
                seen.delete(id);
            }
        },
        refresh: async (entries, active) => {
            // The window closes here: a note arriving while this reads belongs to the next one.
            const sole = soleRemover([...noted.values(), ...(active ?? [])]);
            noted = new Map();
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
            // One repo's share of an entry's landing: nothing where it never landed through the one door that records
            // it, both sides free once absorbed, and `unread` when git could not answer this time.
            const tallyRepo = async (
                id: string,
                composed: IsolatedAgent["placement"]["repos"][number],
            ): Promise<{ readonly landed: number; readonly present: number } | `unread`> => {
                const { repo, base, landedTip, landedHead, absorbed } = composed;
                if (landedTip === undefined || landedHead === undefined) {
                    return { landed: 0, present: 0 };
                }
                // Already-absorbed counts on both sides for free: history holds every path (markLandingAbsorbed).
                if (absorbed !== undefined) {
                    // Cached spans are dead weight once absorbed; dropped here since another module wrote the mark.
                    const anchor = anchors.get(`${repo} ${landedTip}`);
                    spans.delete(`applied ${repo} ${landedHead} ${landedTip}`);
                    if (anchor !== undefined) {
                        spans.delete(`own ${repo} ${anchor} ${landedTip}`);
                        anchors.delete(`${repo} ${landedTip}`);
                    }
                    return { landed: absorbed, present: absorbed };
                }
                const dir = worktrees.mainDir(repo);
                try {
                    const head = await headOf(repo, dir);
                    if (head === undefined) {
                        return `unread`;
                    }
                    // Own work narrowed to what the patch carried, same intersection origins.ts uses.
                    const applied = new Set(await pathsBetween(dir, `applied ${repo} ${landedHead} ${landedTip}`, landedHead, landedTip));
                    const anchor = await anchorFor(dir, repo, landedTip, base);
                    const own = await pathsBetween(dir, `own ${repo} ${anchor} ${landedTip}`, anchor, landedTip);
                    const committed = await expiry.committedSince(dir, repo, landedHead, head);
                    const uncommitted = await dirtyIn(repo, dir);
                    // Every-path-committed is the absorbed condition, but the durable mark is written elsewhere.
                    const { count, here } = tallyLanding(own, applied, committed, uncommitted);
                    return { landed: count, present: here };
                } catch (error) {
                    // Unresolvable shas report nothing; caught so one agent can't sink the whole roster read.
                    logger.debug({ err: error, repo, agent: id }, "landed presence: landing unresolvable");
                    return `unread`;
                }
            };
            let moved = false;
            for (const entry of entries.filter(landedInMainTree)) {
                let landed = 0;
                let present = 0;
                // A repo that could not be read this time: its 0/0 would read as "nothing missing" and wipe who removed
                // the work, which no later reading can recover, so the entry keeps what it read last instead.
                let unread = false;
                for (const composed of entry.placement.repos) {
                    const share = await tallyRepo(entry.id, composed);
                    if (share === `unread`) {
                        unread = true;
                        continue;
                    }
                    landed += share.landed;
                    present += share.present;
                }
                if (unread) {
                    continue;
                }
                const before = readings.get(entry.id);
                const reading = readingOf(entry, { landed, present }, before, seen.has(entry.id), sole);
                seen.add(entry.id);
                moved ||= readingMoved(before, reading);
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
