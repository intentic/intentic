import type { Logger } from "pino";
import { awaitingWake } from "../../../conversations/actor/conversation-state.js";
import type { HeldCards } from "../../../guard/held-cards.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import type { SteeringQueue } from "../../checkpoints/agent-steering.js";
import { adoptBackgroundJobs } from "../../tools/jobs/background-adoption.js";
import { resolveTurnJobs } from "../../tools/jobs/job-fates.js";

// Close in order: hush steering into the next-turn queue, judge leftover jobs once, then arm watches for awaited/unread exits.
// Park on held cards until settled (stop cancels); conversation state, not later guesses, decides awaitingWake.
// Land only clean endings with no wake pending, under the lease; regenerate derived files afterward in the destination tree.
// Settle placement then actor, publish PlacedTurnEnding once, and only then announce run.settled to independent listeners.

// How a turn ended, as its close decided it: an error, a stop, waiting on a wake it armed, or finished.
export type PlacedTurnEnding = "failed" | "stopped" | "awaiting-wake" | "finished";

// Steps 1 to 3, bound to one conversation's turn; placedTurn runs them once, before its land or in its finally.
export interface TurnCloser {
    readonly hush: () => void;
    // Answers whether the conversation now awaits a wake. `failed`: the turn was cut off (an error frame or a throw)
    // rather than ended, so what it left running is nobody's choice to wait on.
    readonly armWakes: (ending?: { readonly failed: boolean }) => Promise<boolean>;
}

export interface TurnCloserDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send" | "state">;
    readonly heldCards: Pick<HeldCards, "hold">;
    readonly scanPorts: () => Promise<readonly ListeningPort[]>;
    readonly logger: Logger;
}

// `signal` is the turn's own: a stop while the close holds for a card cancels the card.
export const turnCloser = (deps: TurnCloserDeps, conversationId: string, steering: SteeringQueue | undefined, signal?: AbortSignal): TurnCloser => ({
    hush: () => steering?.close(),
    armWakes: async (ending = { failed: false }) => {
        await resolveTurnJobs(deps, conversationId, { clean: !ending.failed });
        await deps.heldCards.hold(conversationId, signal);
        // A job that exited before its watch armed wakes the conversation at once: a wake already on its way.
        const handed = await adoptBackgroundJobs(deps.conversations, conversationId, deps.logger, { cut: ending.failed });
        const state = deps.conversations.state(conversationId);
        return handed > 0 || (state !== undefined && awaitingWake(state));
    },
});
