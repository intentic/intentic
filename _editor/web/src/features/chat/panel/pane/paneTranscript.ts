import { useLoadingReveal } from "@intentic/ui/loading-reveal";
import { computed, type Ref } from "vue";
import { attachedPaths, type ChatShot, shotsByTurn } from "../../transcript/shots/shots";
import {
    type ChatMessage,
    type ChatTurn,
    checklistViewsOf,
    cutsAboveOf,
    dayMarksOf,
    forkCutsOf,
    liveBubbleOf,
    repeatedChecklistIds,
    turnsOf,
} from "../../transcript/transcript";

// The transcript as one pane draws it: prompt-headed turns, the bubble a live turn writes into, what each turn's
// tools showed the agent, where forks cut, which day a stretch was sent, which rows an armed edit would drop, and the
// skeleton that stands in while the transcript is on its way.

// What the pane reads of its conversation to draw it.
export interface PaneTranscriptHost {
    readonly messages: Readonly<Ref<readonly ChatMessage[]>>;
    readonly streaming: Readonly<Ref<boolean>>;
    readonly awaitingDecision: Readonly<Ref<boolean>>;
    readonly editing: Readonly<Ref<ChatMessage | undefined>>;
    // Runs drawn unfolded, which already show every picture their cards hold.
    readonly showToolCalls: Readonly<Ref<boolean>>;
    // This conversation's transcript read, in flight with nothing painted; keyed by the conversation, so a tab switch
    // drops its skeleton at once.
    readonly loading: Ref<boolean>;
    readonly conversationId: Ref<string>;
}

export const usePaneTranscript = (pane: PaneTranscriptHost) => {
    const { messages, streaming, awaitingDecision, editing } = pane;
    // The bubble this turn writes into, if any (liveBubbleOf); recomputed per frame, scanning only the tail.
    const liveBubble = computed(() => liveBubbleOf(messages.value));
    const turns = computed(() => turnsOf(messages.value));
    // A turn whose pictures didn't change keeps its array (shotsByTurn), so a settled strip isn't redrawn per paint.
    const attached = computed(() => attachedPaths(messages.value));
    const turnShots = computed<ReadonlyMap<number, readonly ChatShot[]>>((previous) => shotsByTurn(turns.value, attached.value, previous));
    // The turn still being written, if any; a card it parked on is the reader's move, so that turn's pictures show.
    const writingTurn = computed(() => (streaming.value && !awaitingDecision.value ? turns.value.at(-1)?.id : undefined));
    const repeatedChecklists = computed(() => repeatedChecklistIds(messages.value));
    // The ids an edit in progress would drop, from the edited message down; a set by id, since ids survive `turns`
    // rebuilding under a streaming turn.
    const doomed = computed<ReadonlySet<number>>(() => {
        const target = editing.value;
        if (target === undefined) {
            return new Set();
        }
        const from = messages.value.indexOf(target);
        return from < 0 ? new Set() : new Set(messages.value.slice(from).map((message) => message.id));
    });

    return {
        turns,
        turnShots,
        repeatedChecklists,
        doomed,
        // True for the assistant bubble currently being streamed into.
        isStreaming: (message: ChatMessage): boolean => streaming.value && liveBubble.value?.id === message.id,
        // A sent turn before its first frame, drawn at the column's foot; a parked card is the prompt, not idle work.
        showTurnStatus: computed(() => streaming.value && !awaitingDecision.value && liveBubble.value === undefined),
        // A turn's strip, once it has stopped writing and only while runs are folded: unfolded cards draw every picture.
        stripOf: (turn: ChatTurn): readonly ChatShot[] | undefined => {
            const shots = turnShots.value.get(turn.id);
            return pane.showToolCalls.value || turn.id === writingTurn.value || shots === undefined || shots.length === 0 ? undefined : shots;
        },
        // How each surviving checklist snapshot draws: the list once per turn, then only what moved.
        checklistViews: computed(() => checklistViewsOf(turns.value, repeatedChecklists.value)),
        // The date named above the first turn sent on a given day, so each prompt's own stamp shrinks to the clock.
        dayMarks: computed(() => dayMarksOf(turns.value)),
        // What a fork below each turn inherits, built as one index since `turns` rebuilds every streaming paint.
        forkCuts: computed(() => forkCutsOf(turns.value)),
        // The boundaries that index doesn't cover, keyed by the message each sits above: folded messages, the first.
        cutsAbove: computed(() => cutsAboveOf(turns.value)),
        // How many bubbles an armed edit takes; derived from `doomed` so it can't disagree with the strike-through.
        editDropped: computed(() => doomed.value.size),
        // Gated, so a warm daemon's fast answer paints no placeholder; without one a load reads as data loss.
        skeleton: useLoadingReveal(pane.loading, pane.conversationId),
    };
};
