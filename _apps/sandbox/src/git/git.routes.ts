import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitContract, type RepoChanges } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir, syncRootExcludes } from "../history/history.js";
import { discoverRepos, isValidRepoId } from "../workspace/repo-discovery.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import type { ActionResult } from "./changes.js";
import { AGENT_GIT_AUTHOR } from "./git.js";

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
    // A sequence/HEAD-moving op: checkpoint the pre-action tree FIRST (so even a rewrite stays reversible from
    // the Checkpoints timeline), run it, and record the resulting tree on the timeline on a clean apply.
    const guarded = async (repo: string, label: string, run: (dir: string) => Promise<ActionResult>): Promise<ActionResult> => {
        const dir = await repoDir(repo);
        await services.history.snapshot("user", label);
        const result = await run(dir);
        if (result.ok) {
            services.history.notifyUserWrite();
        }
        return result;
    };
    return {
        changes: i.changes.handler(async () => {
            const repoIds = await discoverRepos(services.workspace.root);
            // A Changes review right after a clone must not sweep the new repo's files into the root scope —
            // converge the root excludes on the repo set we're about to scan.
            await syncRootExcludes(services.config.historyRoot, repoIds);
            const candidates = [
                { repo: "root", dir: services.workspace.root },
                ...repoIds.map((id) => ({ repo: id, dir: join(services.workspace.root, id) })),
            ];
            const repos: RepoChanges[] = [];
            for (const candidate of candidates) {
                try {
                    await healPointer(candidate.repo, candidate.dir);
                    const { branch, changes } = await services.git.changedFiles(candidate.dir);
                    if (changes.length > 0) {
                        repos.push({ repo: candidate.repo, ...(branch !== undefined ? { branch } : {}), changes });
                    }
                } catch (error) {
                    // One broken repo (a deleted .git with no heal source, a mid-clone dir) must not 500 the panel.
                    services.logger.warn({ err: error, repo: candidate.repo }, "git changes: repo skipped");
                }
            }
            return { repos };
        }),
        fileDiff: i.fileDiff.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            if (resolveWithin(dir, input.path) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            return services.git.fileDiff(dir, input.path, "HEAD");
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
            if (resolveWithin(dir, input.path) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
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
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        reset: i.reset.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            await services.history.snapshot("user", `before reset --${input.mode}`);
            await services.git.resetTo(dir, input.sha, input.mode);
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
        commit: i.commit.handler(async ({ input }) => {
            const dir = await repoDir(input.repo);
            const committed =
                input.paths !== undefined
                    ? await services.git.commitPaths(dir, input.message, input.paths, AGENT_GIT_AUTHOR)
                    : await services.git.commitAll(dir, input.message, AGENT_GIT_AUTHOR);
            return { committed };
        }),
        discard: i.discard.handler(async ({ input }) => {
            await services.git.discardPaths(await repoDir(input.repo), input.paths);
            // The worktree changed under the user's feet — record it on the safety timeline like any user write.
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
        push: i.push.handler(async ({ input }) => {
            await services.git.push(await repoDir(input.repo), input.branch);
            return { ok: true } as const;
        }),
        files: i.files.handler(async ({ input }) => ({ files: await services.git.listFiles(await repoDir(input.repo)) })),
        readFile: i.readFile.handler(async ({ input }) => {
            const target = resolveWithin(await repoDir(input.repo), input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            const content = await services.files.read(target);
            if (content === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "not found" });
            }
            return { path: input.path, content };
        }),
        writeFile: i.writeFile.handler(async ({ input }) => {
            const target = resolveWithin(await repoDir(input.repo), input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            await services.files.write(target, input.content);
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
    };
};
