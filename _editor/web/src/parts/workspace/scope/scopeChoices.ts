import { type FleetLane, laneOf } from "../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../models/fleet/useAgents-fleet";

// What the scope switcher lists: every conversation in this sandbox that has a private copy to show, under the board's
// own lanes so a copy is filed where its card is on /agents. Inside a lane the order is the switcher's own, latest
// activity first, since the copy someone reaches for is nearly always one that just did something; the board orders
// Active by when each turn started, which would bury the newest. Each lane folds to a few rows, because a busy sandbox
// holds dozens of copies (one per conversation ever run, a failed fan-out's children all at once) and a list that long
// was the switcher's whole problem. A search reaches every copy, folded or not, and the copy on screen is always listed.

/** Rows a folded lane shows: the board's own Finished window, enough to see the latest without scrolling. */
export const SCOPE_WINDOW = 6;

export interface ScopeGroup {
    readonly lane: FleetLane;
    readonly agents: readonly FleetAgent[];
    /** Copies in this lane past the fold. Zero while searching, and once the lane is unfolded. */
    readonly hidden: number;
}

const LANES: readonly FleetLane[] = [`attention`, `active`, `finished`];

/** This sandbox's conversations with a checkout to switch to: no branch means no copy, and another box's copy is not this tree's. */
export const switchableCopies = (fleet: readonly FleetAgent[]): FleetAgent[] =>
    fleet.filter((agent) => agent.branch !== undefined && agent.sandboxId === undefined);

/** Whether a copy answers a typed query: every word of it somewhere in the title or branch, case aside. */
export const copyMatches = (agent: Pick<FleetAgent, "title" | "branch">, query: string): boolean => {
    const words = query
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word !== ``);
    const haystack = `${agent.title ?? ``} ${agent.branch ?? ``}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
};

const latestFirst = (a: FleetAgent, b: FleetAgent): number => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const scopeGroups = (
    copies: readonly FleetAgent[],
    {
        current,
        query = ``,
        unfolded = new Set(),
    }: { readonly current: string | undefined; readonly query?: string; readonly unfolded?: ReadonlySet<FleetLane> },
): ScopeGroup[] => {
    const searching = query.trim() !== ``;
    const matching = searching ? copies.filter((agent) => copyMatches(agent, query)) : copies;
    return LANES.map((lane): ScopeGroup => {
        const agents = matching.filter((agent) => laneOf(agent) === lane).toSorted(latestFirst);
        if (searching || unfolded.has(lane)) {
            return { lane, agents, hidden: 0 };
        }
        // The lane's head, plus the copy on screen where the order puts it when it falls past the fold.
        const shown = agents.filter((agent, index) => index < SCOPE_WINDOW || agent.id === current);
        return { lane, agents: shown, hidden: agents.length - shown.length };
    }).filter((group) => group.agents.length > 0);
};

// BRANCHES: what else the switcher offers besides the copies, one list per repository. The shared checkout stays on its
// main line, so another branch is looked at here (read from a checkout the daemon keeps of it) or started from, never
// switched to. Each repository's local branches and the remotes' ones it has no local for, newest first, leaving out the
// main line (the shared workspace itself, the list's first row) and the agents' own `agent/*` branches (their copies,
// listed under the lanes). A remote-only branch goes by its short name: the daemon makes the local one when it is needed.

/** Branches a folded repository shows before "Show more". */
export const BRANCH_WINDOW = 5;

/** One branch of one repository, as the switcher offers it. */
export interface BranchChoice {
    readonly repo: string;
    readonly branch: string;
    /** When its tip was committed, in milliseconds. */
    readonly at: number;
    /** The remote it was seen on, when it is only there. */
    readonly remote?: string;
}

export interface BranchGroup {
    readonly repo: string;
    readonly branches: readonly BranchChoice[];
    /** Branches past the fold. Zero while searching, and once the repository is unfolded. */
    readonly hidden: number;
}

/** The one remote whose branches the daemon takes by their short name. */
const STARTABLE_REMOTE = `origin`;

/** The prefix every conversation's own branch carries (the daemon's `agent/<id>`). */
const AGENT_BRANCH_PREFIX = `agent/`;

interface Listing {
    readonly branches: readonly { readonly name: string; readonly current: boolean; readonly at: number }[];
    readonly remotes: readonly { readonly remote: string; readonly branch: string; readonly at: number }[];
}

/** A repository's branches as choices: locals and remote-only ones, main line and agents' branches left out. */
export const branchChoices = (repo: string, listing: Listing, mainBranch?: string): BranchChoice[] => {
    const current = listing.branches.find((branch) => branch.current)?.name;
    const offered = (name: string): boolean => !name.startsWith(AGENT_BRANCH_PREFIX) && name !== current && name !== mainBranch && name !== `HEAD`;
    const locals = new Set(listing.branches.map((branch) => branch.name));
    const choices: BranchChoice[] = listing.branches.filter((branch) => offered(branch.name)).map((branch) => ({ repo, branch: branch.name, at: branch.at }));
    // A remote-only branch is offered from `origin` alone: the daemon makes the local branch from origin's tip when it is
    // first viewed or started from (its branch-checkouts.ts), and a branch only another remote holds has none to make.
    const remoteOnly = new Map<string, BranchChoice>();
    for (const seen of listing.remotes) {
        if (seen.remote === STARTABLE_REMOTE && offered(seen.branch) && !locals.has(seen.branch) && !remoteOnly.has(seen.branch)) {
            remoteOnly.set(seen.branch, { repo, branch: seen.branch, at: seen.at, remote: seen.remote });
        }
    }
    return [...choices, ...remoteOnly.values()].toSorted((a, b) => b.at - a.at || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
};

/** Whether a branch answers a typed query: every word of it somewhere in its name or its repository's. */
const branchMatches = (choice: Pick<BranchChoice, "repo" | "branch">, query: string): boolean => {
    const words = query
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word !== ``);
    const haystack = `${choice.repo} ${choice.branch}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
};

/** The branches grouped by repository in the order given, each folded to its newest few unless searched or unfolded. */
export const branchGroups = (
    choices: readonly BranchChoice[],
    {
        current,
        query = ``,
        unfolded = new Set(),
    }: { readonly current: { readonly repo: string; readonly branch: string } | undefined; readonly query?: string; readonly unfolded?: ReadonlySet<string> },
): BranchGroup[] => {
    const searching = query.trim() !== ``;
    const repos = [...new Set(choices.map((choice) => choice.repo))];
    return repos
        .map((repo): BranchGroup => {
            const branches = choices.filter((choice) => choice.repo === repo && (!searching || branchMatches(choice, query)));
            if (searching || unfolded.has(repo)) {
                return { repo, branches, hidden: 0 };
            }
            // The newest few, plus the branch on screen where the order puts it when it falls past the fold.
            const isCurrent = (choice: BranchChoice): boolean => current?.repo === choice.repo && current.branch === choice.branch;
            const shown = branches.filter((choice, index) => index < BRANCH_WINDOW || isCurrent(choice));
            return { repo, branches: shown, hidden: branches.length - shown.length };
        })
        .filter((group) => group.branches.length > 0);
};
