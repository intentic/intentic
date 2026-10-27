import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { broadcastRoster, patchAgent, roster } from "./roster";

// Cards for the conversations the demo's own machinery starts (a fired automation, a workflow's steps), put on the board
// and pushed to every open window the way the daemon's registry announces a new conversation.

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false } as const;

interface WorkSpec {
    readonly id: string;
    readonly title: string;
    readonly now: number;
    readonly startIn?: string | undefined;
    readonly todo?: string | undefined;
    readonly extra?: Partial<AgentSummary> | undefined;
}

/** A conversation that has just started its first turn on the owner's Claude account. */
export const workCard = ({ id, title, now, startIn = `web`, todo, extra }: WorkSpec): AgentSummary => ({
    id,
    startIn,
    sessionId: `ses_${id.replaceAll(/[^a-z0-9]/giu, ``).slice(-12)}`,
    title,
    status: `running`,
    provider: `claude`,
    harness: `claude-code`,
    model: `claude-sonnet-5`,
    effort: `high`,
    account: `acc_claude_demo`,
    branch: `agent/${id}`,
    base: `4f1c8ab`,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    contextWindow: 200_000,
    activity: { tool: `Read`, target: `${startIn}/README.md`, todo: todo ?? title },
    startedAt: now,
    updatedAt: now,
    seenAt: now,
    attention: NO_ATTENTION,
    turns: 1,
    toolUses: 0,
    ...extra,
});

/** Puts a card at the head of the board (replacing one with the same id) and announces the new roster. */
export const putCard = (card: AgentSummary): void => {
    roster.agents = [card, ...roster.agents.filter((agent) => agent.id !== card.id)];
    broadcastRoster();
};

/** A card's turn ended: idle with what it spent, the way a finished turn reads on the board. */
export const finishCard = (id: string, now: number, costUsd: number): void => {
    patchAgent(id, { status: `idle`, updatedAt: now, costUsd, inputTokens: Math.round(costUsd * 90_000), outputTokens: Math.round(costUsd * 9_000), activity: undefined });
};
