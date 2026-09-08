import type { AgentChangesResponse } from "@intentic/api-contract";
import { router } from "../..";
import { agentChangesKey, agentFileDiffQuery, fetchAgentChanges } from "../../../features/agents/review/useAgentChanges";
import { unregistered } from "../../../features/agents/fleet/agentStatus";
import { useAgents } from "../../../features/agents/fleet/useAgents";
import { type FleetAgent, windowFinished } from "../../../features/agents/fleet/useAgents-fleet";
import { agentTranscriptQuery } from "../../../features/chat/transcript/agentTranscript";
import { useChat } from "../../../features/chat/run/useChat";
import { queryClient } from "../../../lib/queryPersistence";
import type { WarmBand, WarmTask } from "../warmPlan";
import { warmQuery } from "../warmQuery";
import { reviewsToRead, type ReviewToRead } from "./reviewsToRead";

// Warms each board card's transcript and changes before the click, for the cards visible on /agents
// (windowFinished's window) in board order: attention, active, then finished; transcript before changes.
// Skips cards with no registry entry (unregistered), since the daemon does not know their ids.

// Caps board cards warmed; two reads each, kept well under the plan's cap so it can't crowd out review diffs.
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

// Rows for a review whose list is already in hand, warmed the beat after it lands. A card with no
// changes contributes nothing. Which reviews to warm is reviewsToRead's job.
const reviewRowWishes = ({ agentId, band, rows }: ReviewToRead): readonly WarmTask[] => {
    const held = queryClient.getQueryData<AgentChangesResponse>(agentChangesKey(agentId));
    return (held?.repos ?? [])
        .flatMap((group) => group.changes.map((change) => ({ repo: group.repo, path: change.path })))
        .slice(0, rows)
        .map((row) => warmQuery(`agent:${agentId}:diff:${row.repo}:${row.path}`, band, agentFileDiffQuery(agentId, row.repo, row.path)));
};

// The open agent's id, if the current route is one.
const openAgentId = (): string | undefined => {
    const route = router.currentRoute.value;
    return route.name === `agent` ? String(route.params[`id`] ?? ``) : undefined;
};

// Agents whose completed turn is `landed`: the diff now lives as workspace changes, which is what gets
// read ahead. `ready` (held on the branch, auto-land off) is excluded; that review is the only place it can be read.
const landedAgents = (board: readonly (readonly FleetAgent[])[]): ReadonlySet<string> =>
    new Set(
        board
            .flat()
            .filter((agent) => agent.status === `landed`)
            .map((agent) => agent.id),
    );

export const agentsWarmSource = (): readonly WarmTask[] => {
    const board = lanes.value;
    // The focused card gets `now`: it's on screen, and finished-window pinning must agree with the lane.
    const focused = active.value.conversationId;
    const finished = windowFinished(board.finished, focused, (agent) => agent.id).shown;
    const cards = [...board.attention, ...board.active, ...finished]
        .filter((agent) => !unregistered(agent.status))
        .slice(0, MAX_CARDS)
        .flatMap((agent) => wishesFor(agent, agent.id === focused));
    // Review rows come first: within a band, source order decides, and an open review outranks the card list.
    const reviews = reviewsToRead(
        openAgentId(),
        focused,
        board.attention.filter((agent) => !unregistered(agent.status)).map((agent) => agent.id),
        landedAgents([board.attention, board.active, board.finished]),
    ).flatMap(reviewRowWishes);
    return [...reviews, ...cards];
};
