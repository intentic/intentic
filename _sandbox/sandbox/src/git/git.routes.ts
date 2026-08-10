import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitContract, type GitChange, type GitChanges, type OriginAgent, type RepoChanges } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { discoverRepos, isValidRepoId } from "../workspace/repo-discovery.js";
import { isControlPlanePath, resolveWithin } from "../workspace/workspace-files.js";
import { askQuickModel } from "../agent/quick-model.js";
import type { ActionResult } from "./changes.js";
import { cleanCommitSubject, commitMessagePrompt } from "./commit-message.js";
import { AGENT_GIT_AUTHOR, gitFailureReason } from "./git.js";

// How long one Changes scan's result stands in for the next caller's. Long enough to swallow the browser's
// per-batch refetch storm, short enough that a save still shows up in the panel as it happens.
const COALESCE_MS = 500;

// The most changes ONE repo ships per scan. A cloned monorepo or a mass delete reports six-figure lists, and
// every one of those rows would be zod-validated on this event loop, serialized to every connected browser up
// to once a second, and rendered as real DOM — which is how a big clone used to take the whole UI down. The
// panel is a review surface, not a pager: past the budget the remainder is a COUNT (`truncated`), and whole-repo
// actions (commit all, discard repo) still cover it because they never enumerate paths. Conflicts are exempt —
// they block every commit in the repo, so all of them must reach the user, and staged outranks unstaged for
// what's left because it is what a commit is about to record.
export const MAX_REPO_CHANGES = 500;

