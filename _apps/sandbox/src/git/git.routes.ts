import { gitContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { REPO_ROLES, type RepoRole } from "../workspace/workspace.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { AGENT_GIT_AUTHOR } from "./git.js";

// Per-repo git ops over the three workspace repos. An unknown {repo} is NOT_FOUND; a path that escapes the
// repo dir is BAD_REQUEST; a missing file is NOT_FOUND. The sandbox boots empty (no intent/desired-state until
// DevOps is activated); the only route the web hits before then is `file` (readFile), which 404s naturally when
// the file is absent — status/files/commit are only reached from the DevOps-gated Infra UI.
export const createGitRoutes = (services: Services) => {
    const i = implement(gitContract).$context<OrpcContext>();
    const repoDir = (repo: string): string => {
        if (!(REPO_ROLES as readonly string[]).includes(repo)) {
            throw new ORPCError("NOT_FOUND", { message: "unknown repo" });
        }
        return services.workspace.repos[repo as RepoRole];
    };
    return {
        status: i.status.handler(({ input }) => services.git.status(repoDir(input.repo))),
        commit: i.commit.handler(async ({ input }) => ({
            committed: await services.git.commitAll(repoDir(input.repo), input.message, AGENT_GIT_AUTHOR),
        })),
        push: i.push.handler(async ({ input }) => {
            await services.git.push(repoDir(input.repo), input.branch);
            return { ok: true } as const;
        }),
        files: i.files.handler(async ({ input }) => ({ files: await services.git.listFiles(repoDir(input.repo)) })),
        readFile: i.readFile.handler(async ({ input }) => {
            const target = resolveWithin(repoDir(input.repo), input.path);
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
            const target = resolveWithin(repoDir(input.repo), input.path);
            if (target === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "invalid path" });
            }
            await services.files.write(target, input.content);
            services.history.notifyUserWrite();
            return { ok: true } as const;
        }),
    };
};
