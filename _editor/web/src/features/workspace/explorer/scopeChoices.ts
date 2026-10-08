import { type FleetLane, laneOf } from "../../agents/fleet/agentStatus";
import type { FleetAgent } from "../../agents/fleet/useAgents-fleet";

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
