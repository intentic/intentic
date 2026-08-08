import type { AgentChangesResponse } from "@intentic-app/api-contract";
import { router } from "../../../router";
import { agentChangesKey, agentFileDiff, agentFileDiffKey, fetchAgentChanges } from "../../agents/useAgentChanges";
import { unregistered } from "../../agents/agentStatus";
import { type FleetAgent, useAgents, windowFinished } from "../../agents/useAgents";
import { agentTranscript, agentTranscriptKey } from "../../chat/agentTranscript";
import { useChat } from "../../chat/useChat";
import { queryClient } from "../../queryPersistence";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";

/* THE BOARD'S WISH LIST — every card on /agents, with the two reads that stand between clicking it and reading
 * it already made.
 *
 * Opening an agent costs two round trips today, and both are paid at the click: its TRANSCRIPT (the daemon's
 * record of the conversation, which is the only copy for every agent this device did not itself start — a
 * workflow step, an automation's wake, a turn sent from a phone) and its CHANGES (the file list the review
 * opens on). Between them that is a blank pane for as long as the tunnel takes, on the app's most-clicked
 * gesture. Both are cached reads, so warming them is simply making them early.
 *
 * WHICH CARDS: the ones on the board, and no others. The Finished lane collapses everything past its window
 * behind a "N earlier" row, so this walks the same window the lane draws (windowFinished — shared with the
 * lane itself, because a wish list that disagreed with the board about which cards are visible would be warming
 * the ones the user cannot see). Archived agents are not on the board at all and are not here either.
 *
 * WHICH ORDER: attention first, then active, then the finished window — the board's own reading order, left to
 * right, because reading ahead in a different order than the lanes are drawn in warms the cards the user
 * reaches last. Per card the transcript comes before the changes: clicking a card opens its conversation, and
 * only the review affordance opens the diff.
 *
 * A CARD WITH NO REGISTRY ENTRY IS SKIPPED. Drafts, refused sends and conversations reopened from history are
 * this browser's own cards (agentStatus' `unregistered`); the daemon has never heard of their ids, so both
 * reads would 404. */

// The board's card count is bounded by nothing but the sandbox's history, and a fleet that has been running for
// a week is a real thing. Past this the tail is cold, which costs exactly what opening any card cost before any
// of this existed. Two reads per card, so this is ~80 wishes at full stretch — well inside the plan's own cap,
// deliberately, because the board must not be able to crowd the review's diffs out of the plan entirely.
const MAX_CARDS = 40;

// And how far down ONE agent's review the rows are warmed — the same bound, and the same reasoning, as the
// workspace review's (changesWarm's WARM_LIMIT).
const MAX_REVIEW_ROWS = 30;

const { lanes } = useAgents();
const { active } = useChat();

const wishesFor = (agent: FleetAgent, focused: boolean): readonly WarmTask[] => {
    const band: WarmBand = focused ? `now` : `near`;
    return [
        warmQuery(`agent:${agent.id}:transcript`, band, agentTranscriptKey(agent.id), () => agentTranscript(agent.id)),
        warmQuery(`agent:${agent.id}:changes`, band, agentChangesKey(agent.id), () => fetchAgentChanges(agent.id)),
    ];
};

/* THE REVIEW THE USER IS ACTUALLY STANDING IN — one agent's rows, warmed the way the workspace review's are.
 *
 * Only for the agent whose page is open, and only from the file list already in hand: a board of forty cards
 * times their files would be thousands of two-file reads, which is the burst this whole engine exists not to
 * be. The list itself is warmed for every card above; the rows behind it are warmed for the one being read. */
const openReviewWishes = (): readonly WarmTask[] => {
    const route = router.currentRoute.value;
    const agentId = route.name === `agent` ? String(route.params[`id`] ?? ``) : ``;
    if (agentId === ``) {
        return [];
    }
    const held = queryClient.getQueryData<AgentChangesResponse>(agentChangesKey(agentId));
    return (held?.repos ?? [])
        .flatMap((group) => group.changes.map((change) => ({ repo: group.repo, path: change.path })))
        .slice(0, MAX_REVIEW_ROWS)
        .map((row) =>
            warmQuery(`agent:${agentId}:diff:${row.repo}:${row.path}`, `now`, agentFileDiffKey(agentId, row.repo, row.path), () =>
                agentFileDiff(agentId, row.repo, row.path),
            ),
        );
};

export const agentsWarmSource = (): readonly WarmTask[] => {
    const board = lanes.value;
    /* The card the chat is pointing at gets the `now` band — it is not "one click away", it is the thing on
     * screen, and its review is one press from where the user's hand already is. It is also the card the
     * finished window pins rather than culls, for the same reason, so passing it here keeps this list and the
     * lane agreeing about what is visible. */
    const focused = active.value.conversationId;
    const finished = windowFinished(board.finished, focused, (agent) => agent.id).shown;
    const cards = [...board.attention, ...board.active, ...finished]
        .filter((agent) => !unregistered(agent.status))
        .slice(0, MAX_CARDS)
        .flatMap((agent) => wishesFor(agent, agent.id === focused));
    // The open review's rows come FIRST in the list, not because the plan is ordered by position (it is ordered
    // by band) but because within a band the source's own order decides — and the review on screen is nearer
    // than the card list behind it.
    return [...openReviewWishes(), ...cards];
};
