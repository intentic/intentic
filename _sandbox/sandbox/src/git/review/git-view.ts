import { join } from "node:path";
import { pathExists } from "@intentic/base/fs";
import type { GitView } from "@intentic/sandbox-contract/schemas/git/git-view";
import { ORPCError } from "@orpc/server";
import type { Services } from "../../composition.js";
import { workspaceRootFor } from "../../workspace/layout/workspace-scope.js";
import { isValidRepoId } from "../../workspace/layout/repo-discovery.js";

type GitViewServices = Pick<Services, "workspace" | "agents" | "agentWorktrees" | "branchCheckouts">;

export const gitViewKey = (view: GitView | undefined): string =>
    view?.agent !== undefined ? `agent:${view.agent}` : view?.branch !== undefined ? `branch:${view.repo ?? "root"}\n${view.branch}` : "";

export const gitViewRepos = (services: GitViewServices, view: GitView): readonly string[] => {
    if (view.branch !== undefined) {
        return [view.repo ?? "root"];
    }
    const entry = view.agent === undefined ? undefined : services.agents.entry(view.agent);
    if (entry === undefined) {
        throw new ORPCError("NOT_FOUND", { message: "Unknown conversation." });
    }
    return entry.placement.kind === "worktree" ? entry.placement.repos.map(({ repo }) => repo) : [];
};

export const gitViewRepoDir = async (services: GitViewServices, view: GitView, repo: string): Promise<string> => {
    if ((repo !== "root" && !isValidRepoId(repo)) || !gitViewRepos(services, view).includes(repo)) {
        throw new ORPCError("NOT_FOUND", { message: "This repository is outside the selected checkout." });
    }
    const root = await workspaceRootFor({
        main: services.workspace.root,
        entry: services.agents.entry,
        worktreeDir: (id) => services.agentWorktrees.worktreeDir(id, "root"),
        branches: services.branchCheckouts,
    }, view);
    const dir = repo === "root" ? root : join(root, repo);
    if (!(await pathExists(join(dir, ".git")))) {
        throw new ORPCError("PRECONDITION_FAILED", { message: "The selected checkout is no longer available." });
    }
    return dir;
};

export const gitViewHistory = (services: Pick<Services, "history">, view?: GitView) => {
    const checkpoint = async (dir: string, label: string): Promise<void> => {
        if (view === undefined) { await services.history.snapshot("user", label); return; }
        await services.history.checkpointIn(dir, gitViewKey(view), label);
    };
    const notifyWrite = (): void => { if (view === undefined) { services.history.notifyUserWrite(); } };
    return { checkpoint, notifyWrite };
};
