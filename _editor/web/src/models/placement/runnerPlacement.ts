import { useChat } from "../conversations/run/useChat";
import { agentById, fleet } from "../fleet/useAgents-fleet";

// WHERE A CONVERSATION RUNS, for the live views of one that runs on a runner (models/runners/runnerViews.ts): the runner
// a conversation is on, and a conversation through which a view of something no conversation owns (a runner's desktop,
// a window nobody opened) is asked for.

/** A conversation placed on this runner, never an archived one. */
export const conversationOnRunner = (
    runner: string,
    agents: readonly { readonly id: string; readonly runner?: string | undefined; readonly archivedAt?: number | undefined }[],
): string | undefined => agents.find((agent) => agent.runner === runner && agent.archivedAt === undefined)?.id;

/** The same, over the live roster. */
export const rosterConversationOn = (runner: string): string | undefined => conversationOnRunner(runner, fleet.value);

/**
 * The runner a conversation runs on, or undefined for one that runs here. The roster's word first: a conversation's own
 * `runner` is only its placement before its first turn (composerControls.ts).
 */
export const runnerOf = (conversationId: string | undefined): string | undefined =>
    conversationId === undefined
        ? undefined
        : (agentById(conversationId)?.runner ?? useChat().conversations.value.find((open) => open.conversationId === conversationId)?.runner.value);