// Apply the budget across the two cuttable sides; `truncated` is what fell off (0 ⇒ shipped whole).
export const capRepoChanges = (
    conflicted: GitChange[],
    staged: GitChange[],
    unstaged: GitChange[],
): { conflicted: GitChange[]; staged: GitChange[]; unstaged: GitChange[]; truncated: number } => {
    const stagedBudget = Math.max(0, MAX_REPO_CHANGES - conflicted.length);
    const unstagedBudget = Math.max(0, stagedBudget - staged.length);
    return {
        conflicted,
        staged: staged.length > stagedBudget ? staged.slice(0, stagedBudget) : staged,
        unstaged: unstaged.length > unstagedBudget ? unstaged.slice(0, unstagedBudget) : unstaged,
        truncated: Math.max(0, staged.length - stagedBudget) + Math.max(0, unstaged.length - unstagedBudget),
    };
};

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Per-repo git ops over "root" (the /work repo) and every discovered repo under it ({repo} is the repo's
// root-relative dir). An unknown {repo} is NOT_FOUND; a path that escapes the repo dir is BAD_REQUEST; a
// missing file is NOT_FOUND. `changes` is the Changes panel's aggregated review set; commit/discard take
// optional `paths` for the per-file actions.
export const createGitRoutes = (services: Services) => {
    const i = implement(gitContract).$context<OrpcContext>();
    // Rewrite the --separate-git-dir pointer file if the agent deleted it, so every git route self-heals
    // (same convention as history's healGitPointer: /history/gits/<name>, "root" included).
    const healPointer = async (repo: string, dir: string): Promise<void> => {
        if (await exists(join(dir, ".git"))) {
            return;
        }
        const gitDir = repoGitDir(services.config.historyRoot, repo);
        if (await exists(gitDir)) {
            await writeFile(join(dir, ".git"), `gitdir: ${gitDir}\n`);
        }
    };
    const repoDir = async (repo: string): Promise<string> => {
        if (repo === "root") {
            await healPointer(repo, services.workspace.root);
            return services.workspace.root;
        }
        if (isValidRepoId(repo)) {
            const dir = join(services.workspace.root, repo);
            if (await exists(dir)) {
                await healPointer(repo, dir);
                return dir;
            }
        }
        throw new ORPCError("NOT_FOUND", { message: "unknown repo" });
    };
    // Resolve a repo-relative path inside an already-resolved repo dir, with the two floors every file surface
    // applies: it may not climb out of the repo, and it may not reach the daemon's control plane — for repo
    // "root" that dir IS the workspace, so without this the repo file API would be the way around
    // isControlPlanePath. NOT_FOUND for the latter, matching the workspace routes.
    const guardRepoPath = (dir: string, path: string): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
        }
        if (isControlPlanePath(services.workspace.root, target)) {
            throw new ORPCError("NOT_FOUND", { message: "not found" });
        }
        return target;
    };
    /* THE MAIN TREE HAS TWO WRITERS, and this is the seam where they meet. The user commits, stages and
     * discards through this router; an agent's finished turn lands through agents/land.ts, which patches its
     * delta into the same repo's worktree and index. Interleave the two and the user records half a patch —
     * the one genuinely unsafe thing about working while an agent works.
     *
     * `land` already serializes on the repo's op chain (worktrees.withRepoLock). This side simply takes the
     * same lock, and the race stops existing. That is why the panel does not gate committing on "is an agent
     * running": a UI gate could only ever be a guess about a race, it cannot prevent one — the terminal commits
     * straight past it, and it blocked the ninety-nine turns that touch a worktree to catch the one that
     * touches this tree.
     *
     * `repoDir` runs INSIDE the lock: it self-heals the .git pointer, which is itself a write. Never call one
     * `onRepo` from inside another — the chain is a queue, not a reentrant mutex. Read-only routes stay out of
     * it entirely; git's own locking covers them, and queueing a diff behind a push would be a stall the user
     * feels for nothing. */
    const onRepo = <T>(repo: string, task: (dir: string) => Promise<T>): Promise<T> =>
        services.agentWorktrees.withRepoLock(repo, async () => task(await repoDir(repo)));

    /* WHICH REPOS ARE MID-COMMIT — the one piece of panel state that cannot live in the browser.
     *
     * The commit request outlives the tab: reload while one is running and that tab's own busy flag went with
     * the page, so the button re-armed over rows the commit was already recording. Held here instead, and put
     * on every /git/changes response, so a reload, a second tab and a phone all say the same thing. Per repo
     * because a commit is per repo, and the panel blocks only the box whose target overlaps.
     *
     * In memory on purpose: a daemon that restarts mid-commit has no commit running any more, and an empty set
     * is exactly the right answer for the browser that reconnects to it. */
    const committing = new Set<string>();
    const whileCommitting = async <T>(repo: string, run: () => Promise<T>): Promise<T> => {
        committing.add(repo);
        try {
            return await run();
        } finally {
            committing.delete(repo);
        }
    };

    // The coalesced Changes scan's memo (built below). Every mutation this router performs is one the user just
    // asked for and expects to see at once, so it drops the memo: the panel's own post-action refetch must never
    // be answered from a scan that predates the action it is refetching for.
    let scan: Promise<GitChanges> | undefined;
    let reusableUntil = 0;
    const invalidateScan = (): void => {
        scan = undefined;
        reusableUntil = 0;
    };
    // A sequence/HEAD-moving op: checkpoint the pre-action tree FIRST (so even a rewrite stays reversible from
    // the Checkpoints timeline), run it, and record the resulting tree on the timeline on a clean apply.
    const guarded = (repo: string, label: string, run: (dir: string) => Promise<ActionResult>): Promise<ActionResult> =>
        onRepo(repo, async (dir) => {
            await services.history.snapshot("user", label);
            const result = await run(dir);
            if (result.ok) {
                invalidateScan();
                services.history.notifyUserWrite();
            }
            return result;
        });
    // How many repo dirs the last scan actually walked — the scan's real cost driver, and the number that makes
    // "the review got slow" legible when the answer is "you cloned four more repos into the workspace".
    let scannedRepos = 0;
    /* ONE REPO'S ROW OF THE REVIEW — the unit both readers of this file need.
     *
     * The workspace scan below runs it once per discovered repo, concurrently. The commit route runs it for the
     * ONE repo it just wrote, inside the lock it already holds, so the panel can replace that repo's rows from
     * the commit's own answer instead of asking for a fresh workspace-wide scan afterwards (which is ~11 git
     * spawns per repo it did not touch, on the daemon's most contended path, while the user waits to see the
     * rows they just committed disappear).
     *
     * `undefined` is the INCLUSION RULE's answer, not an error: this repo has nothing the panel would show. It
     * lives here rather than at either call site because both must agree about it — the commit route splices its
     * answer into a list the scan built, and a repo the scan would have dropped has to drop there too. */
    const scanRepo = async (repo: string, dir: string): Promise<RepoChanges | undefined> =>
        // Per repo, not just per scan: the repos run concurrently, so the scan's own duration is the
        // SLOWEST repo's and says nothing about which one that was. With a row each, "the review takes
        // four seconds" resolves to the one repo responsible — usually the biggest tree or the one whose
        // remote is being consulted — instead of an indictment of the whole workspace.
        services.perf.track("git.scan.repo", { repo }, async (): Promise<RepoChanges | undefined> => {
            try {
                await healPointer(repo, dir);
                // The change scan, the remote read and the agent attribution are independent (none touches
                // the index) — one round-trip for all three. `remote` is what the panel's sync bar renders
                // per repo; `landed` is which agent landed each path this repo has ever received.
                const [{ branch, conflicted, staged, unstaged }, remote, landed, operation] = await Promise.all([
                    services.git.changedFiles(dir),
                    services.git.remoteState(dir),
                    // Attribution is the only part of this scan the panel can do without: it decorates the
                    // rows, it isn't the rows. A failure here degrades to "nobody landed anything" rather
                    // than joining the catch below and reporting the whole repo as unreadable.
                    services.agentOrigins.forRepo(repo, dir).catch((error: unknown) => {
                        services.logger.debug({ err: error, repo }, "git changes: origins unavailable");
                        return {};
                    }),
                    // A few stat()s beside a `git status` — cheap enough to ride every scan, and this is
                    // the read that turns "these files are conflicted" into "a rebase stopped here".
                    services.git.operationInProgress(dir),
                ]);
                // A repo with a clean tree still belongs in the response whenever there is remote work to
                // do: ahead of or behind its upstream, or sitting on a branch that has a remote but no
                // upstream yet (which the panel offers to Publish). Whatever the sync controls can act on
                // they must be able to SEE — a repo that drops out the instant its tree goes clean is exactly
                // the push/publish dead-end this avoids, and the reason committing everything felt like it
                // took the sync affordance with it.
                const publishable = branch !== undefined && remote.remote !== undefined && remote.upstream === undefined;
                if (
                    conflicted.length > 0 ||
                    staged.length > 0 ||
                    unstaged.length > 0 ||
                    remote.ahead > 0 ||
                    remote.behind > 0 ||
                    publishable ||
                    // A halted repo with a clean tree is rare but real (every conflict resolved, nothing
                    // committed yet) and it is the one repo the panel most needs to show: it is the only
                    // place the Abort lives.
                    operation !== undefined
                ) {
                    const capped = capRepoChanges(conflicted, staged, unstaged);
                    // Narrowed to the paths this scan actually reports (the capped lists — attribution
                    // decorates rows, and a cut row isn't one): an agent's landed delta outlives the
                    // review (the paths stay in `base..landedTip` until the branch goes), so shipping it
                    // whole would attribute files that are no longer changed at all.
                    const dirty = new Set(
                        [...capped.conflicted, ...capped.staged, ...capped.unstaged].flatMap((change) =>
                            change.from === undefined ? [change.path] : [change.path, change.from],
                        ),
                    );
                    const origins = Object.fromEntries(Object.entries(landed).filter(([path]) => dirty.has(path)));
                    return {
                        repo,
                        ...(branch !== undefined ? { branch } : {}),
                        conflicted: capped.conflicted,
                        ...(operation !== undefined ? { operation } : {}),
                        staged: capped.staged,
                        unstaged: capped.unstaged,
                        ...(capped.truncated > 0 ? { truncated: capped.truncated } : {}),
                        remote,
                        ...(Object.keys(origins).length > 0 ? { origins } : {}),
                    };
                }
                return undefined;
            } catch (error) {
                // One broken repo (a deleted .git with no heal source, a repo whose .git is still uploading)
                // must not 500 the panel — but it must not disappear from it either, so the reason rides back
                // in the response. Debug, not warn: while a dropped repo's .git lands this fires on every poll
                // and the client is already being told.
                services.logger.debug({ err: error, repo }, "git changes: repo unscannable");
                return {
                    repo,
                    conflicted: [],
                    staged: [],
                    unstaged: [],
                    error: gitFailureReason(error, "git could not read this repo"),
                };
            }
        });

    // The identity of every agent named by a scanned set, resolved against the FULL registry — the client's
    // roster holds only live agents, and an archived one's landed lines are still sitting in the tree (see
    // OriginAgentSchema). Ids only ever come from `origins`, so a repo with no attribution adds nothing. Shared
    // with the commit route, whose one-repo answer has to name its agents on the same terms the scan did.
    const identifyOrigins = (repos: readonly RepoChanges[]): Record<string, OriginAgent> =>
        services.agentOrigins.identify(new Set(repos.flatMap((scanned) => Object.values(scanned.origins ?? {}).flat())));

    const scanAll = async (): Promise<GitChanges> => {
        const repoIds = await services.perf.track("git.discover", {}, () => discoverRepos(services.workspace.root));
        // A Changes review right after a clone must not sweep the new repo's files into the root scope —
        // converge the root excludes on the repo set we're about to scan.
        await syncRootExcludes(services.config.historyRoot, repoIds);
        const candidates = [
            { repo: "root", dir: services.workspace.root },
            ...repoIds.map((id) => ({ repo: id, dir: join(services.workspace.root, id) })),
        ];
        scannedRepos = candidates.length;
        // Each candidate is its own repo dir (own .git, no shared index.lock), so the scans run
        // concurrently — the panel waits for the slowest repo, not the sum of all of them.
        const scanned = await Promise.all(candidates.map((candidate) => scanRepo(candidate.repo, candidate.dir)));
        const repos = scanned.filter((repo) => repo !== undefined);
        const originAgents = identifyOrigins(repos);
        return { repos, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
    };

    // The panel refetches on every workspace-change batch — several times a second while a drop or a build lands,
    // from every connected browser — and each scan is a full discoverRepos walk plus a `git status` per repo.
    // Collapse them: callers arriving while a scan runs share it, and its result is reused for COALESCE_MS after it
    // settles, so a burst costs one scan instead of one per observer per batch. `reusableUntil` is 0 for the whole
    // time a scan is in flight, which is what makes the sharing (not just the caching) work.
    /* How many callers this in-flight scan has been handed to, and how many repos it walked. Both are only
     * final once the scan settles, so this is timed by hand rather than through `perf.track` — that helper
     * evaluates its fields up front, which would have frozen the share count at 1 and reported the exact
     * opposite of what happened.
     *
     * The ratio is the point. A 3s review shared by six observers and a 3s review one browser asked for alone
     * are the same line in every other log, and they need opposite fixes: make the scan cheaper, or make the
     * client stop asking. */
    let shared = 0;
    const coalescedScan = (): Promise<GitChanges> => {
        if (scan !== undefined && (reusableUntil === 0 || Date.now() < reusableUntil)) {
            shared += 1;
            return scan;
        }
        reusableUntil = 0;
        shared = 1;
        const from = process.hrtime.bigint();
        const elapsed = (): number => Number(process.hrtime.bigint() - from) / 1e6;
        scan = scanAll().then(
            (result) => {
                services.perf.record("git.scan", elapsed(), { repos: scannedRepos, changed: result.repos.length, coalesced: shared });
                reusableUntil = Date.now() + COALESCE_MS;
                return result;
            },
            (error: unknown) => {
                services.perf.record("git.scan", elapsed(), { repos: scannedRepos, coalesced: shared }, true);
                // A whole-scan failure is never worth serving to the next caller — drop it so they rescan.
                scan = undefined;
                throw error;
            },
        );
        return scan;
    };

    return {
        /* The review set, plus what is happening to it right now. `committing` is read AFTER the scan settles,
         * never inside it: the scan is shared and memoized for half a second, and a commit that started or
         * finished inside that window has to reach the browser on this response rather than the next one. */
        changes: i.changes.handler(async () => {
            const scanned = await coalescedScan();
            return { ...scanned, ...(committing.size > 0 ? { committing: [...committing] } : {}) };
        }),
        /* Drafts the message for the commit the panel is about to make, on the sandbox's quick model. Reads
         * only — it spends a model call and touches neither the index nor the worktree, which is also why it
         * takes no repo lock: a concurrent land can change what the diff says, and the worst outcome is a
         * subject the user reads before clicking Commit.
         *
         * Every repo is described in ONE prompt rather than one call per repo, because the panel makes one
         * commit per repo sharing a single message: drafting per repo would produce N messages to pick between,
         * for N times the cost, and none of them would describe the change as a whole.
         *
         * An empty draft is an error, not an empty input: the model answering with nothing is a failure the
         * user should see said out loud, rather than a sparkle click that appears to do nothing at all. */
        commitMessage: i.commitMessage.handler(async ({ input, signal }) => {
            const diffs = await Promise.all(
                input.repos.map(async (target) =>
                    services.git.collectRepoDiff(target.repo, await repoDir(target.repo), {
                        ...(input.all === true ? { all: true } : {}),
                        ...(target.paths === undefined ? {} : { paths: target.paths }),
                    }),
                ),
            );
            const { text, choice, skipped } = await askQuickModel(
                services,
                commitMessagePrompt(diffs, input.intent),
                signal ?? new AbortController().signal,
            );
            const message = cleanCommitSubject(text);
            if (message === "") {
                throw new ORPCError("BAD_GATEWAY", { message: `${choice.model} returned an empty commit message — try again.` });
            }
            // Whatever the chain stepped over on the way here travels with the answer: the panel names the model
            // that wrote the line, and a user whose first choice was skipped should be told rather than left to
            // notice that the name changed.
            return {
                message,
                provider: choice.provider,
                model: choice.model,
                skipped: skipped.map((refusal) => ({ model: refusal.choice.model, reason: refusal.reason })),
            };
        }),
        // One row's own diff. The side is the row's side, not a convenience: for a partially staged file
        // HEAD↔worktree matches neither list, so opening it from either row would show a diff the panel never
        // claimed. The agents review keeps its own ref-vs-worktree route — a worktree has no index to split.
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            guardRepoPath(dir, input.path);
            if (input.side === "staged") {
                return services.git.stagedFileDiff(dir, input.path);
            }
            // An unmerged path is diffed against HEAD, not the index — it has no stage 0 to compare with.
            return input.side === "conflicted" ? services.git.conflictedFileDiff(dir, input.path) : services.git.unstagedFileDiff(dir, input.path);
        }),
        // The git-history graph: every workspace repo (for the tree affordance + the graph's switcher), one
        // repo's commit log, and lazy per-commit detail. "root" is implicit for the switcher; discoverRepos
        // returns only the nested repos (the same set the Changes panel and history scopes use).
        repos: i.repos.handler(async () => ({ repos: await discoverRepos(services.workspace.root) })),
        log: i.log.handler(async ({ input }) => {
            // 300 is the page size a caller gets if it asks for none — big enough that a small repo arrives whole
            // on the first request, small enough that a large one does not pay for what nobody scrolls to.
            const { branch, commits, hasMore } = await services.git.commitLog(await repoDir(input.repo), input.limit ?? 300, input.skip ?? 0);
            return { repo: input.repo, ...(branch !== undefined ? { branch } : {}), commits, hasMore };
        }),
        commitDiff: i.commitDiff.handler(async ({ input }) => ({ files: await services.git.commitChanges(await repoDir(input.repo), input.sha) })),
        commitFileDiff: i.commitFileDiff.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            guardRepoPath(dir, input.path);
            return services.git.commitFileDiff(dir, input.sha, input.path);
        }),
        // Write actions from the commit context menu (VSCode "Git Graph" parity). Branch/tag are
        // non-destructive (git rejects a duplicate name — that error propagates). Checkout/reset and every
        // sequence op (cherry-pick/revert/drop/merge/rebase) are bracketed by an auto-checkpoint via `guarded`
        // / an inline snapshot, so even a history rewrite or a hard reset stays reversible from Checkpoints.
        /* What the worktree is halted in the middle of, if anything. A plain read, and deliberately outside
         * `onRepo`'s lock: a surface asks this to EXPLAIN a repo that is stuck, and making that explanation
         * queue behind whatever is holding the lock is how a stuck repo becomes a stuck panel. */
        operation: i.operation.handler(async ({ input }) => {
            const operation = await services.git.operationInProgress(await repoDir(input.repo));
            return { repo: input.repo, ...(operation !== undefined ? { operation } : {}) };
        }),
        /* The way out. Checkpointed first like every other destructive verb — an abort throws away the
         * conflict resolution done so far, which is real work the user may not have meant to lose. Answers
         * `ok: false` rather than throwing when nothing is in progress: two people looking at the same repo is
         * ordinary, and the second Abort landing on a clean worktree is not an error worth a stack trace. */
        abort: i.abort.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                const operation = await services.git.operationInProgress(dir);
                if (operation === undefined) {
                    return { ok: false, reason: "nothing in progress" };
                }
                await services.history.snapshot("user", `before aborting ${operation} in ${input.repo}`);
                await services.git.abortOperation(dir, operation);
                invalidateScan();
                services.history.notifyUserWrite();
                return { ok: true };
            }),
        ),
        // Read-only, and outside the lock for the same reason `operation` is: this is what a toolbar renders to
        // decide whether to offer an Undo at all, and it must not queue behind a running git write.
        undoable: i.undoable.handler(async ({ input }) => {
            const action = await services.git.undoableAction(await repoDir(input.repo));
            return { repo: input.repo, ...(action !== undefined ? { action } : {}) };
        }),
        /* The undo itself. Checkpointed first like every other destructive verb — a hard reset throws away the
         * worktree, and even a soft one moves the branch — so this stays reversible from the Checkpoints
         * timeline in turn. Refusals (nothing to undo, the repo moved since) come back as `ok: false`: both are
         * ordinary outcomes of two people working in one workspace, not faults. */
        undo: i.undo.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", `before undo in ${input.repo}`);
                const result = await services.git.undoLastAction(dir, input.previousSha, input.discardChanges === true);
                if (!result.ok) {
                    return { ok: false, reason: result.reason };
                }
                invalidateScan();
                services.history.notifyUserWrite();
                return { ok: true };
            }),
        ),
        // Reads: the entry list, and one entry's files against the commit it was taken on.
        stashes: i.stashes.handler(async ({ input }) => ({ repo: input.repo, stashes: await services.git.stashList(await repoDir(input.repo)) })),
        stashDiff: i.stashDiff.handler(async ({ input }) => ({ files: await services.git.stashChanges(await repoDir(input.repo), input.ref) })),
        /* Setting work aside moves the worktree, so it takes the repo lock like every other worktree write, and
         * records the result on the timeline. "Nothing to stash" comes back as a value rather than a throw — it
         * is what an already-clean tree answers, not a fault. */
        stashPush: i.stashPush.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                const result = await services.git.stashPush(dir, {
                    ...(input.message !== undefined ? { message: input.message } : {}),
                    ...(input.includeUntracked !== undefined ? { includeUntracked: input.includeUntracked } : {}),
                });
                if (result.ok) {
                    invalidateScan();
                    services.history.notifyUserWrite();
                }
                return result;
            }),
        ),
        // Putting one back can conflict, which git reports by leaving markers in the tree and (for pop) keeping
        // the entry — the work is never lost, so this is `ok: false`, not an error.
        stashApply: i.stashApply.handler(({ input }) =>
            guarded(input.repo, `before stash ${input.pop === true ? "pop" : "apply"} in ${input.repo}`, (dir) =>
                services.git.stashApply(dir, input.ref, input.pop === true),
            ),
        ),
        /* The only unrecoverable verb in the stash set: dropping an entry makes its commit unreachable, and
         * unlike a reset there is no ref left anywhere pointing at it. So it checkpoints first — which is what
         * makes it reversible from the Checkpoints timeline even though git cannot walk it back. */
        stashDrop: i.stashDrop.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", `before dropping ${input.ref} in ${input.repo}`);
                await services.git.stashDrop(dir, input.ref);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        /* Deleting a tag is a ref op, so it needs no checkpoint — but it CAN reach a remote, which nothing else
         * in this router does on the user's behalf without saying so. The remote half is opt-in per call and
         * best-effort inside the service; the local half is what the caller is told about. */
        deleteTag: i.deleteTag.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.git.deleteTag(dir, input.name, input.remote);
                return { ok: true } as const;
            }),
        ),
        // Publishing one tag. A GitActionResult rather than Ok: a rejected push (no permission, a tag that moved
        // on the remote) is an ordinary outcome the pill reports, not a 500.
        pushTag: i.pushTag.handler(({ input }) => onRepo(input.repo, (dir) => services.git.pushTag(dir, input.name, input.remote))),
        createBranch: i.createBranch.handler(async ({ input }) => {
            await services.git.createBranchAt(await repoDir(input.repo), input.name, input.sha);
            return { ok: true } as const;
        }),
        createTag: i.createTag.handler(async ({ input }) => {
            await services.git.createTagAt(await repoDir(input.repo), input.name, input.sha);
            return { ok: true } as const;
        }),
        checkout: i.checkout.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", `before checkout ${input.ref.slice(0, 12)}`);
                await services.git.checkoutRef(dir, input.ref);
                invalidateScan();
                services.history.notifyUserWrite();
                return { ok: true } as const;
            }),
        ),
        reset: i.reset.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", `before reset --${input.mode}`);
                await services.git.resetTo(dir, input.sha, input.mode);
                invalidateScan();
                services.history.notifyUserWrite();
                return { ok: true } as const;
            }),
        ),
        cherryPick: i.cherryPick.handler(({ input }) =>
            guarded(input.repo, `before cherry-pick ${input.sha.slice(0, 8)}`, (dir) => services.git.cherryPick(dir, input.sha, AGENT_GIT_AUTHOR)),
        ),
        revert: i.revert.handler(({ input }) =>
            guarded(input.repo, `before revert ${input.sha.slice(0, 8)}`, (dir) => services.git.revertCommit(dir, input.sha, AGENT_GIT_AUTHOR)),
        ),
        drop: i.drop.handler(({ input }) =>
            guarded(input.repo, `before drop ${input.sha.slice(0, 8)}`, (dir) => services.git.dropCommit(dir, input.sha, AGENT_GIT_AUTHOR)),
        ),
        merge: i.merge.handler(({ input }) =>
            guarded(input.repo, `before merge ${input.sha.slice(0, 8)}`, (dir) => services.git.mergeCommit(dir, input.sha, AGENT_GIT_AUTHOR)),
        ),
        rebase: i.rebase.handler(({ input }) =>
            guarded(input.repo, `before rebase ${input.sha.slice(0, 8)}`, (dir) => services.git.rebaseOnto(dir, input.sha, AGENT_GIT_AUTHOR)),
        ),
        status: i.status.handler(async ({ input }) => services.git.status(await repoDir(input.repo))),
        // Two commit shapes, both whole-repo (see CommitSchema): `all` stages every change first, otherwise the
        // index is recorded as it stands. No path-scoped variant — staging is how the user chooses.
        // Marked as committing from the moment the request arrives, OUTSIDE the lock rather than inside it: a
        // commit queued behind an agent's land has not started and is absolutely running as far as the user is
        // concerned, and that wait is the longest part of the slow case the panel most needs to narrate.
        commit: i.commit.handler(({ input }) =>
            whileCommitting(input.repo, () =>
                onRepo(input.repo, async (dir) => {
                    // git's own refusals are the useful ones here — "Committing is not possible because you have
                    // unmerged files", a pre-commit hook's failure, a missing identity. Carried as a CONFLICT with
                    // git's verdict line so the panel prints the reason; a bare throw would reach the browser as an
                    // opaque 500 and the user would read "Commit failed." with nothing to act on.
                    try {
                        // Nothing was staged, and the caller has said what to stage — so this commit stages first,
                        // INSIDE the repo lock rather than as a second request the panel makes: a land slipping
                        // between an add and a commit is exactly the half-a-patch race the lock exists to close.
                        // A whole-index commit follows, never a partial one (see CommitSchema).
                        if (input.paths !== undefined) {
                            await services.git.stagePaths(dir, input.paths);
                        }
                        const committed =
                            input.all === true
                                ? await services.git.commitAll(dir, input.message, AGENT_GIT_AUTHOR)
                                : await services.git.commitIndex(dir, input.message, AGENT_GIT_AUTHOR);
                        invalidateScan();
                        /* AND WHAT THE REPO LOOKS LIKE NOW, still inside the lock — the panel's replacement for
                         * the workspace-wide rescan it used to fire the moment this returned. One repo's rows
                         * re-read here beats six repos' re-read there, and the rows the user just committed
                         * disappear with the response rather than one contended scan later (see
                         * CommitResultSchema).
                         *
                         * Inside the lock is what makes it worth carrying at all: a land landing between the
                         * commit and the read would make this answer describe a tree the commit did not produce,
                         * which is a worse lie than the staleness it replaces. `scanRepo` takes no lock of its
                         * own — it is all reads — so this is not the reentrancy `onRepo` forbids. */
                        const changes = await scanRepo(input.repo, dir);
                        if (changes === undefined) {
                            // Nothing left for the panel to show in this repo — the scan's own inclusion rule, so
                            // the client drops the row exactly as the next scan would have.
                            return { committed };
                        }
                        const originAgents = identifyOrigins([changes]);
                        return { committed, changes, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
                    } catch (error) {
                        // The index may have moved even on a failure (`commit -a` stages before it commits), so
                        // the panel's view is stale either way.
                        invalidateScan();
                        throw new ORPCError("CONFLICT", { message: gitFailureReason(error, "git refused the commit") });
                    }
                }),
            ),
        ),
        // Index-only moves: the worktree is untouched, so no checkpoint and no history notification — only the
        // panel's view of what's staged changes.
        stage: i.stage.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.git.stagePaths(dir, input.paths);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        unstage: i.unstage.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.git.unstagePaths(dir, input.paths);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        branches: i.branches.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            // Two independent read-only for-each-ref sweeps — one round trip for both, since the switcher draws
            // them paired and a half-populated first render would be worse than a marginally later one.
            const [branches, remotes] = await Promise.all([services.git.listBranches(dir), services.git.listRemoteBranches(dir)]);
            return { branches, remotes };
        }),
        // Creating a branch is non-destructive UNLESS it also checks out — that moves HEAD and the worktree,
        // so it takes the same pre-action checkpoint every HEAD-mover does.
        createBranchAt: i.createBranchAt.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            if (input.checkout === true) {
                await services.history.snapshot("user", `before new branch ${input.name}`);
            }
            await services.git.createBranch(dir, input.name, input.start, input.checkout === true);
            if (input.checkout === true) {
                invalidateScan();
                services.history.notifyUserWrite();
            }
            return { ok: true } as const;
        }),
        // Deleting a branch touches no file. git refuses an unmerged branch without `force`; that error
        // propagates so the UI can offer the deliberate retry rather than the daemon deciding for the user.
        deleteBranch: i.deleteBranch.handler(async ({ input }) => {
            await services.git.deleteBranch(await repoDir(input.repo), input.name, input.force === true);
            return { ok: true } as const;
        }),
        // Remote sync. Each returns a GitActionResult, so "no remote" / "no upstream" / "won't fast-forward"
        // arrive as reasons the panel renders instead of 500s. Only pull can change the worktree, so only pull
        // checkpoints and refreshes.
        remote: i.remote.handler(async ({ input }) => services.git.remoteState(await repoDir(input.repo))),
        fetch: i.fetch.handler(async ({ input }) => {
            const result = await services.git.fetchRemote(await repoDir(input.repo));
            if (result.ok) {
                // Fetch moves no file, but it does move ahead/behind — which the Changes response carries.
                invalidateScan();
            }
            return result;
        }),
        pull: i.pull.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", "before pull");
                const result = await services.git.pullRemote(dir);
                if (result.ok) {
                    invalidateScan();
                    services.history.notifyUserWrite();
                }
                return result;
            }),
        ),
        discard: i.discard.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                // The checkpoint goes BEFORE the destruction. Discard is the one verb in this router git itself
                // cannot walk back — untracked files are deleted outright, and a tracked file's worktree state
                // was never in the object store to reflog back to — so the snapshot that makes it recoverable
                // has to record the tree that is about to go. `notifyUserWrite` below records the RESULT, which
                // is the timeline's other half and no safety net at all; the sequence verbs get this via
                // `guarded`, and discard sat outside it purely because it reports no ActionResult.
                await services.history.snapshot("user", `before discard in ${input.repo}`);
                await services.git.discardPaths(dir, input.paths);
                invalidateScan();
                // The worktree changed under the user's feet — record it on the timeline like any user write.
                services.history.notifyUserWrite();
                return { ok: true } as const;
            }),
        ),
        push: i.push.handler(async ({ input }) => {
            const result = await services.git.pushBranch(await repoDir(input.repo), input.branch !== undefined ? { branch: input.branch } : {});
            if (result.ok) {
                // Push changes nothing locally except ahead/behind, which rides the Changes response.
                invalidateScan();
            }
            return result;
        }),
        files: i.files.handler(async ({ input }) => ({ files: await services.git.listFiles(await repoDir(input.repo)) })),
        readFile: i.readFile.handler(async ({ input }) => {
            const content = await services.files.read(guardRepoPath(await repoDir(input.repo), input.path));
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        writeFile: i.writeFile.handler(async ({ input }) => {
            await services.files.write(guardRepoPath(await repoDir(input.repo), input.path), input.content);
            invalidateScan();
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
    };
};
