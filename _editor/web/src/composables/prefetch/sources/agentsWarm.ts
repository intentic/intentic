import type { AgentChangesResponse } from "@intentic-app/api-contract";
import { router } from "../../../router";
import { agentChangesKey, agentFileDiffQuery, fetchAgentChanges } from "../../agents/useAgentChanges";
import { unregistered } from "../../agents/agentStatus";
import { type FleetAgent, useAgents, windowFinished } from "../../agents/useAgents";
import { agentTranscriptQuery } from "../../chat/agentTranscript";
import { useChat } from "../../chat/useChat";
import { queryClient } from "../../queryPersistence";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";
import { reviewsToRead, type ReviewToRead } from "./reviewsToRead";

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

const { lanes } = useAgents();
const { active } = useChat();

const wishesFor = (agent: FleetAgent, focused: boolean): readonly WarmTask[] => {
    const band: WarmBand = focused ? `now` : `near`;
    return [
        warmQuery(`agent:${agent.id}:transcript`, band, agentTranscriptQuery(agent.id)),
        warmQuery(`agent:${agent.id}:changes`, band, { queryKey: agentChangesKey(agent.id), queryFn: () => fetchAgentChanges(agent.id) }),
    ];
};

/* ONE REVIEW'S ROWS — the read that works out the +/− the review prints beside each file with the comments taken
 * out (useCodeStats), and therefore the read that decides whether those numbers are TRUE when the page opens. It
 * used to be declared for the open page alone, and the arithmetic of that was hopeless: the reader lands, the walk
 * starts, and the numbers arrive over the following seconds into a list that is being scanned right then. Warming a
 * review after its reader has arrived is warming the wrong thing — WHICH reviews are read ahead of that, and how
 * near each is, is reviewsToRead.
 *
 * Only ever from a list already in hand: the rows follow on the beat after their list lands, never before it. A card
 * with no changes contributes nothing. */
const reviewRowWishes = ({ agentId, band, rows }: ReviewToRead): readonly WarmTask[] => {
    const held = queryClient.getQueryData<AgentChangesResponse>(agentChangesKey(agentId));
    return (held?.repos ?? [])
        .flatMap((group) => group.changes.map((change) => ({ repo: group.repo, path: change.path })))
        .slice(0, rows)
        .map((row) => warmQuery(`agent:${agentId}:diff:${row.repo}:${row.path}`, band, agentFileDiffQuery(agentId, row.repo, row.path)));
};

// The page the reader is on, when it is an agent's.
const openAgentId = (): string | undefined => {
    const route = router.currentRoute.value;
    return route.name === `agent` ? String(route.params[`id`] ?? ``) : undefined;
};

/* WHOSE WORK IS ALREADY IN THE USER'S TREE. `landed` is the status the auto-land flow flips a cleanly-completed
 * turn to within ms of it ending (agentStatus' laneOf), and it means exactly what reviewsToRead needs it to: the
 * delta is sitting in the workspace as uncommitted changes, so the workspace review is reading the same files —
 * differently, and it is the one being read ahead. `ready` is deliberately NOT here: that is work HELD on the
 * branch because auto-land is off, so this review is the only place it can be read at all. */
const landedAgents = (board: readonly (readonly FleetAgent[])[]): ReadonlySet<string> =>
    new Set(
        board
            .flat()
            .filter((agent) => agent.status === `landed`)
            .map((agent) => agent.id),
    );

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
    /* The reviews' rows come FIRST in the list, not because the plan is ordered by position (it is ordered by band)
     * but because within a band the source's own order decides — and a review that is open, or one press away, is
     * nearer than the card list behind it. Which reviews those are needs the lanes, which is why it is worked out
     * here and not above. */
    const reviews = reviewsToRead(
        openAgentId(),
        focused,
        board.attention.filter((agent) => !unregistered(agent.status)).map((agent) => agent.id),
        landedAgents([board.attention, board.active, board.finished]),
    ).flatMap(reviewRowWishes);
    return [...reviews, ...cards];
};
