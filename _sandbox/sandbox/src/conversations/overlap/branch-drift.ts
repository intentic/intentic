import { mapPool, serialLock } from "@intentic/base/async";
import { exitCodeOf, stdoutOf } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { CONVERSATION_TRAILER } from "../../git-identity.js";
import { agentBranchTips, branchSha } from "../../git/agent-refs.js";
import { mainLineSha } from "../../git/main-line-tip.js";
import { opt } from "../../opt.js";
import { awaitingWake, type ConversationState } from "../actor/conversation-state.js";
import { agentRepoAnchor } from "../land/agent-changes.js";
import { branchOf } from "../land/branch/branch-repos.js";
import { recordedTargetOf, upstreamOf } from "../land/land-target.js";
import { isIsolated, type IsolatedAgent, type PersistedAgent, type RepoRecord } from "../registry/agents-store.js";
import { type DriftRepo, type LandMarks, landMarksOf } from "../registry/land-marks.js";
import { driftAudience, type DriftNewsDeps, tellDrift } from "./branch-drift-news.js";
import { inWorkspace } from "../land/branch/unlanded-paths.js";
import type { FilesInFlight } from "../files-in-flight.js";

// FINISHED WORK THAT STOPS MERGING, FOUND WHEN IT HAPPENS rather than at its land. When the line a held branch lands on
// moves (the main line, or a subagent's parent's branch), each conversation at rest with work on its branch is tried
// against it again: `git merge-tree` with the land's own anchor as the base, which writes nothing a checkout sees. Two
// things keep that cheap. Moves are coalesced: one pass a window after the first move, however many commits land in it.
// And a branch is tried only where the move touched a file it changed (files in flight, ../files-in-flight.ts); every other
// branch keeps its last verdict at the new commit, since a merge of files nobody else touched cannot start to conflict.
// What a pass finds goes on the conversation's record (registry/land-marks.ts `drift`), so `agents ls` and `agents show`
// carry it and a restart does not say it twice; who is told is branch-drift-news.ts.

// How long after the first move of the main line a pass runs: a burst of lands (a morning's batch) is one pass.
const DRIFT_WINDOW_MS = 30_000;
// Conversations tried at once; each is a few short git reads, one merge where it matters.
const TRIED_AT_ONCE = 2;
// Files kept per repo on the record; the count of the rest rides beside them.
const KEPT_PATHS = 40;

export type DriftDeps = DriftNewsDeps & { readonly inFlight: FilesInFlight };

export interface DriftWatch {
    // What the ref feed reports (git/remote/ref-watch.ts): a pass is due a window after the main line or a parent moved.
    readonly moved: (repos: readonly string[], conversations?: readonly string[]) => void;
    // Runs a pass now, after any under way; what the window's timer and a suite call.
    readonly pass: () => Promise<void>;
    readonly stop: () => void;
}

// One repo of one branch as a pass last tried it: against which commit of its line, at which tip, and what clashed.
interface Tried {
    readonly upstream: string;
    readonly tip: string;
    readonly conflicts: readonly string[];
    readonly anchor?: string;
}

/** The files a three-way merge of `tip` into `upstream` from `anchor` leaves conflicted; none when it merges clean. Git
 *  exits 1 for a conflicted merge and higher for one it could not run, which throws. */
export const mergeConflicts = async (dir: string, anchor: string, upstream: string, tip: string, git: GitRunner = defaultGit): Promise<string[]> => {
    const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", `--merge-base=${anchor}`, upstream, tip];
    try {
        await git(dir, args);
        return [];
    } catch (error) {
        const listed = stdoutOf(error);
        if (exitCodeOf(error) !== 1 || listed === undefined) {
            throw error;
        }
        // The merged tree's id first, then each conflicted path once.
        return [...new Set(listed.split("\0").slice(1).filter((path) => path !== ""))];
    }
};

/** For each of `paths`, the conversations whose landed commits on `upstream` since `from` changed it, read off their
 *  `Conversation-Id` trailers; a commit nobody in this sandbox landed (the owner's own, a pull) names nobody. */
