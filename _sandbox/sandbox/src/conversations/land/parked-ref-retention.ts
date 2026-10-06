import { execFile } from "node:child_process";
import { defaultGit, GIT_GLOBAL_ARGS, type GitRunner } from "@intentic/base/git";
import type { Logger } from "pino";
import type { Chore } from "../../system/chore-clock.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import type { AgentWorktrees } from "../worktrees/worktrees.js";
import { carriedRef, parkedAgentRefs, parkedRefOf } from "../../git/agent-refs.js";

// HOW LONG AN ARCHIVED CONVERSATION'S BRANCH IS KEPT (2026-10-05). Archiving parks `agent/<id>` on `refs/agent/<id>`
// (agent-refs.ts) so the work survives, and until now only the owner's Purge dropped it: this sandbox held 3,301 of
// them. Once a day, the parked ref (and its carry marker) of a conversation archived longer ago than the retention is
// deleted, after which the daily gc (git/ops/git-gc.ts) lets its commits go two weeks later. Deleted only on positive
// evidence: the registry knows the conversation and says it was archived that long ago. A ref whose conversation the
// registry does not know stays, and is counted: a registry that lost rows is not a list of things to destroy.
// Un-archiving one past the retention starts its checkout afresh from the main line.

// The clock's unit, spelled here: a value import from system/ would close a cycle (system/ reaches conversations/).
const DAY_MS = 24 * 60 * 60_000;

export const PARKED_REF_RETENTION_MS = 90 * DAY_MS;

// Refs deleted per transaction, each under its repo's lock, so a turn that starts meanwhile waits for one batch at most.
const BATCH = 200;

export interface ParkedRefVerdicts {
    // Archived longer ago than the retention: these go.
    readonly drop: readonly string[];
    // Live, or archived within the retention.
    readonly kept: readonly string[];
    // No registry entry: left alone, since absence is not proof.
    readonly unknown: readonly string[];
}

// Which parked conversations' refs go, from what the registry says of each at `now`; an archive time in the future (a
// clock stepped back) is within the retention.
export const judgeParkedRefs = (
    ids: readonly string[],
    entryOf: (id: string) => { readonly archivedAt?: number | undefined } | undefined,
    now: number,
    retentionMs: number = PARKED_REF_RETENTION_MS,
): ParkedRefVerdicts => {
    const drop: string[] = [];
    const kept: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
        const entry = entryOf(id);
        if (entry === undefined) {
            unknown.push(id);
        } else if (entry.archivedAt !== undefined && now - entry.archivedAt > retentionMs) {
            drop.push(id);
        } else {
            kept.push(id);
        }
    }
    return { drop, kept, unknown };
};

// Deletes refs in one transaction, each only if it still names the sha it was read at: one that moved fails the whole
// batch, which then deletes nothing. One packed-refs rewrite for the batch, where `update-ref -d` rewrites it per ref.
export type RefDeleter = (dir: string, refs: readonly { readonly ref: string; readonly sha: string }[]) => Promise<void>;

export const deleteRefsAtomically: RefDeleter = (dir, refs) =>
    new Promise((resolve, reject) => {
        const child = execFile("git", [...GIT_GLOBAL_ARGS, "-C", dir, "update-ref", "--stdin"], (error, _stdout, stderr) =>
            error === null ? resolve() : reject(Object.assign(error, { stderr })),
        );
        // A git that exits before reading everything closes the pipe; its own exit status is the error reported above.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(refs.map(({ ref, sha }) => `delete ${ref} ${sha}\n`).join(""));
    });

export interface ParkedRefRetentionDeps {
    readonly workspace: WorkspacePaths;
    readonly agents: { readonly entry: (id: string) => { readonly archivedAt?: number | undefined } | undefined };
    readonly agentWorktrees: Pick<AgentWorktrees, "mainDir" | "withRepoLock">;
    readonly conversations: { readonly liveSessionIds: () => readonly string[] };
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly git?: GitRunner;
    readonly deleteRefs?: RefDeleter;
    readonly now?: () => number;
}

const idle = (deps: ParkedRefRetentionDeps): boolean => deps.conversations.liveSessionIds().length === 0;

