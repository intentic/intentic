import type { AgentSummary, PresenceUser, SystemEvent } from "@intentic/sandbox-contract";
import { refuse } from "@intentic/contract-serve";
import { automationApprovals } from "../fixture/automations";
import { DESK_AWAITING_ID, DESK_FEATURED_ID, deskRoster } from "../fixture/desk";
import { AWAITING_AGENT_ID, FEATURED_AGENT_ID, fleetRoster, quietCard } from "../fixture/fleet";
import { demoNeeds } from "../fixture/needs";
import { demoMode, demoQuiet, deskEdition, freshEdition } from "../mode";

// The live agent board the demo mutates and re-broadcasts: the roster, who it waits on, and the pub/sub every
// write goes through (snapshot-not-diff, newest rev wins).

export const STARTED_AT = Date.now();

// Which recording's two special cards this page serves: the run with a script behind it, and the one parked on a question.
export const FEATURED_ID = deskEdition ? DESK_FEATURED_ID : FEATURED_AGENT_ID;
export const AWAITING_ID = deskEdition ? DESK_AWAITING_ID : AWAITING_AGENT_ID;

const servedRoster = (): AgentSummary[] => {
    const agents = deskEdition ? deskRoster(STARTED_AT) : fleetRoster(STARTED_AT).filter((agent) => demoMode.agents?.includes(agent.id) ?? true);
    return demoQuiet() ? agents.map(quietCard) : agents;
};
export const roster = { agents: servedRoster(), rev: 1 };

// What each card still waits on people for, read from the needs fixture every time the roster goes out, as the daemon's
// registry reads its needs store: answering one in the inbox takes the chip off the board on the next frame.
const withNeeds = (agent: AgentSummary): AgentSummary => {
    const open = demoNeeds().filter((need) => need.conversationId === agent.id && (need.status === `open` || need.status === `working`));
    return open.length === 0
        ? agent
        : {
              ...agent,
              attention: { ...agent.attention, need: true },
              needs: open.map((need) => ({ id: need.id, kind: need.subject.kind, title: need.title, status: need.status })),
          };
};
export const boardAgents = (): AgentSummary[] => roster.agents.map(withNeeds);

// Held automation approvals project onto the board's attention lane; a desk runs no automations.
export const heldApprovals = () => (deskEdition || freshEdition ? [] : automationApprovals(Date.now()));
export const listeners = new Set<(event: SystemEvent) => void>();

export const broadcastRoster = (): void => {
    roster.rev += 1;
    const frame: SystemEvent = { kind: `agents`, agents: boardAgents(), rev: roster.rev };
    for (const listener of listeners) {
        listener(frame);
    }
};

export const amendAgent = (id: string, amend: (agent: AgentSummary) => AgentSummary): AgentSummary | undefined => {
    const index = roster.agents.findIndex((agent) => agent.id === id);
    const found = roster.agents[index];
    if (found === undefined) {
        return undefined;
    }
    const next = amend(found);
    roster.agents = roster.agents.with(index, next);
    broadcastRoster();
    return next;
};

export const patchAgent = (id: string, patch: Partial<AgentSummary>): AgentSummary | undefined => amendAgent(id, (found) => ({ ...found, ...patch }));

// The answer every card route gives: the card as it now stands, or the daemon's refusal for an id it does not hold.
export const agentAnswer = (agent: AgentSummary | undefined): AgentSummary => agent ?? refuse(`No such agent.`, 404);

// The two demo presence users; TEAMMATE alone tells the whole sharing story.
export const OWNER: PresenceUser = { clientId: `demo-owner`, email: `ada@acme.dev`, name: `Ada Lovelace`, role: `owner`, idle: false, view: `workspace` };
export const TEAMMATE: PresenceUser = {
    clientId: `demo-mate`,
    email: `grace@acme.dev`,
    name: `Grace Hopper`,
    role: `collaborator`,
    idle: true,
    view: `agents`,
};