export const landedBy = async (dir: string, from: string, upstream: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<Map<string, string[]>> => {
    const by = new Map<string, string[]>();
    if (paths.length === 0) {
        return by;
    }
    const { stdout } = await git(dir, [
        "log",
        "--no-renames",
        "--name-only",
        `--format=%x1e%(trailers:key=${CONVERSATION_TRAILER},valueonly,separator=%x2c)`,
        `${from}..${upstream}`,
        "--",
        ...paths,
    ]);
    for (const record of stdout.split("\x1e")) {
        const [head = "", ...files] = record.split("\n");
        const ids = head.split(",").map((id) => id.trim()).filter((id) => id !== "");
        for (const file of files.filter((each) => each !== "")) {
            by.set(file, [...new Set([...(by.get(file) ?? []), ...ids])]);
        }
    }
    return by;
};

// At rest: no turn, no land, no wake it waits on (whose turn opens on the moved line anyway). A conversation this daemon
// has not run since it started is at rest.
const atRest = (state: ConversationState | undefined): boolean =>
    state === undefined || (state.phase.kind === "idle" && !state.turn.landing && !state.turn.resuming && !awaitingWake(state));

// Whose branch a pass tries: work of its own on a branch here, live, not already refused at a land (that clash is on its
// card already, with its own Resolve), and at rest.
const triable = (deps: Pick<DriftDeps, "conversations">, entry: PersistedAgent | undefined): entry is IsolatedAgent =>
    entry !== undefined &&
    isIsolated(entry) &&
    entry.archivedAt === undefined &&
    entry.placement.runner === undefined &&
    (entry.landing.conflicts?.length ?? 0) === 0 &&
    atRest(deps.conversations.state(entry.id));

const sameRepos = (a: readonly DriftRepo[], b: readonly DriftRepo[]): boolean => JSON.stringify(a) === JSON.stringify(b);

// One read per key per pass, however many branches ask it.
const memoOf = <T>(): ((key: string, read: () => Promise<T>) => Promise<T>) => {
    const memo = new Map<string, Promise<T>>();
    return (key, read) => {
        const held = memo.get(key) ?? read();
        memo.set(key, held);
        return held;
    };
};

// A pass's shared reads, each spawned once: the tip of each line, and the files a line's move touched.
const passReads = (deps: Pick<DriftDeps, "agents" | "agentWorktrees">, git: GitRunner) => {
    const tips = memoOf<string | undefined>();
    const branches = memoOf<ReadonlyMap<string, string>>();
    const moves = memoOf<ReadonlySet<string> | undefined>();
    return {
        // A branch's tip, off one sweep of the repo's agent branches.
        tipOf: async (repo: string, branch: string): Promise<string | undefined> =>
            (await branches(repo, () => agentBranchTips(deps.agentWorktrees.mainDir(repo), git))).get(branch),
        // What this repo of the branch merges into: the main line, a parent's branch, or nothing it could rebase onto.
        upstreamOf: (entry: IsolatedAgent, repo: string): Promise<string | undefined> => {
            const main = deps.agentWorktrees.mainDir(repo);
            const upstream = upstreamOf(entry, recordedTargetOf(deps.agents, entry));
            if (upstream.kind === "none" || branchOf(entry.placement, repo) !== undefined) {
                return Promise.resolve(undefined);
            }
            if (upstream.kind === "main") {
                return tips(`main\0${repo}`, () => mainLineSha(main, git));
            }
            const parent = deps.agents.entry(upstream.parent);
            return parent === undefined || !isIsolated(parent)
                ? Promise.resolve(undefined)
                : tips(`branch\0${repo}\0${parent.placement.branch}`, () => branchSha(main, parent.placement.branch, git));
        },
        // Paths a line's move touched; unreadable (a rewritten line) reads as everything, so the branch is tried.
        moved: (repo: string, from: string, to: string): Promise<ReadonlySet<string> | undefined> =>
            moves(`${repo}\0${from}\0${to}`, async () => {
                try {
                    const { stdout } = await git(deps.agentWorktrees.mainDir(repo), ["diff", "--name-only", "--no-renames", "-z", from, to]);
                    return new Set(stdout.split("\0").filter((path) => path !== ""));
                    // allow(silent-catch): a move git cannot diff is tried in full, which is the safe reading.
                } catch {
                    return undefined;
                }
            }),
    };
};
type PassReads = ReturnType<typeof passReads>;

// Every repo of one branch as a pass tries it: the last verdict carried to the line's new commit where the move touched
// none of this branch's files, else a merge tried afresh. Remembered across passes, keyed by conversation and repo.
const branchTrier = (deps: DriftDeps, git: GitRunner) => {
    const tried = new Map<string, Tried>();
    const tryRepo = async (entry: IsolatedAgent, composed: RepoRecord, reads: PassReads): Promise<Tried | undefined> => {
        const main = deps.agentWorktrees.mainDir(composed.repo);
        const [upstream, tip] = await Promise.all([reads.upstreamOf(entry, composed.repo), reads.tipOf(composed.repo, entry.placement.branch)]);
        if (upstream === undefined || tip === undefined) {
            return undefined;
        }
        const key = `${entry.id}\0${composed.repo}`;
        const last = tried.get(key);
        if (last !== undefined && last.tip === tip) {
            const moved = last.upstream === upstream ? new Set<string>() : await reads.moved(composed.repo, last.upstream, upstream);
            const mine = new Set(deps.inFlight.pathsOf(entry.id));
            if (moved !== undefined && ![...moved].some((path) => mine.has(inWorkspace(composed.repo, path)))) {
                const carried = { ...last, upstream };
                tried.set(key, carried);
                return carried;
            }
        }
        const anchor = await agentRepoAnchor(deps.agentWorktrees, entry, composed, git);
        const conflicts = anchor === tip || anchor === upstream ? [] : await mergeConflicts(main, anchor, upstream, tip, git);
        const next = { upstream, tip, conflicts, anchor };
        tried.set(key, next);
        return next;
    };
    return async (entry: IsolatedAgent, reads: PassReads): Promise<(readonly [string, Tried])[]> => {
        const found = await Promise.all(entry.placement.repos.map(async (composed) => [composed.repo, await tryRepo(entry, composed, reads)] as const));
        return found.flatMap(([repo, each]) => (each === undefined ? [] : [[repo, each] as const]));
    };
};

// A repo's clash as the record keeps it, each file with who landed what it clashes with.
const driftRepoOf = async (deps: DriftDeps, repo: string, found: Tried, git: GitRunner): Promise<DriftRepo> => {
    const named = found.conflicts.slice(0, KEPT_PATHS);
    const by =
        found.anchor === undefined
            ? new Map<string, string[]>()
            : await landedBy(deps.agentWorktrees.mainDir(repo), found.anchor, found.upstream, named, git).catch(() => new Map<string, string[]>());
    return {
        repo,
        onto: found.upstream,
        paths: named.map((path) => ({ path, ...opt("by", by.get(path)) })),
        ...opt("more", found.conflicts.length > named.length ? found.conflicts.length - named.length : undefined),
    };
};

const amendDrift = (deps: Pick<DriftDeps, "agents" | "logger">, id: string, drift: LandMarks["drift"]): Promise<void> =>
    deps.agents
        .amendLandMarks(id, (marks) => ({ ...marks, drift }))
        .catch((error: Error) => deps.logger.warn({ err: error, conversationId: id }, "drift: the record could not be amended"));

// What a pass found for one conversation, onto its record and to its audience: a clean branch clears the mark, the same
// work found clashing again keeps it current quietly, and a new finding (a first one, or after the branch moved) is said.
const settleDrift = async (deps: DriftDeps, entry: IsolatedAgent, found: readonly (readonly [string, Tried])[], git: GitRunner): Promise<void> => {
    const mark = landMarksOf(entry).drift;
    const clashing = found.filter(([, each]) => each.conflicts.length > 0);
    if (clashing.length === 0) {
        return mark === undefined ? undefined : amendDrift(deps, entry.id, undefined);
    }
    const tips = found.map(([repo, each]) => `${repo}@${each.tip}`).join(",");
    const repos = await Promise.all(clashing.map(([repo, each]) => driftRepoOf(deps, repo, each, git)));
    if (mark?.tips === tips) {
        return sameRepos(mark.repos, repos) ? undefined : amendDrift(deps, entry.id, { ...mark, repos });
    }
    const asked = mark?.asked === true;
    const told = await driftAudience(deps, entry, asked);
    // On the record before it is said: a restart between the two must not say it twice.
    await amendDrift(deps, entry.id, { at: mark?.at ?? Date.now(), tips, repos, ...opt("asked", asked || told !== "notice" ? true : undefined) });
    await tellDrift(deps, entry, repos, told);
};

// Whose own refs moving moves another branch's line: a parent with subagents whose work follows its checkout.
const followedBy = (deps: Pick<DriftDeps, "agents" | "inFlight">, id: string): boolean =>
    deps.inFlight.holders().some((holder) => {
        const entry = deps.agents.entry(holder);
        return entry !== undefined && isIsolated(entry) && upstreamOf(entry, recordedTargetOf(deps.agents, entry)).kind === "parent" && entry.placement.parent === id;
    });

export const createDriftWatch = (deps: DriftDeps, git: GitRunner = defaultGit, windowMs = DRIFT_WINDOW_MS): DriftWatch => {
    const serial = serialLock();
    const tryBranch = branchTrier(deps, git);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryConversation = async (id: string, reads: PassReads): Promise<void> => {
        const entry = deps.agents.entry(id);
        if (triable(deps, entry) && deps.inFlight.pathsOf(id).length > 0) {
            await settleDrift(deps, entry, await tryBranch(entry, reads), git);
            return;
        }
        // Landed, discarded or archived since: a mark from before says nothing about it now. One busy is tried after.
        const gone = entry === undefined || entry.archivedAt !== undefined || deps.inFlight.pathsOf(id).length === 0;
        if (gone && landMarksOf(entry).drift !== undefined) {
            await amendDrift(deps, id, undefined);
        }
    };
    const pass = (): Promise<void> =>
        serial(async () => {
            const reads = passReads(deps, git);
            const marked = deps.agents.ids().filter((id) => landMarksOf(deps.agents.entry(id)).drift !== undefined);
            await mapPool([...new Set([...deps.inFlight.holders(), ...marked])], TRIED_AT_ONCE, async (id) => {
                try {
                    await tryConversation(id, reads);
                } catch (error) {
                    deps.logger.warn({ err: error, conversationId: id }, "drift: a held branch could not be tried against its line");
                }
            });
        });
    return {
        moved: (_repos, conversations) => {
            // Only conversations' own branches moved: their readings are the settle's; a pass is due only for a line.
            if (conversations !== undefined && !conversations.some((id) => followedBy(deps, id))) {
                return;
            }
            timer ??= setTimeout(() => {
                timer = undefined;
                void pass();
            }, windowMs);
            timer.unref?.();
        },
        pass,
        stop: () => {
            clearTimeout(timer);
            timer = undefined;
        },
    };
};
