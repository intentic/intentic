import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathExists } from "../path-exists.js";
import {
    gitContract,
    type GitChange,
    type GitChanges,
    type GitDiffSide,
    type GitScope,
    type GitTarget,
    type OriginAgent,
    type RepoChanges,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { isValidRepoId } from "../workspace/layout/repo-discovery.js";
import { currentRepos } from "../workspace/watch/repo-watch.js";
import { isControlPlanePath, isReviewableStatePath, resolveWithin } from "../workspace/files/workspace-files-paths.js";
import type { ActionResult } from "./changes/changes-commits.js";
import { DISCARDABLE_SIDES, isWholeRepo, scopedPaths, STAGEABLE_SIDES, UNSTAGEABLE_SIDES } from "./changes/changes-target.js";
import { conflictedSides, stagedSides, unstagedSides, withCodeCounts } from "./changes/code-counts.js";
import { AGENT_GIT_AUTHOR, gitFailureReason } from "./git.js";
import { parsableMessage } from "./ops/commit-message.js";
import { createPushRuns } from "./ops/push-run.js";

// How long a scan result is reused: absorbs a refetch burst, short enough a save still shows live.
const COALESCE_MS = 500;

// Cap on changes shipped per repo per scan; the remainder is a count (`truncated`), not enumerated rows.
export const MAX_REPO_CHANGES = 500;

// Splits MAX_REPO_CHANGES across staged/unstaged (conflicts always pass through); `truncated` per side is what fell off
// each (0/0 = shipped whole).
export const capRepoChanges = (
    conflicted: GitChange[],
    staged: GitChange[],
    unstaged: GitChange[],
): { conflicted: GitChange[]; staged: GitChange[]; unstaged: GitChange[]; truncated: { staged: number; unstaged: number } } => {
    const stagedBudget = Math.max(0, MAX_REPO_CHANGES - conflicted.length);
    const unstagedBudget = Math.max(0, stagedBudget - staged.length);
    return {
        conflicted,
        staged: staged.length > stagedBudget ? staged.slice(0, stagedBudget) : staged,
        unstaged: unstaged.length > unstagedBudget ? unstaged.slice(0, unstagedBudget) : unstaged,
        truncated: {
            staged: Math.max(0, staged.length - stagedBudget),
            unstaged: Math.max(0, unstaged.length - unstagedBudget),
        },
    };
};

// Fairness bound on concurrent repo scans, not a throughput cap; sized from the machine's own core count.
const SCAN_CONCURRENCY = Math.max(2, Math.min(8, availableParallelism()));

// `Promise.all` with a ceiling; workers pull from one shared cursor so a slow item delays only itself, and results keep
// input order.
const mapBounded = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
    const results = Array.from({ length: items.length }) as R[];
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await run(items[index] as T);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
};