// What each of these refs names, for those that exist.
const refTips = async (main: string, git: GitRunner, refs: readonly string[]): Promise<Map<string, string>> => {
    const tips = new Map<string, string>();
    const { stdout } = await git(main, ["for-each-ref", "--format=%(objectname) %(refname)", ...refs]);
    for (const line of stdout.split("\n")) {
        const [sha, ref] = line.split(" ");
        if (sha !== undefined && ref !== undefined) {
            tips.set(ref, sha);
        }
    }
    return tips;
};

interface RepoTally {
    readonly parked: number;
    readonly kept: number;
    readonly unknown: number;
    dropped: number;
    failed: number;
}

// One batch under the repo's lock, judged again from the refs and the registry as they stand now: a conversation
// un-archived since the first read, or a ref that moved, is not this pass's to delete.
const dropBatch = async (repo: string, batch: readonly string[], deps: ParkedRefRetentionDeps, tally: RepoTally): Promise<void> => {
    const git = deps.git ?? defaultGit;
    const main = deps.agentWorktrees.mainDir(repo);
    await deps.agentWorktrees.withRepoLock(repo, async () => {
        const parked = await parkedAgentRefs(main, git, batch);
        const { drop } = judgeParkedRefs([...parked.keys()], deps.agents.entry, (deps.now ?? Date.now)());
        if (drop.length === 0) {
            return;
        }
        // Each with its carry marker where it has one (stray-work.ts), which would hold the same commits alive.
        const markers = await refTips(
            main,
            git,
            drop.map((id) => carriedRef(`agent/${id}`)),
        );
        const doomed = [...parked].filter(([id]) => drop.includes(id)).map(([id, sha]) => ({ ref: parkedRefOf(id), sha }));
        for (const [ref, sha] of markers) {
            doomed.push({ ref, sha });
        }
        try {
            await (deps.deleteRefs ?? deleteRefsAtomically)(main, doomed);
            tally.dropped += drop.length;
        } catch (error) {
            tally.failed += drop.length;
            deps.logger.warn({ err: error, repo, refs: drop.length }, "parked refs: a batch could not be deleted, it is tried again tomorrow");
        }
    });
};

const retainIn = async (repo: string, deps: ParkedRefRetentionDeps): Promise<RepoTally | undefined> => {
    const parked = await parkedAgentRefs(deps.agentWorktrees.mainDir(repo), deps.git ?? defaultGit);
    if (parked.size === 0) {
        return undefined;
    }
    const verdicts = judgeParkedRefs([...parked.keys()], deps.agents.entry, (deps.now ?? Date.now)());
    const tally: RepoTally = { parked: parked.size, kept: verdicts.kept.length, unknown: verdicts.unknown.length, dropped: 0, failed: 0 };
    for (let start = 0; start < verdicts.drop.length; start += BATCH) {
        if (!idle(deps)) {
            deps.logger.info({ repo, left: verdicts.drop.length - start }, "parked refs: a turn started, the rest wait for the next run");
            break;
        }
        await dropBatch(repo, verdicts.drop.slice(start, start + BATCH), deps, tally);
    }
    return tally;
};

// One pass over the root repo and every nested one; one repo's failure costs only itself.
export const runParkedRefRetention = async (deps: ParkedRefRetentionDeps): Promise<void> => {
    for (const repo of ["root", ...(await discoverRepos(deps.workspace.root))]) {
        try {
            const tally = await retainIn(repo, deps);
            if (tally !== undefined) {
                deps.logger.info(
                    { repo, ...tally, retentionDays: PARKED_REF_RETENTION_MS / DAY_MS },
                    "parked refs: deleted those of conversations archived past the retention; unknown ones are left",
                );
            }
        } catch (error) {
            deps.logger.warn({ err: error, repo }, "parked refs: the retention pass failed for this repo");
        }
    }
};

export const parkedRefRetentionChore = (deps: ParkedRefRetentionDeps): Chore => ({
    name: "parked-ref-retention",
    everyMs: DAY_MS,
    when: () => idle(deps),
    run: () => runParkedRefRetention(deps),
});
