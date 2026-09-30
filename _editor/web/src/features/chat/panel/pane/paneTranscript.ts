import { useLoadingReveal } from "@intentic/ui/loading-reveal";
import { computed, type Ref } from "vue";
import { type ChatDeliverable, deliverablesByTurn } from "../../transcript/deliverables/deliverables";
import type { TranscriptRefresh } from "../../session/transcriptView";
import { attachedPaths, type ChatShot, shotsByTurn } from "../../transcript/shots/shots";
import {
    type ChatMessage,
    type ChatTurn,
    type ChecklistView,
    checklistViewsOf,
    cutsAboveOf,
    dayMarksOf,
    forkCutsOf,
    liveBubbleOf,
    repeatedChecklistIds,
    turnsOf,
} from "../../transcript/transcript";

// The transcript as one pane draws it: turns, the live bubble, each turn's pictures and documents, fork cuts, day marks,
// the skeleton.

// What the pane reads of its conversation to draw it.
export interface PaneTranscriptHost {
    readonly messages: Readonly<Ref<readonly ChatMessage[]>>;
    readonly streaming: Readonly<Ref<boolean>>;
    // A person ended the live turn (ConversationView.ending): nothing is being written any more, whatever still unwinds.
    readonly ending: Readonly<Ref<string | undefined>>;
    readonly awaitingDecision: Readonly<Ref<boolean>>;
    // Runs drawn unfolded, which already show every picture their cards hold.
    readonly showToolCalls: Readonly<Ref<boolean>>;
    // This conversation's transcript read, in flight with nothing painted; keyed by the conversation, so a tab switch
    // drops its skeleton at once.
    readonly loading: Ref<boolean>;
    readonly conversationId: Ref<string>;
    // The agents list saying this chat is mid-turn or parked on a person: it owes rows even while none has arrived.
    readonly rowsOwed: Readonly<Ref<boolean>>;
    // How the last read of this chat went, when it has not answered (TranscriptView.refresh).
    readonly refresh: Readonly<Ref<TranscriptRefresh | undefined>>;
}

export const usePaneTranscript = (pane: PaneTranscriptHost) => {
    const { messages, streaming, ending, awaitingDecision } = pane;
    // The bubble this turn writes into, if any (liveBubbleOf); recomputed per frame, scanning only the tail.
    const liveBubble = computed(() => liveBubbleOf(messages.value));
    // Settled turns come back as the same objects frame to frame (turnsOf's `previous`), so a streamed reply redraws its own
    // turn, not every turn above it.
    const turns = computed<ChatTurn[]>((previous) => turnsOf(messages.value, previous));
    // A turn whose pictures didn't change keeps its array (shotsByTurn), so a settled strip isn't redrawn per paint.
    const attached = computed(() => attachedPaths(messages.value));
    const turnShots = computed<ReadonlyMap<number, readonly ChatShot[]>>((previous) => shotsByTurn(turns.value, attached.value, previous));
    // Same reuse for each turn's documents (deliverablesByTurn).
    const turnDeliverables = computed<ReadonlyMap<number, readonly ChatDeliverable[]>>((previous) => deliverablesByTurn(turns.value, previous));
    // The turn still being written, if any; a card it parked on is the reader's move, so that turn's pictures show.
    const writingTurn = computed(() => (streaming.value && ending.value === undefined && !awaitingDecision.value ? turns.value.at(-1)?.id : undefined));
    const repeatedChecklists = computed(() => repeatedChecklistIds(messages.value));
    // Loading as the pane draws it: a read in flight over nothing painted, or rows the agents list says this chat owes that
    // no failed read has given up on (a read that failed says so, with a press to ask again). Never the invitation to
    // start a conversation: running chats opened on that after a phone woke, until the app was relaunched.
    const waiting = computed(
        () =>
            pane.loading.value ||
            (pane.rowsOwed.value && messages.value.length === 0 && !streaming.value && pane.refresh.value?.kind !== `failed`),
    );

    return {
        turns,
        turnShots,
        repeatedChecklists,
        // True for the assistant bubble currently being streamed into.
        isStreaming: (message: ChatMessage): boolean => streaming.value && liveBubble.value?.id === message.id,
        // A sent turn before its first frame, drawn at the column's foot; a parked card is the prompt, not idle work, unless
        // a person ended the turn, which the line then says.
        showTurnStatus: computed(
            () => streaming.value && (!awaitingDecision.value || ending.value !== undefined) && liveBubble.value === undefined,
        ),
        // A turn's strip, once it has stopped writing and only while runs are folded: unfolded cards draw every picture.
        stripOf: (turn: ChatTurn): readonly ChatShot[] | undefined => {
            const shots = turnShots.value.get(turn.id);
            return pane.showToolCalls.value || turn.id === writingTurn.value || shots === undefined || shots.length === 0 ? undefined : shots;
        },
        // A turn's documents, once it has stopped writing them: a file still being written is not one to open yet. Drawn
        // folded or unfolded, since a card names a file where it was written and this is the turn's whole list.
        deliverablesOf: (turn: ChatTurn): readonly ChatDeliverable[] | undefined => {
            const deliverables = turnDeliverables.value.get(turn.id);
            return turn.id === writingTurn.value || deliverables === undefined || deliverables.length === 0 ? undefined : deliverables;
        },
        // How each surviving checklist snapshot draws: the list once per turn, then only what moved.
        checklistViews: computed<Map<number, ChecklistView>>((previous) => checklistViewsOf(turns.value, repeatedChecklists.value, previous)),
        // The date named above the first turn sent on a given day, so each prompt's own stamp shrinks to the clock.
        dayMarks: computed(() => dayMarksOf(turns.value)),
        // What a fork below each turn inherits, built as one index since `turns` rebuilds every streaming paint.
        forkCuts: computed(() => forkCutsOf(turns.value)),
        // The boundaries that index doesn't cover, keyed by the message each sits above: folded messages, the first.
        cutsAbove: computed(() => cutsAboveOf(turns.value)),
        // Gated, so a warm daemon's fast answer paints no placeholder; without one a load reads as data loss.
        skeleton: useLoadingReveal(waiting, pane.conversationId),
        // Whether anything is still on its way, the empty chat's words held back meanwhile.
        waiting,
        // What is said beside a painted chat about a read that has not answered: the saved copy is what shows. A live
        // stream is fresher than either, so it says nothing then.
        staleness: computed(() => (messages.value.length === 0 || streaming.value ? undefined : pane.refresh.value)),
    };
};
