import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { AgentActivity, AgentAttention, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { HomeSandbox } from "../fixture/home/sandboxes";
import { homeRecording } from "../mode";

// THE HOME CARD, SANDBOX BY SANDBOX. The home conversation is one card in the roster, but each of the home recording's
// sandboxes plays a turn of its own in it (fixture/home/), so each sandbox's board is served its own copy of that card:
// running while its turn runs, naming the step it is on, raised while it asks something. The chat's status line reads the
// step from here (ChatTurnStatus.vue), as it reads it from the daemon's registry.

interface HomeTurnCard {
    readonly status: AgentSummary[`status`];
    readonly updatedAt: number;
    readonly startedAt?: number;
    readonly activity?: AgentActivity;
    readonly attention: AgentAttention;
    readonly subagents?: { readonly running: number; readonly total: number };
}

const CALM: AgentAttention = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

const cards = new Map<HomeSandbox, HomeTurnCard>();

/** The card as the sandbox asked sees it: its own home turn laid over the roster's home card. */
export const homeCardOf = (agent: AgentSummary, sandbox: HomeSandbox): AgentSummary => {
    const card = homeRecording && isHomeConversationId(agent.id) ? cards.get(sandbox) : undefined;
    if (card === undefined) {
        return agent;
    }
    const { activity: _was, subagents: _before, ...rest } = agent;
    const next: AgentSummary = { ...rest, status: card.status, updatedAt: card.updatedAt, attention: card.attention };
    if (card.startedAt !== undefined) {
        next.startedAt = card.startedAt;
    }
    if (card.activity !== undefined) {
        next.activity = card.activity;
    }
    if (card.subagents !== undefined) {
        next.subagents = card.subagents;
    }
    return next;
};

// What one event of the turn does to the card, as the daemon's registry derives it; undefined for an event that moves nothing.
const after = (card: HomeTurnCard, event: AgentEvent, now: number): HomeTurnCard | undefined => {
    switch (event.kind) {
        case `init`:
            return { status: `running`, updatedAt: now, startedAt: now, attention: CALM };
        case `tool_call`: {
            const activity: AgentActivity = { tool: event.name };
            if (event.target !== undefined) {
                activity.target = event.target;
            }
            return { ...card, updatedAt: now, activity };
        }
        case `subagent`: {
            const subagents = card.subagents ?? { running: 0, total: 0 };
            return { ...card, subagents: { running: subagents.running + 1, total: subagents.total + 1 } };
        }
        case `subagent_update`:
            return event.status === `completed` && card.subagents !== undefined
                ? { ...card, subagents: { ...card.subagents, running: Math.max(0, card.subagents.running - 1) } }
                : undefined;
        case `question`:
            return { ...card, status: `awaiting`, updatedAt: now, attention: { ...CALM, question: true } };
        case `resolved`:
            return { ...card, status: `running`, updatedAt: now, attention: CALM };
        case `done`: {
            // What it was doing goes with the turn; what it started stays counted.
            const { activity: _done, startedAt: _started, ...kept } = card;
            return { ...kept, status: `idle`, updatedAt: now, attention: CALM };
        }
        default:
            return undefined;
    }
};

/** Follows one event of a sandbox's home turn onto its card; whether the card changed, for the caller to broadcast. */
export const followHomeTurn = (sandbox: HomeSandbox, event: AgentEvent, now: number): boolean => {
    const next = after(cards.get(sandbox) ?? { status: `idle`, updatedAt: now, attention: CALM }, event, now);
    if (next !== undefined) {
        cards.set(sandbox, next);
    }
    return next !== undefined;
};
