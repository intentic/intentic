import type { AgentSummary } from "@intentic/sandbox-contract";
import { computed, onBeforeUnmount, type Ref, watch } from "vue";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import { registry } from "../../../agents/fleet/useAgents-registry";
import { otherBoxes } from "../../../sandbox/live/fleetAcross";
import { hydrateOnce } from "../../run/useChat-sessions";
import type { Conversation } from "../../session/conversation";
import { newerQueue } from "../../session/turnClient";

// What keeps a pane attached to the chat it shows: the typewriter runs in the focused pane alone; a chat the daemon hadn't
// created when the pane first read it hydrates once the roster says it exists, or that its turn moved; and the chat's
// queue, which is the daemon's, is read off its card for the composer to show.

export interface PaneAttachHost {
    readonly conversation: () => Conversation;
    // Only the focused pane animates its transcript.
    readonly focused: () => boolean;
    readonly streaming: Readonly<Ref<boolean>>;
}

// A turn read off a card, primitive-valued so only a real change fires a watch: off the roster, nothing in flight (false),
// in flight with no run (true: a booked resume, a land), or the run it names, which tells a queue's or a resume pass's
// next turn from the one before it even when the card never read as settled in between.
type CardTurn = string | boolean | undefined;

const inFlight = (turn: CardTurn): boolean => turn !== undefined && turn !== false;

export const usePaneAttach = (pane: PaneAttachHost): void => {
    // An effect rather than a mount step, since a pane's conversation and focus both move: the chat it leaves must stop
    // animating there (TranscriptClock.watched).
    watch(
        [pane.conversation, pane.focused],
        ([chat, focused], previous) => {
            const left = previous?.[0];
            if (left !== undefined && left !== chat) {
                left.transcript.watched.value = false;
            }
            chat.transcript.watched.value = focused;
        },
        { immediate: true },
    );
    // A pane that goes away (a split closed, the panel docked) leaves nothing claiming to be watched.
    onBeforeUnmount(() => (pane.conversation().transcript.watched.value = false));

    const { agentById } = useAgents();
    // The daemon's own card for the chat: this box's roster, or the polled one of the box the chat lives in; never the
    // card a press drew ahead of it (useAgents-provisional), which is not a turn to attach to.
    const card = computed<FleetAgent | AgentSummary | undefined>(() => {
        const chat = pane.conversation();
        const box = chat.box.value;
        if (box !== undefined) {
            return otherBoxes.value.find((entry) => entry.sandbox.id === box)?.agents.find((agent) => agent.id === chat.conversationId);
        }
        return registry.value.find((entry) => entry.id === chat.conversationId) ?? agentById(chat.conversationId);
    });
    const fleetTurn = computed<CardTurn>(() => {
        const agent = card.value;
        if (agent === undefined) {
            return undefined;
        }
        return turnInFlight(agent) ? (agent.run ?? true) : false;
    });
    // The queue as the card shows it, never older than what this window's own changes were answered with.
    watch(
        () => card.value?.queue,
        (queue) => {
            const chat = pane.conversation();
            chat.queue.value = newerQueue(chat.queue.value, queue);
        },
        { immediate: true },
    );
    // Whether this pane streamed the turn the roster is about to settle: its transcript already has the result.
    let streamedTurn = false;
    watch(pane.streaming, (live) => {
        if (live) {
            streamedTurn = true;
            return;
        }
        // The pane's own stream ended while the card already names a run: one the queue started behind it, which the
        // card announced while this pane was still busy with the last. A booked resume names none, so it waits.
        if (typeof fleetTurn.value === `string`) {
            hydrateOnce(pane.conversation());
        }
    });
    // A one-shot read never retries, so the roster's transitions are what tells a non-streaming pane to hydrate;
    // off the roster (undefined) changes nothing, and neither does a run settling into a booked resume.
    watch(fleetTurn, (now, before) => {
        const wasInFlight = inFlight(before);
        if (wasInFlight && now === false && streamedTurn) {
            streamedTurn = false;
            return;
        }
        if (now === undefined || pane.streaming.value || (wasInFlight && now === true)) {
            return;
        }
        if (typeof now === `string`) {
            // A run this pane is not streaming just began: whatever the flag remembers is about an older one.
            streamedTurn = false;
        }
        const chat = pane.conversation();
        // Being on the roster is the registration fact: heals a tab whose early probe read 'unknown agent' as final.
        chat.registered.value = true;
        hydrateOnce(chat);
    });
};
