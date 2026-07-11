import { join } from "node:path";
import { type RepoRole, REPO_ROLES } from "@intentic/scaffold";

export { type RepoRole, REPO_ROLES };

export interface WorkspacePaths {
    readonly root: string;
    // All git repos live under <root>/repositories so the <root> itself stays the user's own file space.
    readonly repositories: string;
    readonly repos: Readonly<Record<RepoRole, string>>;
}

// The on-disk layout: every repo lives under <root>/repositories/<role> (keeping <root> free for the user's own
// files). Pure path derivation so the daemon, the CLI, and tests all agree on where each repo lives.
export const workspacePaths = (root: string): WorkspacePaths => {
    const repositories = join(root, "repositories");
    return {
        root,
        repositories,
        repos: {
            intent: join(repositories, "intent"),
            "desired-state": join(repositories, "desired-state"),
            app: join(repositories, "app"),
        },
    };
};