// Per-repo git ops over `root` (the /work repo) and every discovered repo; unknown repo is NOT_FOUND, an escaping path
// BAD_REQUEST, missing file NOT_FOUND.
export const createGitRoutes = (services: Services) => {
    const i = implement(gitContract).$context<OrpcContext>();
    // Rewrites the --separate-git-dir pointer if deleted, mirroring history's healGitPointer convention
    // (/history/gits/<name>).
    const healPointer = async (repo: string, dir: string): Promise<void> => {
        if (await pathExists(join(dir, ".git"))) {
            return;
        }
        const gitDir = repoGitDir(services.config.historyRoot, repo);
        if (await pathExists(gitDir)) {
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
            if (await pathExists(dir)) {
                await healPointer(repo, dir);
                return dir;
            }
        }
        throw new ORPCError("NOT_FOUND", { message: "unknown repo" });
    };
    // Bars a path from leaving the repo dir or reaching the control plane (for `root`, that dir is the workspace);
    // control-plane hits 404, matching the workspace routes.
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
    // Same two floors as guardRepoPath, plus a carve-out for a tracked, `versioned` control-plane entry
    // (capabilities.json) so its diff isn't 404'd; the write path still refuses it.
    const guardDiffPath = (dir: string, path: string): string => {
        const target = resolveWithin(dir, path);
        if (target === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
        }
        if (isControlPlanePath(services.workspace.root, target) && !isReviewableStatePath(services.workspace.root, target)) {
            throw new ORPCError("NOT_FOUND", { message: "not found" });
        }
        return target;
    };
    // Serializes user writes here with an agent's land (agents/land.ts) on the same repo lock (worktrees.withRepoLock);
    // never nest calls, the chain is a queue, not reentrant. Read-only routes stay outside it.
    const onRepo = <T>(repo: string, task: (dir: string) => Promise<T>): Promise<T> =>
        services.agentWorktrees.withRepoLock(repo, async () => task(await repoDir(repo)));

    // Resolves a scope from a live `git status`, not the truncated review, so it acts past MAX_REPO_CHANGES. Origin
    // failures here throw (unlike the scan): a silent miss would quietly narrow a write.
    const scopeToPaths = async (repo: string, dir: string, scope: GitScope, sides: readonly GitDiffSide[]): Promise<readonly string[]> => {
        const { head, conflicted, staged, unstaged } = await services.git.changedFiles(dir);
        const origins = scope.origin === undefined ? {} : await services.agentOrigins.forRepo(repo, dir, head);
        return scopedPaths({ conflicted, staged, unstaged }, sides, scope, origins);
    };

    // Stage-all/discard-all use single-command spellings that never enumerate paths; unstage has none (a bare `reset`
    // also clears MERGE_HEAD) so it always resolves to paths. Callers must hold the repo lock.
    const stageTarget = async (repo: string, dir: string, target: GitTarget): Promise<void> => {
        if (target.paths !== undefined) {
            await services.git.stagePaths(dir, target.paths);
            return;
        }
        const scope = target.scope ?? {};
        if (isWholeRepo(scope)) {
            await services.git.stageAll(dir);
            return;
        }
        await services.git.stagePaths(dir, await scopeToPaths(repo, dir, scope, STAGEABLE_SIDES));
    };
    const unstageTarget = async (repo: string, dir: string, target: GitTarget): Promise<void> => {
        await services.git.unstagePaths(
            dir,
            target.paths ?? (await scopeToPaths(repo, dir, target.scope ?? {}, UNSTAGEABLE_SIDES)),
        );
    };
    const discardTarget = async (repo: string, dir: string, target: GitTarget): Promise<void> => {
        if (target.paths !== undefined) {
            await services.git.discardPaths(dir, target.paths);
            return;
        }
        const scope = target.scope ?? {};
        // `undefined` means the whole repo: `reset --hard` + `clean -fd`, which also removes now-empty dirs.
        await services.git.discardPaths(dir, isWholeRepo(scope) ? undefined : await scopeToPaths(repo, dir, scope, DISCARDABLE_SIDES));
    };

    // Repos mid-commit; held here (not per-tab) so a reload or second tab agrees; empty again on restart.
    const committing = new Set<string>();
    const whileCommitting = async <T>(repo: string, run: () => Promise<T>): Promise<T> => {
        committing.add(repo);
        try {
            return await run();
        } finally {
            committing.delete(repo);
        }
    };

    // Memoized scan (see coalescedScan); every mutation drops it so a refetch isn't answered by a stale one.
    let scan: Promise<GitChanges> | undefined;
    let reusableUntil = 0;
    const invalidateScan = (): void => {
        scan = undefined;
        reusableUntil = 0;
    };
    // One push-run set per router (one per daemon); nothing else reaches it, so it needs no shutdown hook.
    const pushRuns = createPushRuns(services, invalidateScan);
    // A sequence/HEAD-moving op: checkpoints the tree first (so even a rewrite stays reversible), runs it, and records
    // the result on a clean apply.
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
    // Repo dirs the last scan walked; the real driver behind scan latency.
    let scannedRepos = 0;
    // One repo's review row, used both by the workspace scan and by the commit route re-reading the repo it just wrote
    // (inside its own lock, no rescan needed). `undefined` means the inclusion rule found nothing to show.
    const scanRepo = async (repo: string, dir: string): Promise<RepoChanges | undefined> =>
        // Tracked per repo: repos run concurrently, so overall scan duration alone can't say which one is slow.
        services.perf.track("git.scan.repo", { repo }, async (): Promise<RepoChanges | undefined> => {
            try {
                await healPointer(repo, dir);
                // Status runs first since it's the long pole and already yields branch/HEAD sha, saving a spawn for
                // remoteState and attribution; the halted-op check spawns nothing (stat only) and runs alongside it.
                const [{ branch, head, conflicted, staged, unstaged, blobs }, operation] = await Promise.all([
                    services.git.changedFiles(dir),
                    // Turns "these files are conflicted" into "a rebase stopped here".
                    services.git.operationInProgress(dir),
                ]);
                // `remote` feeds the sync bar; `landed` is which agent touched each path, independently of it.
                const [remote, landed] = await Promise.all([
                    services.git.remoteState(dir, { branch }),
                    // Attribution only decorates rows; a failure here degrades to none, not a whole-repo error.
                    services.agentOrigins.forRepo(repo, dir, head).catch((error: unknown) => {
                        services.logger.debug({ err: error, repo }, "git changes: origins unavailable");
                        return {};
                    }),
                ]);
                // A clean repo still appears if there's remote work to do: ahead/behind upstream, or publishable
                // (remote but no upstream yet); the sync controls must be able to see it.
                const publishable = branch !== undefined && remote.remote !== undefined && remote.upstream === undefined;
                if (
                    conflicted.length > 0 ||
                    staged.length > 0 ||
                    unstaged.length > 0 ||
                    remote.ahead > 0 ||
                    remote.behind > 0 ||
                    publishable ||
                    // A halted, clean-tree repo is rare but real; it's the only place Abort lives, so it must still
                    // show.
                    operation !== undefined
                ) {
                    const capped = capRepoChanges(conflicted, staged, unstaged);
                    // Code-only +/- per row (code-counts.ts), computed here so a badge never moves after it's drawn.
                    // Done after the cap (uncounted rows aren't shipped) and per side (a partial file has two diffs).
                    const [countedConflicted, countedStaged, countedUnstaged] = await Promise.all([
                        withCodeCounts(dir, capped.conflicted, conflictedSides(dir, head)),
                        withCodeCounts(dir, capped.staged, stagedSides(head, blobs)),
                        withCodeCounts(dir, capped.unstaged, unstagedSides(dir, blobs)),
                    ]);
                    // Limited to paths this scan actually reports (capped lists): an agent's landed delta outlives the
                    // review, so the full set would attribute files no longer changed.
                    const dirty = new Set(
                        [...capped.conflicted, ...capped.staged, ...capped.unstaged].flatMap((change) =>
                            change.from === undefined ? [change.path] : [change.path, change.from],
                        ),
                    );
                    const origins = Object.fromEntries(Object.entries(landed).filter(([path]) => dirty.has(path)));
                    return {
                        repo,
                        ...(branch !== undefined ? { branch } : {}),
                        conflicted: countedConflicted,
                        ...(operation !== undefined ? { operation } : {}),
                        staged: countedStaged,
                        unstaged: countedUnstaged,
                        ...(capped.truncated.staged + capped.truncated.unstaged > 0 ? { truncated: capped.truncated } : {}),
                        remote,
                        ...(Object.keys(origins).length > 0 ? { origins } : {}),
                    };
                }
                return undefined;
            } catch (error) {
                // A broken repo must not 500 the panel or vanish from it; the reason rides back in the response. Logged
                // at debug, since the client is already told and this can fire every poll.
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

    // Resolves agent identities against the full registry, not just live agents (an archived one's landed lines still
    // sit in the tree). Shared with the commit route so both answer on the same terms.
    const identifyOrigins = (repos: readonly RepoChanges[]): Record<string, OriginAgent> =>
        services.agentOrigins.identify(new Set(repos.flatMap((scanned) => Object.values(scanned.origins ?? {}).flat())));

    const scanAll = async (): Promise<GitChanges> => {
        const repoIds = await services.perf.track("git.discover", {}, () => currentRepos(services.workspace.root));
        // Converges root excludes on the repo set first, so a fresh clone isn't swept into the root scope.
        await syncRootExcludes(services.config.historyRoot, repoIds);
        const candidates = [
            { repo: "root", dir: services.workspace.root },
            ...repoIds.map((id) => ({ repo: id, dir: join(services.workspace.root, id) })),
        ];
        scannedRepos = candidates.length;
        // Each candidate has its own .git, so scans run concurrently, up to SCAN_CONCURRENCY at once.
        const scanned = await mapBounded(candidates, SCAN_CONCURRENCY, (candidate) => scanRepo(candidate.repo, candidate.dir));
        const repos = scanned.filter((repo) => repo !== undefined);
        const originAgents = identifyOrigins(repos);
        return { repos, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
    };

    // Refetches arrive in bursts across browsers; callers mid-scan share the in-flight promise, and the result is
    // reused for COALESCE_MS after — `reusableUntil` at 0 is what marks a scan still in flight.
    // Callers sharing this in-flight scan, timed by hand (not `perf.track`, which evaluates fields up front and would
    // freeze this at 1); the ratio distinguishes a shared slow scan from a lone one.
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
                // A failed scan is dropped, not cached, so the next caller retries fresh.
                scan = undefined;
                throw error;
            },
        );
        return scan;
    };

    return {
        // Review set plus `committing`, read after the scan settles (not merged into the memoized result), so a commit
        // that starts or ends during the coalesce window still shows on this response.
        changes: i.changes.handler(async () => {
            const scanned = await coalescedScan();
            return { ...scanned, ...(committing.size > 0 ? { committing: [...committing] } : {}) };
        }),
        // `side` is the clicked row's own comparison, not a convenience: for a partially staged file, HEAD↔worktree
        // matches neither list. Agent reviews use their own ref-vs-worktree route (no index to split).
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            guardDiffPath(dir, input.path);
            if (input.side === "staged") {
                return services.git.stagedFileDiff(dir, input.path);
            }
            // An unmerged path diffs against HEAD, not the index: it has no stage 0.
            return input.side === "conflicted" ? services.git.conflictedFileDiff(dir, input.path) : services.git.unstagedFileDiff(dir, input.path);
        }),
        // Repo set for the tree affordance and the graph's switcher; `root` is implicit, so this holds only the nested
        // repos (same set as the Changes panel and history scopes).
        repos: i.repos.handler(async () => ({ repos: await currentRepos(services.workspace.root) })),
        // Excludes `root`: it's the sandbox's own shadow repo, not a publishable project. A repo whose remote can't be
        // read is skipped, not reported as remote-less.
        remoteRepos: i.remoteRepos.handler(async () => {
            const ids = await currentRepos(services.workspace.root);
            const entries = await Promise.all(
                ids.map(async (repo) => {
                    const found = await services.git.remoteProjectOf(join(services.workspace.root, repo)).catch(() => undefined);
                    return found === undefined ? undefined : { repo, host: found.host, project: found.project };
                }),
            );
            return { repos: entries.filter((entry): entry is { repo: string; host: string; project: string } => entry !== undefined) };
        }),
        log: i.log.handler(async ({ input }) => {
            // Default page size when none is given: a small repo arrives whole, a large one isn't fully paid for.
            const { branch, commits, hasMore } = await services.git.commitLog(await repoDir(input.repo), input.limit ?? 300, input.skip ?? 0);
            return { repo: input.repo, ...(branch !== undefined ? { branch } : {}), commits, hasMore };
        }),
        commitDiff: i.commitDiff.handler(async ({ input }) => ({ files: await services.git.commitChanges(await repoDir(input.repo), input.sha) })),
        commitFileDiff: i.commitFileDiff.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            guardDiffPath(dir, input.path);
            return services.git.commitFileDiff(dir, input.sha, input.path);
        }),
        // Commit-context-menu write actions. Branch/tag are non-destructive (a duplicate name's error just propagates);
        // checkout/reset/sequence ops auto-checkpoint via `guarded` or an inline snapshot.
        // What the worktree is halted in, if anything; a plain read kept outside `onRepo`'s lock, so explaining a stuck
        // repo never queues behind what's stuck it.
        operation: i.operation.handler(async ({ input }) => {
            const operation = await services.git.operationInProgress(await repoDir(input.repo));
            return { repo: input.repo, ...(operation !== undefined ? { operation } : {}) };
        }),
        // Checkpoints first since an abort throws away real conflict-resolution work; returns `ok: false` (not a throw)
        // when nothing is in progress, since a second Abort is ordinary.
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
        // Read-only and outside the lock, like `operation`: a toolbar uses this to decide whether to offer Undo.
        undoable: i.undoable.handler(async ({ input }) => {
            const action = await services.git.undoableAction(await repoDir(input.repo));
            return { repo: input.repo, ...(action !== undefined ? { action } : {}) };
        }),
        // Checkpoints first: a hard undo discards the worktree, a soft one still moves the branch. Refusals (nothing to
        // undo, repo moved) come back as `ok: false`, not a throw.
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
        // The stash list, and one entry's files diffed against the commit it was taken on.
        stashes: i.stashes.handler(async ({ input }) => ({ repo: input.repo, stashes: await services.git.stashList(await repoDir(input.repo)) })),
        stashDiff: i.stashDiff.handler(async ({ input }) => ({ files: await services.git.stashChanges(await repoDir(input.repo), input.ref) })),
        // Moves the worktree, so it takes the repo lock and records on the timeline; "nothing to stash" is a value, not
        // a throw.
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
        // A conflict leaves markers (pop keeps the entry too); nothing lost, so this is `ok: false`, not an error.
        stashApply: i.stashApply.handler(({ input }) =>
            guarded(input.repo, `before stash ${input.pop === true ? "pop" : "apply"} in ${input.repo}`, (dir) =>
                services.git.stashApply(dir, input.ref, input.pop === true),
            ),
        ),
        // The only unrecoverable stash verb: dropping leaves no ref pointing at the entry's commit, so this checkpoints
        // first to stay reversible from Checkpoints.
        stashDrop: i.stashDrop.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.history.snapshot("user", `before dropping ${input.ref} in ${input.repo}`);
                await services.git.stashDrop(dir, input.ref);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        // A ref op, so no checkpoint; the remote half is opt-in per call and best-effort, and only the local half is
        // what the caller is told about.
        deleteTag: i.deleteTag.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await services.git.deleteTag(dir, input.name, input.remote);
                return { ok: true } as const;
            }),
        ),
        // A GitActionResult, not Ok: a rejected push is a reported outcome, not a 500.
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
        // One commit shape: `stage` (whole repo, scope, or paths) decides what enters the index; there is no
        // path-scoped `commit --only`. `stage` runs inside the repo lock so a land can't slip in between.
        // Marked committing before the lock: queued behind a land still counts as running to the user.
        commit: i.commit.handler(({ input }) =>
            whileCommitting(input.repo, () =>
                onRepo(input.repo, async (dir) => {
                    // Carries git's own refusal text back as a CONFLICT, not an opaque 500 with nothing to act on.
                    try {
                        // Stages first, then always commits the whole index (never a partial commit); one spelling
                        // avoids a --no-verify path that would skip hooks inconsistently.
                        if (input.stage !== undefined) {
                            await stageTarget(input.repo, dir, input.stage);
                        }
                        // Repairs only spellings a conventional parser can't find a header in at all (`!` before the
                        // scope, no space after `:`); every other rule's verdict reaches the panel unchanged.
                        const committed = await services.git.commitIndex(dir, parsableMessage(input.message), AGENT_GIT_AUTHOR);
                        invalidateScan();
                        // Re-reads only the just-committed repo, inside the lock, instead of a full rescan: a land
                        // landing between commit and read would describe a tree the commit didn't make. `scanRepo`
                        // takes no lock, so this isn't reentrant.
                        const changes = await scanRepo(input.repo, dir);
                        if (changes === undefined) {
                            // Nothing left to show for this repo (the scan's own inclusion rule); the client drops the
                            // row.
                            return { committed };
                        }
                        const originAgents = identifyOrigins([changes]);
                        return { committed, changes, ...(Object.keys(originAgents).length > 0 ? { originAgents } : {}) };
                    } catch (error) {
                        // The index can move even on failure (staging happens before the commit), so the view is stale
                        // regardless.
                        invalidateScan();
                        throw new ORPCError("CONFLICT", { message: gitFailureReason(error, "git refused the commit") });
                    }
                }),
            ),
        ),
        // Index-only: no checkpoint or history notification, since the worktree is untouched. A target means the whole
        // side, not just the rows a response could fit.
        stage: i.stage.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await stageTarget(input.repo, dir, input);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        unstage: i.unstage.handler(({ input }) =>
            onRepo(input.repo, async (dir) => {
                await unstageTarget(input.repo, dir, input);
                invalidateScan();
                return { ok: true } as const;
            }),
        ),
        branches: i.branches.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            // Two independent read-only sweeps, fetched together since the switcher renders them as a pair.
            const [branches, remotes] = await Promise.all([services.git.listBranches(dir), services.git.listRemoteBranches(dir)]);
            return { branches, remotes };
        }),
        // Non-destructive unless it also checks out; checking out moves HEAD and the worktree, so it checkpoints first
        // like any HEAD-mover.
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
        // Touches no file; git's unmerged-branch refusal propagates so the UI can offer a forced retry.
        deleteBranch: i.deleteBranch.handler(async ({ input }) => {
            await services.git.deleteBranch(await repoDir(input.repo), input.name, input.force === true);
            return { ok: true } as const;
        }),
        // Each returns a GitActionResult, so "no remote"/"no upstream"/"won't fast-forward" render as reasons, not
        // 500s; only pull touches the worktree, so only pull checkpoints.
        remote: i.remote.handler(async ({ input }) => services.git.remoteState(await repoDir(input.repo))),
        fetch: i.fetch.handler(async ({ input }) => {
            const result = await services.git.fetchRemote(await repoDir(input.repo));
            if (result.ok) {
                // Fetch moves no file, but does move ahead/behind, which the Changes response carries.
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
                // Snapshot before discard: git can't walk this back (untracked deleted, no reflog for worktree state).
                await services.history.snapshot("user", `before discard in ${input.repo}`);
                await discardTarget(input.repo, dir, input);
                invalidateScan();
                // Worktree changed, so record it like any other user write.
                services.history.notifyUserWrite();
                return { ok: true } as const;
            }),
        ),
        // A push run (git/push-run.ts): started here, watched in its terminal, polled below. Not under the repo lock,
        // since it writes nothing in the worktree.
        push: i.push.handler(async ({ input }) => {
            await pushRuns.start(input.repo, await repoDir(input.repo), input.branch !== undefined ? { branch: input.branch } : {});
            return { ok: true as const };
        }),
        pushState: i.pushState.handler(({ input }) => pushRuns.state(input.repo)),
        // Cancelling a settled push is harmless: the kill just finds no pid to act on.
        pushCancel: i.pushCancel.handler(({ input }) => {
            pushRuns.cancel(input.repo);
            return { ok: true as const };
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
        // Write + single-path commit + push, under the repo lock and committing flag like the commit route (a land
        // mid-commit is the same race). Path is guarded before the lock, so a bad path never takes a queue slot.
        publishFile: i.publishFile.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            const target = guardRepoPath(dir, input.path);
            const result = await whileCommitting(input.repo, () =>
                onRepo(input.repo, () =>
                    services.git.publishFile(dir, { path: input.path, content: input.content, message: input.message }, (content) =>
                        services.files.write(target, content),
                    ),
                ),
            );
            if (result.wrote) {
                invalidateScan();
                services.history.notifyUserWrite();
            }
            return result;
        }),
    };
};
