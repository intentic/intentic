import type { MenuItem } from "@intentic/extension-ui";
import { host } from "./host.js";
import { t } from "./i18n.js";

// What a branch offers now that the shared workspace stays on each repository's main line: nothing here switches it.
// A person looks at another branch in the Workspace's own per-person view of it, or starts an agent whose private copy
// is cut from it. The branch the workspace stands on offers neither, since it IS what the Workspace shows.

/** The branch a ref names by its short name, the only spelling a view or a start takes: `origin/feature/x` is `feature/x`
 *  (the daemon makes the local one when it is first needed). The longest matching remote wins, so a remote whose own
 *  name has a slash in it still strips whole; a local branch's name comes back as it is. */
export const shortBranchName = (ref: string, remotes: readonly string[]): string => {
    const remote = remotes.filter((name) => ref.startsWith(`${name}/`)).toSorted((a, b) => b.length - a.length)[0];
    return remote === undefined ? ref : ref.slice(remote.length + 1);
};

/** The editor's address for the Workspace showing `branch` of `repo` ("root" is the workspace itself). */
export const workspaceViewPath = (repo: string, branch: string): string =>
    `/workspace?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`;

export const viewInWorkspace = (repo: string, branch: string): void => host().navigate(workspaceViewPath(repo, branch));

export const startAgentFrom = (repo: string, branch: string): void => host().chat.composeFrom({ repo, branch });

/** The same two actions as a context menu's entries, each naming the branch it acts on. */
export const branchMenuItems = (repo: string, branch: string): MenuItem[] => [
    { label: t(`branchActions.viewNamed`, { branch }), command: () => viewInWorkspace(repo, branch) },
    { label: t(`branchActions.startNamed`, { branch }), command: () => startAgentFrom(repo, branch) },
];
