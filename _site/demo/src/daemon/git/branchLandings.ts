import type { BranchLandings } from "@intentic/sandbox-contract/schemas/git/branch-landings";
import { refuse } from "@intentic/contract-serve";
import { graphOf, reachable, resolveRef } from "./gitGraph";

export const branchLandings = (repo: string, branch: string, before?: string): BranchLandings => {
    const graph = graphOf(repo);
    const tip = resolveRef(graph, branch) ?? graph.fetched.get(branch);
    if (tip === undefined) { return refuse(`unknown branch`, 404); }
    const mainBranch = `main`;
    const main = reachable(graph, [graph.branches.get(mainBranch) ?? ``]);
    if (before !== undefined && !reachable(graph, [tip]).has(before)) {
        return refuse(`the branch was rewritten; refresh its landings before continuing`, 412);
    }
    let cursor = before === undefined ? tip : graph.commits.get(before)?.parents[0];
    const commits: BranchLandings[`commits`] = [];
    while (cursor !== undefined && !main.has(cursor)) {
        const commit = graph.commits.get(cursor);
        if (commit === undefined) { break; }
        const agent = commit.body.match(/^Conversation-Id: (\S+)/mu)?.[1];
        if (agent !== undefined) {
            if (commits.length === 50) { return { mainBranch, commits, next: commits.at(-1)!.sha }; }
            commits.push({ sha: commit.sha, short: commit.sha.slice(0, 7), subject: commit.subject, at: commit.at, agent });
        }
        cursor = commit.parents[0];
    }
    return { mainBranch, commits };
};
