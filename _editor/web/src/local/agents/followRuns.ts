import { watch } from "vue";
import { hydrateOnce } from "../../models/conversations/run/useChat-sessions";
import { conversations } from "../../models/conversations/tabs/useChat-tabs";
import { useAgents } from "../../models/fleet/useAgents";

// A TURN THE SIDECAR STARTED BY ITSELF, FOLLOWED (2026-11-24). On this computer nothing holds a queue: what the reader
// said while a turn ran goes out as the next turn the moment that one ends, a stop or a failure included. A sandbox
// holds the queue after a stop until a press lets it go, so the chat follows a queued turn only behind one that ran to
// its own end (turnClient.ts `followQueued`), and after a stop here the next turn ran unseen until a reload. Two things
// say such a turn exists, and an open chat that is not streaming acts on either:
//
// - the roster names the run a conversation is on: the chat attaches to it (TurnClient.attachLive, which stands down
//   for a run this window already saw end);
// - the chat's own turn ended stopped or failed: the record is read again, which follows whatever run is live by then
//   and paints one that already ended (a short turn is over before any roster frame names it).

/** The run each conversation's card names, as one string to watch: changes exactly when one starts or ends. */
export const runsOf = (cards: readonly { readonly id: string; readonly run?: string | undefined }[]): string =>
    cards.map((card) => `${card.id}=${card.run ?? ``}`).join(`\n`);

/** Whether a turn that just ended left the record worth reading again: it was stopped, or it failed. */
export const endedShort = (ended: { readonly stopped: boolean; readonly failed: boolean }): boolean => ended.stopped || ended.failed;

/** Follows, in every open chat of this window, a turn the sidecar started without this window asking for it. */
export const useFollowComputerRuns = (): void => {
    const { fleet, agentById } = useAgents();
    watch(
        () => runsOf(fleet.value),
        () => {
            for (const conversation of conversations.value) {
                const run = agentById(conversation.conversationId)?.run;
                if (run !== undefined && !conversation.turn.streaming.value) {
                    void conversation.turn.attachLive(run);
                }
            }
        },
    );
    watch(
        () => conversations.value.filter((conversation) => conversation.turn.streaming.value).map((conversation) => conversation.conversationId),
        (streaming, before) => {
            for (const conversation of conversations.value) {
                const justEnded = before.includes(conversation.conversationId) && !streaming.includes(conversation.conversationId);
                if (justEnded && endedShort({ stopped: conversation.pickUp.value !== undefined, failed: conversation.error.value !== null })) {
                    hydrateOnce(conversation);
                }
            }
        },
    );
};
