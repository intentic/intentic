import { join } from "node:path";
import type { Logger } from "pino";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Services } from "../../composition.js";
import type { ActionResult } from "../changes/changes-commits.js";
import { upstreamOf } from "../ops/branches.js";
import { operationInProgress } from "../ops/operation.js";
import { fetchTracked, type FollowOutcome, followTracked } from "./follow-upstream.js";
import { trackedBranch } from "./remote.js";
import { gitFailureReason } from "../git.js";
import { AGENT_GIT_AUTHOR } from "../../git-identity.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";

/* MAIN FOLLOWS ITS REMOTE. Every workspace repo on a branch that tracks one is fetched on a clock, and what arrived is
   brought into the main tree while it is quiet: fast-forwarded when the branch has nothing of its own, else merged
   (follow-upstream.ts). Another writer's push (a second sandbox, CI's fix agent, a colleague) then reaches
   main within minutes instead of at the owner's next pull, and an agent whose work clashes with it meets the clash in
   its own worktree, at its own land, where it knows why it wrote what it wrote.

   Nothing here can leave the main tree mid-merge: a conflict, an uncommitted file in the way, or a git operation in
   progress skips the repo until the next round, and says so once. It never runs under a turn working in the main tree
   (whose files would move beneath it), and takes the repo's lock, so it queues with lands and commits rather than
   racing them. `followOrigin` off, nothing is fetched. */

const TICK_MS = 2 * 60_000;
// Behind boot's own restores and resumes.
const WARMUP_MS = 60_000;

export type RepoFollowOutcome =
    | FollowOutcome
    | { readonly status: "untracked" }
    | { readonly status: "fetch-failed"; readonly reason: string }
    // Git itself failed somewhere a refusal was not expected (a missing object, a locked ref).
    | { readonly status: "error"; readonly reason: string }
    // Left for the next round: a turn working in the main tree, a land or commit holding the repo, or a merge, rebase
    // or cherry-pick the owner has open.
    | { readonly status: "deferred"; readonly why: "main-tree-turn" | "repo-busy" | "operation" };

export interface RepoFollow {
    readonly repo: string;
    readonly outcome: RepoFollowOutcome;
}

export interface OriginFollowDeps {
    readonly workspace: { readonly root: string };
    readonly enabled: () => Promise<boolean>;
    // A turn running in the main tree right now, whose files must not move under it.
    readonly mainTreeBusy: () => boolean;
    readonly agentWorktrees: Pick<Services["agentWorktrees"], "withRepoLock" | "repoBusy">;
    readonly history: Pick<Services["history"], "snapshot" | "notifyUserWrite">;
    readonly logger: Logger;
    readonly git?: GitRunner;
    readonly fetch?: (dir: string, remote: string) => Promise<ActionResult>;
}

export interface OriginFollow {
    readonly start: () => void;
    readonly stop: () => void;
    // One pass over every repo now; a pass already running is joined, not doubled.
    readonly round: () => Promise<readonly RepoFollow[]>;
}

const moved = (outcome: RepoFollowOutcome): boolean => outcome.status === "fast-forwarded" || outcome.status === "merged";

// What is worth a log line once: the same conflict every two minutes is one piece of news, not thirty.
const newsOf = (outcome: RepoFollowOutcome): string | undefined => {
    switch (outcome.status) {
        case "conflicted":
            return `conflicted:${outcome.paths.join(",")}`;
        case "refused":
            return `refused:${outcome.reason}`;
        case "fetch-failed":
        case "error":
            return `${outcome.status}:${outcome.reason}`;
        default:
            return undefined;
    }
};

export const createOriginFollow = (deps: OriginFollowDeps): OriginFollow => {
    const git = deps.git ?? defaultGit;
    const fetch = deps.fetch ?? fetchTracked;
    const lastNews = new Map<string, string | undefined>();

    const followOne = async (repo: string): Promise<RepoFollowOutcome> => {
        const dir = join(deps.workspace.root, repo);
        const tracked = await trackedBranch(dir, git);
        if (tracked === undefined) {
            return { status: "untracked" };
        }
        const fetched = await fetch(dir, tracked.remote);
        if (!fetched.ok) {
            return { status: "fetch-failed", reason: fetched.reason };
        }
        // Read before queueing on the lock, so a repo with nothing new never waits behind a land.
        const { ahead, behind } = await upstreamOf(dir, tracked.branch, git);
        if (behind === 0) {
            return { status: "current", ahead };
        }
        if (deps.mainTreeBusy()) {
            return { status: "deferred", why: "main-tree-turn" };
        }
        if (deps.agentWorktrees.repoBusy(repo)) {
            return { status: "deferred", why: "repo-busy" };
        }
        return deps.agentWorktrees.withRepoLock(repo, async (): Promise<RepoFollowOutcome> => {
            // Asked again under the lock: a turn may have started in the main tree while this one waited.
            if (deps.mainTreeBusy()) {
                return { status: "deferred", why: "main-tree-turn" };
            }
            if ((await operationInProgress(dir)) !== undefined) {
                return { status: "deferred", why: "operation" };
            }
            // Re-read: the branch checked out, or what it tracks, may have changed since the fetch.
            const current = await trackedBranch(dir, git);
            if (current === undefined) {
                return { status: "untracked" };
            }
            return followTracked(
                dir,
                current,
                {
                    author: AGENT_GIT_AUTHOR,
                    beforeMove: async () => {
                        await deps.history.snapshot("user", `before following ${current.upstream} in ${repo}`);
                    },
                },
                git,
            );
        });
    };

    const report = (repo: string, outcome: RepoFollowOutcome): void => {
        if (moved(outcome)) {
            deps.logger.info({ repo, outcome }, "follow origin: main tree caught up with its remote");
        }
        const news = newsOf(outcome);
        if (news !== undefined && lastNews.get(repo) !== news) {
            deps.logger.warn({ repo, outcome }, "follow origin: could not catch up with the remote");
        }
        // A deferral is no news either way: the next round may still meet the same conflict.
        if (outcome.status !== "deferred") {
            lastNews.set(repo, news);
        }
    };

    const pass = async (): Promise<readonly RepoFollow[]> => {
        if (!(await deps.enabled())) {
            return [];
        }
        const repos = await discoverRepos(deps.workspace.root);
        const results = await Promise.all(
            repos.map(async (repo): Promise<RepoFollow> => {
                try {
                    return { repo, outcome: await followOne(repo) };
                } catch (cause) {
                    return { repo, outcome: { status: "error", reason: gitFailureReason(cause, "git failed") } };
                }
            }),
        );
        for (const { repo, outcome } of results) {
            report(repo, outcome);
        }
        if (results.some(({ outcome }) => moved(outcome))) {
            // Pulled files are the owner's side of history, as a Pull press makes them.
            deps.history.notifyUserWrite();
        }
        return results;
    };

    let running: Promise<readonly RepoFollow[]> | undefined;
    const round = (): Promise<readonly RepoFollow[]> => {
        running ??= pass()
            .catch((cause: unknown) => {
                deps.logger.warn({ err: cause }, "follow origin: round failed");
                return [];
            })
            .finally(() => (running = undefined));
        return running;
    };

    let timer: NodeJS.Timeout | undefined;
    return {
        start: () => {
            timer ??= setTimeout(() => {
                void round();
                timer = setInterval(() => void round(), TICK_MS);
                timer.unref();
            }, WARMUP_MS);
            timer.unref();
        },
        stop: () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                clearInterval(timer);
                timer = undefined;
            }
        },
        round,
    };
};
