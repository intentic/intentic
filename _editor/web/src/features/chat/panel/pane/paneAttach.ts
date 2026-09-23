import { computed, onBeforeUnmount, type Ref, watch } from "vue";
import { turnInFlight } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { registry } from "../../../agents/fleet/useAgents-registry";
import { hydrateOnce } from "../../run/useChat-sessions";
import type { Conversation } from "../../session/conversation";

// What keeps a pane attached to the chat it shows: the typewriter runs in the focused pane alone, and a chat the daemon
// hadn't created when the pane first read it hydrates once the roster says it exists, or that its turn moved.

export interface PaneAttachHost {
    readonly conversation: () => Conversation;
    // Only the focused pane animates its transcript.
    readonly focused: () => boolean;
    readonly streaming: Readonly<Ref<boolean>>;
}

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
    // The daemon's own entry wherever it has one, never the card a press drew ahead of it (useAgents-provisional): that
    // drawing is not a turn to attach to. Primitive-valued, so only an actual transition fires the watch below.
    const fleetTurn = computed<boolean | undefined>(() => {
        const id = pane.conversation().conversationId;
        const agent = registry.value.find((entry) => entry.id === id) ?? agentById(id);
        return agent === undefined ? undefined : turnInFlight(agent);
    });
    // Whether this pane streamed the turn the roster is about to settle: its transcript already has the result.
    let streamedTurn = false;
    watch(pane.streaming, (live) => {
        if (live) {
            streamedTurn = true;
        }
    });
    // A one-shot read never retries, so the roster's transitions are what tells a non-streaming pane to hydrate;
    // off the roster (undefined) changes nothing.
    watch(fleetTurn, (now, before) => {
        if (before === true && now === false && streamedTurn) {
            streamedTurn = false;
            return;
        }
        if (now === undefined || pane.streaming.value) {
            return;
        }
        if (now) {
            // A turn this pane is not streaming just began: whatever the flag remembers is about an older one.
            streamedTurn = false;
        }
        const chat = pane.conversation();
        // Being on the roster is the registration fact: heals a tab whose early probe read 'unknown agent' as final.
        chat.registered.value = true;
        hydrateOnce(chat);
    });
};
