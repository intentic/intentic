import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitContract, type RepoChanges } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { repoGitDir } from "../history/history.js";
import { isValidRepoName, listRepos } from "../workspace/extra-repos.js";
import { REPO_ROLES, type RepoRole } from "../workspace/workspace.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { AGENT_GIT_AUTHOR } from "./git.js";

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Per-repo git ops over "root" (the /work repo), the three roles, and extra clones under /work/repositories.
// An unknown {repo} is NOT_FOUND; a path that escapes the repo dir is BAD_REQUEST; a missing file is
// NOT_FOUND. `changes` is the Changes panel's aggregated review set; commit/discard take optional `paths` for
// the per-file actions.
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
    // "root" and the three roles resolve unconditionally (the sandbox boots empty — status/commit on a
    // not-yet-scaffolded role fails naturally, matching the prior behavior); an extra clone must exist.
    const repoDir = async (repo: string): Promise<string> => {
        if (repo === "root") {
            await healPointer(repo, services.workspace.root);
            return services.workspace.root;
        }
        if ((REPO_ROLES as readonly string[]).includes(repo)) {
            const dir = services.workspace.repos[repo as RepoRole];
            await healPointer(repo, dir);
            return dir;
        }
        if (isValidRepoName(repo)) {
            const dir = join(services.workspace.repositories, repo);
            if (await exists(dir)) {
                await healPointer(repo, dir);
                return dir;
            }
        }
        throw new ORPCError("NOT_FOUND", { message: "unknown repo" });
    };
    return {
        changes: i.changes.handler(async () => {
            const candidates = [
                { repo: "root", dir: services.workspace.root },
                ...REPO_ROLES.map((role) => ({ repo: role as string, dir: services.workspace.repos[role] })),
                ...(await listRepos(services.workspace.repositories)).map((name) => ({
                    repo: name,
                    dir: join(services.workspace.repositories, name),
                })),
            ];
            const repos: RepoChanges[] = [];
            for (const candidate of candidates) {
                if (candidate.repo !== "root" && !(await exists(candidate.dir))) {
                    continue;
                }
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
