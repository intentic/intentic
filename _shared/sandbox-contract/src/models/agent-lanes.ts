import type { AgentAttention } from "../schemas/agents.js";
import type { AutomationApproval } from "../schemas/automations.js";
import { goesBySelf } from "../schemas/agent-next.js";
import { parentOf } from "./agent-starter.js";
import { type AgentStanding, blocked, heardByParent, onlyOwnerCanAnswer, turnInFlight, turnWorking, watching } from "./agent-standing.js";

// The lane every surface files a conversation in, and what of a fleet calls the person. Moved here from the editor
// (_editor/web/src/models/agent-status/agentStatus-lanes.ts, which re-exports it) on 2026-10-16, so the daemon's
// `agents.attention` (what the desktop app's status bar and `ic sandbox attention` read) counts by the board's own rules.

// Whether what a child agent stopped on is the reader's to answer rather than its parent's, given the lanes both stand
// in and when the parent last moved. An ask only the owner can answer always is; anything else it stopped on (a spent
// allowance, a failure, a stop, a question, a land conflict) is its parent's news while the parent supervises, and the
// reader's once it no longer does: nothing running there to hear it and nothing armed to wake it, which is a parent out
// of Active. That holds only until the parent moves past it (heardByParent). After that the stop is the family's
// history, drawn in the tray, and no longer something the reader owes a press. The sandbox draws the same line for a
// child's land news (subagents/child-lands.ts): the parent's while it has a live turn, the owner's after. A fresh
// session is the exception: its parent never supervises it (nothing it does is reported there), so whatever it stops on
// is the reader's from the start, through its parent's card, however busy the parent is.
export const callsOwner = (
    child: AgentStanding & { readonly updatedAt: number },
    family: { readonly child: FleetLane; readonly parent: FleetLane; readonly parentAt: number },
): boolean =>
    onlyOwnerCanAnswer(child) ||
    (family.child === "attention" && (family.parent !== "active" || child.fresh !== undefined) && !heardByParent(child, family.parentAt));

export type FleetLane = "attention" | "active" | "finished";

// Nothing owed to the user. The one "no attention" block in the app: a client-only card has no daemon account of
// what a turn asked, and two copies of this would let two surfaces place the same conversation differently.
export const NO_ATTENTION: AgentAttention = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

// The lane projection every surface must agree with (see the header). Pure reading of the state machine:
// "finished" needs no explicit timer since auto-land already flips a cleanly-completed turn to landed/idle within
// ms, and any follow-up message moves the card back to active. Unread stays a badge, not a lane.
export const laneOf = (agent: AgentStanding): FleetLane => {
    // A spent allowance nothing carries on reaches Attention through `blocked` alone, no branch of its own, and ahead
    // of the `watching` branch below: a watch is the agent's own plan for waiting, a spent allowance an obstacle in
    // the way of it, and a watch firing into a shut window runs nothing (turn-admission.ts holds its words back).
    if (blocked(agent) || agent.status === "awaiting" || agent.status === "conflict") {
        return "attention";
    }
    // Settled from the press, ahead of the in-flight check below, rather than routed through Active: a waved-away turn
    // is one the user is already done with (unlike `stopping`, which rests in Attention), and a land spends no model at
    // all. Active means a turn in progress, so a land must end in the lane it was pressed in.
    if (agent.status === "dismissing" || agent.status === "landing") {
        return "finished";
    }
    // `resuming` is why in-flight must outrank the settled readings below: without this order the card would drop
    // into Finished for the seconds a credential takes to re-mint, then climb back out.
    if (turnInFlight(agent) || agent.status === "draft") {
        return "active";
    }
    // An armed watch is Active, not Finished: nothing is running, but the conversation restarts itself later, and
    // filing it Finished would announce as over work that resumes at 3am. Active rather than Attention since nothing
    // is owed by the user. Checked after the in-flight readings: an agent that armed a watch and is now running again
    // is running.
    if (watching(agent)) {
        return "active";
    }
    // Whatever carries it on by itself (`next`: a held turn re-run or moved, a send once memory frees, messages booked
    // for a time or another agent's land) is Active: filing it Finished would announce as over work that resumes or has
    // not started yet. An ending it answers reached here because `blocked` let it through on the same reading.
    if (goesBySelf(agent)) {
        return "active";
    }
    // `landed`/`idle`/`ready` all finish here: `ready` is work held on the branch because auto-land is off, still
    // finished rather than attention since nothing is failing. `resumed` lands here too: nothing running, nothing
    // owed.
    return "finished";
};

