import { useDevice } from "@intentic/ui";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { whenIdle } from "../../../../lib/whenIdle";
import type { ChatMessage, ChatTurn } from "../../transcript/transcript";

// HOW MANY ROWS OF A CHAT ARE DRAWN, newest first. Opening a chat mounted every row it held in one task: each row's
// component, its markdown parsed and sanitised, its box laid out, before the chat could answer a tap. Profiled at 4× CPU
// throttle (a Galaxy S10's class), 140 rows held the main thread 2.5s and 420 rows froze a single frame for 3.3s. Here a
// chat opens on its newest rows, drawn in the same frame, and the rows above are mounted a slice at a time while the page
// is idle, so no single task draws more than a slice; by the time a reader has scrolled up they are there.
//
// The budget only grows within a conversation: an appended row (a streamed turn) and a prepended page ("Load earlier")
// both widen it by what arrived, so nothing already drawn is ever taken down, and a page the reader asked for appears at
// once where they asked for it. A new conversation starts over.

// First paint and each idle slice, in rows: a phone's frame budget is a quarter of a laptop's.
const PHONE_FIRST = 24;
const PHONE_SLICE = 16;
const DESK_FIRST = 160;
const DESK_SLICE = 80;

export interface RowBudgetHost {
    readonly messages: Readonly<Ref<readonly ChatMessage[]>>;
    readonly conversationId: Readonly<Ref<string>>;
}

// A budget change the watch below decides: what arrived, relative to what was drawn.
export const nextBudget = (budget: number, previous: readonly ChatMessage[], next: readonly ChatMessage[]): number => {
    const arrived = next.length - previous.length;
    return arrived > 0 ? budget + arrived : budget;
};

export const useRowBudget = (host: RowBudgetHost): Readonly<Ref<number>> => {
    const { mobile, coarse } = useDevice();
    const phone = (): boolean => mobile.value || coarse.value;
    const first = (): number => (phone() ? PHONE_FIRST : DESK_FIRST);
    const budget = ref(first());
    let growing = false;
    let disposed = false;
    const grow = (): void => {
        if (growing || disposed || budget.value >= host.messages.value.length) {
            return;
        }
        growing = true;
        whenIdle(() => {
            growing = false;
            if (disposed) {
                return;
            }
            budget.value = Math.min(host.messages.value.length, budget.value + (phone() ? PHONE_SLICE : DESK_SLICE));
            grow();
        });
    };
    watch(
        [host.conversationId, host.messages],
        ([id, next], [previousId, previous]) => {
            budget.value = id === previousId ? nextBudget(budget.value, previous ?? [], next) : first();
            grow();
        },
        { immediate: true },
    );
    onScopeDispose(() => {
        disposed = true;
    });
    return budget;
};

// The turns to draw for a budget: every row among the last `budget`, each in its own turn, and the opening row of any
// turn only partly drawn, so a prompt still pins over the part of its answer on screen. A turn drawn whole is the same
// object as the one given, which keeps the list's memo and keys; a turn with no row drawn is left out, marks and all.
export const windowTurns = (turns: readonly ChatTurn[], total: number, budget: number): readonly ChatTurn[] => {
    const cut = total - budget;
    if (cut <= 0) {
        return turns;
    }
    const drawn: ChatTurn[] = [];
    let index = 0;
    for (const turn of turns) {
        const start = index;
        index += turn.messages.length;
        if (index <= cut) {
            continue;
        }
        // Only its prompt above the cut is still the whole turn, since the prompt is drawn regardless.
        drawn.push(start + 1 >= cut ? turn : { ...turn, messages: [turn.messages[0]!, ...turn.messages.slice(cut - start)] });
    }
    return drawn;
};
