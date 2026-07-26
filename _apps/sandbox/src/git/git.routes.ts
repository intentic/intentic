import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitContract, type RepoChanges } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { discoverRepos, isValidRepoId } from "../workspace/repo-discovery.js";
import { isControlPlanePath, resolveWithin } from "../workspace/workspace-files.js";
import type { ActionResult } from "./changes.js";
import { AGENT_GIT_AUTHOR, gitFailureReason } from "./git.js";

// How long one Changes scan's result stands in for the next caller's. Long enough to swallow the browser's
// per-batch refetch storm, short enough that a save still shows up in the panel as it happens.
const COALESCE_MS = 500;

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
    // The coalesced Changes scan's memo (built below). Every mutation this router performs is one the user just
    // asked for and expects to see at once, so it drops the memo: the panel's own post-action refetch must never
    // be answered from a scan that predates the action it is refetching for.
    let scan: Promise<{ repos: RepoChanges[] }> | undefined;
    let reusableUntil = 0;
    const invalidateScan = (): void => {
        scan = undefined;
        reusableUntil = 0;
    };
    // A sequence/HEAD-moving op: checkpoint the pre-action tree FIRST (so even a rewrite stays reversible from
    // the Checkpoints timeline), run it, and record the resulting tree on the timeline on a clean apply.
    const guarded = async (repo: string, label: string, run: (dir: string) => Promise<ActionResult>): Promise<ActionResult> => {
        const dir = await repoDir(repo);
        await services.history.snapshot("user", label);
        const result = await run(dir);
        if (result.ok) {
            invalidateScan();
            services.history.notifyUserWrite();
        }
        return result;
    };
    const scanAll = async (): Promise<{ repos: RepoChanges[] }> => {
        const repoIds = await discoverRepos(services.workspace.root);
        // A Changes review right after a clone must not sweep the new repo's files into the root scope —
        // converge the root excludes on the repo set we're about to scan.
        await syncRootExcludes(services.config.historyRoot, repoIds);
        const candidates = [
            { repo: "root", dir: services.workspace.root },
            ...repoIds.map((id) => ({ repo: id, dir: join(services.workspace.root, id) })),
        ];
        // Each candidate is its own repo dir (own .git, no shared index.lock), so the scans run
        // concurrently — the panel waits for the slowest repo, not the sum of all of them.
        const scanned = await Promise.all(
            candidates.map(async (candidate): Promise<RepoChanges | undefined> => {
                try {
                    await healPointer(candidate.repo, candidate.dir);
                    // The change scan, the remote read and the agent attribution are independent (none touches
                    // the index) — one round-trip for all three. `remote` is what the panel's sync bar renders
                    // per repo; `landed` is which agent landed each path this repo has ever received.
                    const [{ branch, conflicted, staged, unstaged }, remote, landed] = await Promise.all([
                        services.git.changedFiles(candidate.dir),
                        services.git.remoteState(candidate.dir),
                        // Attribution is the only part of this scan the panel can do without: it decorates the
                        // rows, it isn't the rows. A failure here degrades to "nobody landed anything" rather
                        // than joining the catch below and reporting the whole repo as unreadable.
                        services.agentOrigins.forRepo(candidate.repo, candidate.dir).catch((error: unknown) => {
                            services.logger.debug({ err: error, repo: candidate.repo }, "git changes: origins unavailable");
                            return {};
                        }),
                    ]);
                    // A repo with a clean tree still belongs in the response when it is ahead of or behind its
                    // upstream — there is real work to sync, which is exactly what the panel must not hide.
                    if (conflicted.length > 0 || staged.length > 0 || unstaged.length > 0 || remote.ahead > 0 || remote.behind > 0) {
                        // Narrowed to the paths this scan actually reports: an agent's landed delta outlives the
                        // review (the paths stay in `base..landedTip` until the branch goes), so shipping it
                        // whole would attribute files that are no longer changed at all.
                        const dirty = new Set(
                            [...conflicted, ...staged, ...unstaged].flatMap((change) =>
                                change.from === undefined ? [change.path] : [change.path, change.from],
                            ),
                        );
                        const origins = Object.fromEntries(Object.entries(landed).filter(([path]) => dirty.has(path)));
                        return {
                            repo: candidate.repo,
                            ...(branch !== undefined ? { branch } : {}),
                            conflicted,
                            staged,
                            unstaged,
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
                    services.logger.debug({ err: error, repo: candidate.repo }, "git changes: repo unscannable");
                    return {
                        repo: candidate.repo,
                        conflicted: [],
                        staged: [],
                        unstaged: [],
                        error: gitFailureReason(error, "git could not read this repo"),
                    };
                }
            }),
        );
        return { repos: scanned.filter((repo) => repo !== undefined) };
    };

    // The panel refetches on every workspace-change batch — several times a second while a drop or a build lands,
    // from every connected browser — and each scan is a full discoverRepos walk plus a `git status` per repo.
    // Collapse them: callers arriving while a scan runs share it, and its result is reused for COALESCE_MS after it
    // settles, so a burst costs one scan instead of one per observer per batch. `reusableUntil` is 0 for the whole
    // time a scan is in flight, which is what makes the sharing (not just the caching) work.
    const coalescedScan = (): Promise<{ repos: RepoChanges[] }> => {
        if (scan !== undefined && (reusableUntil === 0 || Date.now() < reusableUntil)) {
            return scan;
        }
        reusableUntil = 0;
        scan = scanAll().then(
            (result) => {
                reusableUntil = Date.now() + COALESCE_MS;
                return result;
            },
            (error: unknown) => {
                // A whole-scan failure is never worth serving to the next caller — drop it so they rescan.
                scan = undefined;
                throw error;
            },
        );
        return scan;
    };

    return {
        changes: i.changes.handler(coalescedScan),
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
            const { branch, commits } = await services.git.commitLog(await repoDir(input.repo), input.limit ?? 300);
            return { repo: input.repo, ...(branch !== undefined ? { branch } : {}), commits };
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
        createBranch: i.createBranch.handler(async ({ input }) => {
            await services.git.createBranchAt(await repoDir(input.repo), input.name, input.sha);
            return { ok: true } as const;
        }),
        createTag: i.createTag.handler(async ({ input }) => {
            await services.git.createTagAt(await repoDir(input.repo), input.name, input.sha);
            return { ok: true } as const;
        }),
        checkout: i.checkout.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            await services.history.snapshot("user", `before checkout ${input.ref.slice(0, 12)}`);
            await services.git.checkoutRef(dir, input.ref);
            invalidateScan();
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        reset: i.reset.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            await services.history.snapshot("user", `before reset --${input.mode}`);
            await services.git.resetTo(dir, input.sha, input.mode);
            invalidateScan();
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
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
        commit: i.commit.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            // git's own refusals are the useful ones here — "Committing is not possible because you have unmerged
            // files", a pre-commit hook's failure, a missing identity. Carried as a CONFLICT with git's verdict
            // line so the panel prints the reason; a bare throw would reach the browser as an opaque 500 and the
            // user would read "Commit failed." with nothing to act on.
            try {
                const committed =
                    input.all === true
                        ? await services.git.commitAll(dir, input.message, AGENT_GIT_AUTHOR)
                        : await services.git.commitIndex(dir, input.message, AGENT_GIT_AUTHOR);
                invalidateScan();
                return { committed };
            } catch (error) {
                // The index may have moved even on a failure (`commit -a` stages before it commits), so the
                // panel's view is stale either way.
                invalidateScan();
                throw new ORPCError("CONFLICT", { message: gitFailureReason(error, "git refused the commit") });
            }
        }),
        // Index-only moves: the worktree is untouched, so no checkpoint and no history notification — only the
        // panel's view of what's staged changes.
        stage: i.stage.handler(async ({ input }) => {
            await services.git.stagePaths(await repoDir(input.repo), input.paths);
            invalidateScan();
            return { ok: true } as const;
        }),
        unstage: i.unstage.handler(async ({ input }) => {
            await services.git.unstagePaths(await repoDir(input.repo), input.paths);
            invalidateScan();
            return { ok: true } as const;
        }),
        branches: i.branches.handler(async ({ input }) => ({ branches: await services.git.listBranches(await repoDir(input.repo)) })),
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
        pull: i.pull.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            await services.history.snapshot("user", "before pull");
            const result = await services.git.pullRemote(dir);
            if (result.ok) {
                invalidateScan();
                services.history.notifyUserWrite();
            }
            return result;
        }),
        discard: i.discard.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            // The checkpoint goes BEFORE the destruction. Discard is the one verb in this router git itself
            // cannot walk back — untracked files are deleted outright, and a tracked file's worktree state was
            // never in the object store to reflog back to — so the snapshot that makes it recoverable has to
            // record the tree that is about to go. `notifyUserWrite` below records the RESULT, which is the
            // timeline's other half and no safety net at all; the sequence verbs get this via `guarded`, and
            // discard sat outside it purely because it reports no ActionResult.
            await services.history.snapshot("user", `before discard in ${input.repo}`);
            await services.git.discardPaths(dir, input.paths);
            invalidateScan();
            // The worktree changed under the user's feet — record it on the safety timeline like any user write.
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
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
