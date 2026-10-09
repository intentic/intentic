import { useDevice } from "@intentic/ui";
import { type InjectionKey, nextTick, onScopeDispose, type Ref, ref, watch } from "vue";
import { whenIdle } from "../../../../lib/whenIdle";
import type { ChatMessage, ChatTurn } from "../../transcript/transcript";

// HOW MANY ROWS OF A CHAT ARE DRAWN, newest first. Opening a chat mounted every row it held in one task: each row's
// component, its markdown parsed and sanitised, its box laid out, before the chat could answer a tap. Profiled at 4× CPU
// throttle (a Galaxy S10's class), 140 rows held the main thread 2.5s and 420 rows froze a single frame for 3.3s. Here a
// chat opens on its newest rows, drawn in the same frame, and the rows above are mounted a slice at a time while the page
// is idle, so no single task draws more than a slice.
//
// AND NO MORE THAN A WINDOW OF THEM STAYS DRAWN. Every row in the column is paid for on every frame, whether or not it is
// on screen: each layout walks every row's box, and the browser checks every `content-visibility: auto` row against the
// viewport per frame. Measured on a desktop with 4,000 real rows drawn, one layout cost 20ms (0.6ms with the last 40
// turns), a streamed turn kept the main thread 94% busy with a 283ms 99th-percentile frame, and a keystroke took 56ms;
// with 300 rows drawn the same transcript streamed at 25% busy, 17ms, and 24ms a key. So the idle growth stops at a
// ceiling, the rows above it are drawn only as a reader climbs toward them (a mark above the oldest drawn row, within a
// screen of the top), and once the reader is back at the newest they are taken down again.
//
// Within a conversation, rows arriving never take down what the reader may be looking at: rows appended below widen the
// window, unless the reader is at the newest with the window full, when the oldest drawn rows give way instead; a page
// put above ("Load earlier") draws its nearest slice, and the rest as the reader climbs into it. A new conversation, or
// rows arriving into an empty one (the open itself), starts over at the first paint.

export interface RowSizes {
    // Drawn in the frame a chat opens on.
    readonly first: number;
    // Added per idle callback, and per step of a reader's climb.
    readonly slice: number;
    // What idle growth stops at, and what a reader back at the newest is trimmed to.
    readonly most: number;
}

// A phone's frame budget is a quarter of a laptop's, and so is its window.
export const PHONE_ROWS: RowSizes = { first: 24, slice: 16, most: 96 };
export const DESK_ROWS: RowSizes = { first: 160, slice: 80, most: 320 };

// Whether the reader is at the transcript's newest row (useStickToBottom), provided by the pane that owns the scroller
// (paneScroll.ts). Only then may rows above the window be taken down.
export const TRANSCRIPT_PARKED: InjectionKey<Readonly<Ref<boolean>>> = Symbol(`transcriptParked`);

export interface RowBudgetHost {
    readonly messages: Readonly<Ref<readonly ChatMessage[]>>;
    readonly conversationId: Readonly<Ref<string>>;
    readonly parked: Readonly<Ref<boolean>>;
    // The mark drawn above the oldest drawn row while rows above it are not drawn; absent once the window is whole.
    readonly edge: Readonly<Ref<HTMLElement | null | undefined>>;
}

// What the window becomes when the rows change within one conversation.
export const nextBudget = (
    budget: number,
    previous: readonly ChatMessage[],
    next: readonly ChatMessage[],
    sizes: RowSizes,
    parked: boolean,
): number => {
    // The chat's rows arriving at all is its opening, however many there are.
    if (previous.length === 0) {
        return sizes.first;
    }
    const arrived = next.length - previous.length;
    if (arrived <= 0) {
        return budget;
    }
    // A page above: its nearest slice now, the rest as the reader climbs.
    if (next[arrived] === previous[0]) {
        return budget + Math.min(arrived, sizes.slice);
    }
    return parked ? Math.max(budget, Math.min(budget + arrived, sizes.most)) : budget + arrived;
};

