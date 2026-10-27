import type { GroupSamples } from "./context.ts";

export const agentSamples: GroupSamples<`agent`> = ({ fleet, held, now }) => ({
    run: { prompt: `What does this workspace do?`, conversationId: `smoke-run` },
    attach: { conversationId: fleet.FEATURED_AGENT_ID },
    reply: { kind: `plan`, requestId: `smoke`, approve: true },
    steer: { conversationId: fleet.FEATURED_AGENT_ID, text: `Keep going.` },
    stop: { conversationId: `smoke-run`, live: true },
    // The scheduled card's one message, through each door in turn: reworded, re-timed by name to wait on the running
    // checkout agent, taken back, and the emptied queue let go.
    queueEdit: { conversationId: fleet.SCHEDULED_AGENT_ID, id: fleet.SCHEDULED_MESSAGE_ID, revision: 1, text: `Reworded by the smoke run` },
    queueSchedule: { conversationId: fleet.SCHEDULED_AGENT_ID, sendAfter: fleet.FEATURED_AGENT_ID, ids: [fleet.SCHEDULED_MESSAGE_ID] },
    queueRemove: { conversationId: fleet.SCHEDULED_AGENT_ID, id: fleet.SCHEDULED_MESSAGE_ID, revision: 2 },
    queueResume: { conversationId: fleet.SCHEDULED_AGENT_ID },
    // The held card's message moved to another pick, and its conversation to the account it already runs on.
    queueReroute: { conversationId: fleet.HELD_AGENT_ID, routing: { agent: `codex`, harness: `native`, model: `gpt-5.2-codex` } },
    switchAccount: { conversationId: fleet.HELD_AGENT_ID, account: `acc_claude_demo` },
    // A Continue booked for an hour from now on the soft-deletes card, then the held card sent again.
    queueContinue: { conversationId: fleet.REVIEW_AGENT_ID, sendAt: now + 3_600_000 },
    chooseHandoff: { conversationId: fleet.HELD_AGENT_ID, handoff: `trim` },
    resume: { conversationId: fleet.HELD_AGENT_ID },
    rewind: { conversationId: fleet.REVIEW_AGENT_ID, index: 0, messageId: `msg_${fleet.REVIEW_AGENT_ID}_0` },
    routeChat: { prompt: `Reply to the refund ticket from Berlin`, paths: [], model: true, persona: true },
    commands: {},
    refusals: undefined,
});
