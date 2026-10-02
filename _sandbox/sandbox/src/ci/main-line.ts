import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { trackedDefaultBranchOf } from "../git/ops/publish-file.js";
import type { CiForge, CiStore } from "./ci-store.js";
import type { CiProject } from "./projects.js";

// The one answer to "which branch is this repository's main line", the branch main's fix agent owns (main-fixer.ts)
// and the `ci` automations leave to it (events.ts). The forge's own word comes first, learned at the hook reconcile
// (hooks.ts) and from every delivery (webhook.routes.ts); then what the clone recorded as `origin/HEAD`; and only when
// neither says, the two names a default branch usually has.

// The main line of a repository whose default branch nobody has said.
const FALLBACK_MAIN_LINE: ReadonlySet<string> = new Set(["main", "master"]);

interface MainLineServices {
    readonly workspace: { readonly root: string };
    readonly ciStore: Pick<CiStore, "forges">;
}

/** What the forge said of the project, while the remote still names what it was learned for. */
export const forgeOf = (forges: Readonly<Record<string, CiForge>>, project: Pick<CiProject, "repo" | "project">): CiForge | undefined => {
    const forge = forges[project.repo];
    return forge !== undefined && forge.remote.toLowerCase() === project.project.toLowerCase() ? forge : undefined;
};

/** The repository's default branch, or undefined when neither the forge nor the clone has said. */
export const defaultBranchFor = async (
    services: MainLineServices,
    project: Pick<CiProject, "repo" | "project">,
    git: GitRunner = defaultGit,
): Promise<string | undefined> => {
    const learned = forgeOf(await services.ciStore.forges(), project)?.defaultBranch;
    if (learned !== undefined && learned !== "") {
        return learned;
    }
    const dir = project.repo === "root" ? services.workspace.root : join(services.workspace.root, project.repo);
    return trackedDefaultBranchOf(dir, "origin", git);
};

/** Whether a failure on this branch is main's: any other branch is somebody's work in progress. */
export const isMainLine = async (services: MainLineServices, project: Pick<CiProject, "repo" | "project">, branch: string): Promise<boolean> => {
    const known = await defaultBranchFor(services, project);
    return known === undefined ? FALLBACK_MAIN_LINE.has(branch) : branch === known;
};