// How long a climb waits for an idle moment: a reader scrolling up keeps the page busy, and the rows above have to be
// there by the time they arrive.
const CLIMB_WAIT_MS = 150;

export const useRowBudget = (host: RowBudgetHost): Readonly<Ref<number>> => {
    const { mobile, coarse } = useDevice();
    const sizes = (): RowSizes => (mobile.value || coarse.value ? PHONE_ROWS : DESK_ROWS);
    const budget = ref(sizes().first);
    // The mark above the oldest drawn row is within a screen of the top.
    let nearTop = false;
    let queued = false;
    let disposed = false;

    // One step toward where the window should stand: up to its ceiling while idle, past it while the reader climbs.
    const step = (): void => {
        const total = host.messages.value.length;
        const { slice, most } = sizes();
        if (budget.value < Math.min(total, most)) {
            budget.value = Math.min(total, most, budget.value + slice);
            return;
        }
        if (nearTop && budget.value < total) {
            // The reader stays on the rows they were reading, the same distance from the bottom. Scroll anchoring holds
            // that by itself, except where it does not run: at the very top (where Chromium leaves a scroller showing
            // what was put above it, which then puts the mark in view again, and again, until every row is drawn) and
            // in a browser without it. So it is checked after the rows land, and put back only where it moved.
            const scroller = host.edge.value?.closest<HTMLElement>(`.chat-scroller`) ?? null;
            const fromBottom = scroller === null ? undefined : scroller.scrollHeight - scroller.scrollTop;
            budget.value = Math.min(total, budget.value + slice);
            if (scroller !== null && fromBottom !== undefined) {
                void nextTick(() => {
                    if (Math.abs(scroller.scrollHeight - scroller.scrollTop - fromBottom) > 1) {
                        scroller.scrollTop = scroller.scrollHeight - fromBottom;
                    }
                });
            }
        }
    };
    const owed = (): boolean => {
        const total = host.messages.value.length;
        return budget.value < Math.min(total, sizes().most) || (nearTop && budget.value < total);
    };
    const grow = (): void => {
        if (queued || disposed || !owed()) {
            return;
        }
        queued = true;
        whenIdle(
            () => {
                queued = false;
                if (disposed) {
                    return;
                }
                step();
                grow();
            },
            nearTop ? CLIMB_WAIT_MS : undefined,
        );
    };
    // Back at the newest with more drawn than the window holds: the rows above it come down, at an idle moment. Not while
    // the mark is near the top, which only a column too short to scroll has at the bottom: that one is still filling.
    let trimming = false;
    const trim = (): void => {
        const { slice, most } = sizes();
        if (trimming || disposed || !host.parked.value || nearTop || budget.value <= most + slice) {
            return;
        }
        trimming = true;
        whenIdle(() => {
            trimming = false;
            if (!disposed && host.parked.value && !nearTop) {
                budget.value = most;
            }
        });
    };

    watch(
        [host.conversationId, host.messages],
        ([id, next], [previousId, previous]) => {
            budget.value = id === previousId ? nextBudget(budget.value, previous ?? [], next, sizes(), host.parked.value) : sizes().first;
            grow();
            trim();
        },
        { immediate: true },
    );
    watch(host.parked, trim);

    watch(
        host.edge,
        (edge, _previous, onCleanup) => {
            nearTop = false;
            const scroller = edge?.closest<HTMLElement>(`.chat-scroller`) ?? null;
            if (edge === null || edge === undefined || scroller === null || typeof IntersectionObserver === `undefined`) {
                return;
            }
            const observer = new IntersectionObserver(
                (entries) => {
                    nearTop = entries.at(-1)?.isIntersecting ?? nearTop;
                    grow();
                },
                // A screen above the visible top: rows are drawn before the reader reaches them.
                { root: scroller, rootMargin: `100% 0px 0px 0px` },
            );
            observer.observe(edge);
            onCleanup(() => {
                observer.disconnect();
                nearTop = false;
            });
        },
        { immediate: true, flush: `post` },
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
