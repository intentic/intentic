import { defaultGit, type GitRunner } from "@intentic/base/git";
import { branchSha } from "../../../git/agent-refs.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";
import type { AgentWorktrees } from "../../worktrees/worktrees.js";
import { agentRepoAnchor } from "../agent-changes.js";
import { UNDERIVED } from "../rederive.js";

// What a conversation's branch has changed and not landed, file by file, for the files-in-flight index
// (conversations/files-in-flight.ts). Measured as its land measures it, so a file counts here exactly when its land
// would carry it.

/** One conversation's reading: its unlanded paths, workspace-relative, and the branch tip each repo was read at. */
export interface UnlandedPaths {
    readonly paths: readonly string[];
    readonly tips: ReadonlyMap<string, string>;
}

// A workspace-relative path for a repo-relative one: a nested repo's under its folder.
export const inWorkspace = (repo: string, path: string): string => (repo === "root" ? path : `${repo}/${path}`);

/** The files a conversation's branch changed and has not landed, from its last land's tip, else from where it left the
 *  main line (its parent's commit, for a subagent), derived files left out. */
export const unlandedPaths = async (worktrees: AgentWorktrees, entry: IsolatedAgent, git: GitRunner = defaultGit): Promise<UnlandedPaths> => {
    const paths: string[] = [];
    const tips = new Map<string, string>();
    for (const composed of entry.placement.repos) {
        const main = worktrees.mainDir(composed.repo);
        const tip = await branchSha(main, entry.placement.branch, git);
        if (tip === undefined) {
            continue;
        }
        tips.set(composed.repo, tip);
        const anchor = await agentRepoAnchor(worktrees, entry, composed, git);
        if (anchor === tip) {
            continue;
        }
        const { stdout } = await git(main, ["diff", "--name-only", "--no-renames", "-z", anchor, tip, ...UNDERIVED]);
        paths.push(...stdout.split("\0").filter((path) => path !== "").map((path) => inWorkspace(composed.repo, path)));
    }
    return { paths, tips };
};
