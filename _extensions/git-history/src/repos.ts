import { host } from "./host.js";

// Repo discovery comes from the daemon's `RepoFacts` (the same `discoverRepos` walk `GET /git/repos` runs); nothing
// here polls or fetches on its own. `root` names the /work repository itself and is prepended here since discovery
// excludes it ("" is the tree's spelling of the workspace root).

// The repo a workspace directory is, or undefined if it isn't a repo root. Root-relative, forward-slash paths; "" is
// the workspace root.
export const repoAt = (path: string): string | undefined => {
    if (path === ``) {
        return `root`;
    }
    return host()
        .workspace.repos()
        .some((facts) => facts.repo === path)
        ? path
        : undefined;
};
