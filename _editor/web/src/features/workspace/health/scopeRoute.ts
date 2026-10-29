import type { LocationQuery, LocationQueryRaw } from "vue-router";
import { agentScope, branchScope, SHARED_SCOPE, scopeFields, type ViewScope } from "../../../app/workspaceScope";

// The Workspace's scope as its URL carries it: `?agent=<conversation>` for a conversation's copy, `?repo=<repo>&branch=
// <branch>` for a branch (`repo` left out is the workspace's own, "root"), nothing for the shared tree. So a reload, a
// back press and a link someone pasted all land on the same copy.

// One value per name: a repeated parameter names nothing rather than guessing which one was meant.
const one = (value: LocationQuery[string] | undefined): string | undefined =>
    Array.isArray(value) || value === null || value === undefined || value === `` ? undefined : value;

/** The scope a URL names; an agent outranks a branch, which the daemon never takes together. */
export const scopeFromQuery = (query: LocationQuery): ViewScope => {
    const agent = one(query[`agent`]);
    if (agent !== undefined) {
        return agentScope(agent);
    }
    const branch = one(query[`branch`]);
    return branch === undefined ? SHARED_SCOPE : branchScope({ repo: one(query[`repo`]) ?? `root`, branch });
};

/** `query` naming `scope` instead of whichever it named, every other parameter kept. */
export const queryWithScope = (query: LocationQuery, scope: ViewScope): LocationQueryRaw => {
    const { agent: _agent, branch: _branch, repo: _repo, ...rest } = query;
    return { ...rest, ...scopeFields(scope) };
};
