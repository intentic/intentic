import { host } from "./host.js";

/* WHICH DIRECTORIES ARE REPOSITORIES — the question behind the tree row's icon and the graph's repo switcher.
 *
 * No poll and no fetch of its own: the daemon's repo discovery already reaches this extension as `RepoFacts`, and
 * the host refreshes those from the same `discoverRepos` walk that `GET /git/repos` runs. Reading them here is
 * also what makes the row icon appear the moment a repo is cloned or scaffolded — `workspace.repos()` reads a ref,
 * and `detect()` is called inside the tree's own computed.
 *
 * "root" is the /work repository itself. It is absent from the facts by construction (discovery excludes it — it
 * is the container every other repo is discovered INSIDE), so it is prepended here, exactly as the app's own repo
 * list does it. That asymmetry is also why the workspace root's document is offered for the empty path: "" is how
 * the tree spells the root directory, and `root` is how the git routes spell the repo sitting on it. */

// The repo ids the git routes accept, root first — the graph's switcher list.
export const repoIds = (): readonly string[] => [
    `root`,
    ...host()
        .workspace.repos()
        .map((facts) => facts.repo),
];

// The repo a workspace directory IS, or undefined when the directory is not a repository root. Root-relative
// paths, forward-slash; "" is the workspace root.
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