// How many cards the board's Attention lane draws for one fleet, as the board folds child agents under their parents
// (models/fleet/board/childFold.ts): an agent in Attention is a card of its own, except a child agent whose parent is in the
// fleet, which rides under its family's one card and lifts that card to Attention only when it calls the reader
// (callsOwner). A family counts once however many of its children call, and not again when its own card is in
// Attention already; a child with words left in its composer keeps a card of its own, as on the board. The rail
// badge's count, for this sandbox's fleet and another's alike, so the badge cannot disagree with the lane it names.
export const attentionCards = (agents: readonly CallerStanding[]): number => new Set(attentionCalls(agents).map((call) => call.card)).size;

// Enough of a fleet's agent to say whether it calls the reader, and through which card.
export type CallerStanding = AgentStanding & {
    readonly id: string;
    readonly updatedAt: number;
    readonly startedBy?: string | undefined;
    readonly unsent?: boolean | undefined;
};

// Every agent calling the reader, each with the card it is drawn on: its own, or its family's where it rides one. The
// count above is the cards; the browser tab's chime wants the callers, so a second child calling under a family already
// in Attention is news although the lane's count does not move.
export const attentionCalls = (agents: readonly CallerStanding[]): readonly { readonly id: string; readonly card: string }[] => {
    type Standing = (typeof agents)[number];
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    const parentIn = (agent: Standing): Standing | undefined => {
        const id = parentOf(agent.startedBy);
        return id === undefined ? undefined : byId.get(id);
    };
    // The card a child rides under: its eldest ancestor in this fleet, walked with a guard against a record naming its
    // own descendant as its parent.
    const familyOf = (agent: Standing): string => {
        const seen = new Set([agent.id]);
        let top = agent;
        for (let above = parentIn(top); above !== undefined && !seen.has(above.id); above = parentIn(top)) {
            seen.add(above.id);
            top = above;
        }
        return top.id;
    };
    const calls: { readonly id: string; readonly card: string }[] = [];
    for (const agent of agents) {
        const parent = parentIn(agent);
        // Words left in a child's composer give it a card of its own (childFold.standsAlone), except a fresh session's:
        // its composer is the person's anyway, and it rides its origin's card whatever it holds.
        if (parent === undefined || (agent.unsent === true && agent.fresh === undefined)) {
            if (laneOf(agent) === "attention") {
                calls.push({ id: agent.id, card: agent.id });
            }
        } else if (callsOwner(agent, { child: laneOf(agent), parent: laneOf(parent), parentAt: parent.updatedAt })) {
            calls.push({ id: agent.id, card: familyOf(agent) });
        }
    }
    return calls;
};

// What one fleet owes the person and how much of it is under way, as the desktop app's status bar and the sandbox
// switcher count it: the Attention lane's cards as the board draws them (attentionCards) plus held automation wakes,
// which lead that lane with no card of their own; and the turns producing something right now (turnWorking).
export interface FleetAttention {
    readonly needsYou: number;
    readonly working: number;
}

export const fleetAttention = (agents: readonly CallerStanding[], held: readonly Pick<AutomationApproval, "id">[]): FleetAttention => ({
    needsYou: attentionCards(agents) + held.length,
    working: agents.filter(turnWorking).length,
});
