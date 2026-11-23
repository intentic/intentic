import type { BoardView } from "./boardView";
import { type ComponentPublicInstance, computed, type CSSProperties, onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";

// FINISHED BROKERS THE CORNER. While the host stands something in the board's bottom-right corner (Agents.vue: Usage left,
// when the chat beside the board has no room for it), the Finished lane is held to exactly the board's visible height and
// pinned there, so what stands at its foot is always whole on screen and never lengthens the board: the lanes beside it
// may scroll, this column does not. What gives way is Finished's own cards: only those that fit whole above the corner
// are drawn, the rest join the lane's "N earlier" count. Pressing that (or opening the archive, or a filter listing every
// match) lets the lane scroll inside its own column instead, the corner still standing under it.
//
// The fit is read off the drawn cards, never estimated: every card of Finished's window is rendered, all are shown and
// measured, and the ones whose bottom falls past the lane's card box (less the "N earlier" row under them) are taken out,
// in one frame before it paints, so the row follows the last card drawn and nothing flickers.

export interface CornerFitHost {
    // A corner is drawn, and whether the board is stacked: a stacked board has no corner to hold, so the corner follows
    // its lanes there.
    readonly drawn: () => boolean;
    readonly narrow: Readonly<Ref<boolean>>;
    // How Finished is being read (expanded, the archive), a filter, and how many cards its window leaves out.
    readonly view: Readonly<Ref<BoardView>>;
    readonly filtering: Readonly<Ref<boolean>>;
    readonly hiddenFinished: Readonly<Ref<number>>;
}

// A card's hover bar and drop shadow reach past its edge; the scrolling box gives them this much room inside its clip.
const BLEED = `-mx-2 -mt-3 px-2 pt-3`;

// The card list's own bottom padding (AgentsView's `pb-2.5`), between the last card and the "N earlier" row; and that
// row's height, until one is drawn to measure.
const LIST_PAD_PX = 10;
const TAIL_PX = 34;

// Takes out every card from the first whose bottom falls past the box (never skipping one to show a later one), and
// answers how many it took out. Room for the "N earlier" row is kept whenever there will be one: the window already
// leaves cards out (`folded`), or this cut does. Not cutting, it shows them all.
const cutCards = (box: HTMLElement, cutting: boolean, folded: boolean): number => {
    const units = [...box.querySelectorAll<HTMLElement>(`[data-fold-unit], [data-fit-unit]`)];
    for (const unit of units) {
        unit.style.display = ``;
    }
    if (!cutting) {
        return 0;
    }
    const bottom = box.getBoundingClientRect().bottom + 0.5;
    const tail = box.querySelector<HTMLElement>(`[data-fit-tail]`);
    // Its own bottom margin may fall under the corner's top padding, so it is not room the cards give up.
    const tailRoom = (tail?.offsetHeight ?? TAIL_PX) + LIST_PAD_PX;
    const floor = folded || units.some((unit) => unit.getBoundingClientRect().bottom > bottom) ? bottom - tailRoom : bottom;
    const from = units.findIndex((unit) => unit.getBoundingClientRect().bottom > floor);
    const cut = from === -1 ? [] : units.slice(from);
    for (const unit of cut) {
        unit.style.display = `none`;
    }
    return cut.length;
};

// Where a lane pinned in the grid stands and how tall it is: the scroller's height, less the grid's padding above and below.
interface LaneRoom {
    readonly top: number;
    readonly height: number;
}
const roomIn = (port: HTMLElement, lanes: HTMLElement): LaneRoom => {
    const style = getComputedStyle(lanes);
    const top = Number.parseFloat(style.paddingTop) || 0;
    return { top, height: Math.max(0, port.clientHeight - top - (Number.parseFloat(style.paddingBottom) || 0)) };
};

// Re-runs `read` once a frame at most, whenever the box's cards, the box or the scroller change.
const useWatchedBox = (box: Ref<HTMLElement | undefined>, scroller: Ref<HTMLElement | undefined>, read: () => void): (() => void) => {
    let frame = 0;
    const schedule = (): void => {
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            read();
        });
    };
    const resized = new ResizeObserver(schedule);
    const changed = new MutationObserver(schedule);
    watch(box, (cards, was) => {
        was?.removeEventListener(`transitionend`, schedule);
        changed.disconnect();
        if (cards !== undefined) {
            resized.observe(cards);
            // A card arriving, leaving or rewording changes what fits; a card sliding in is read once it has landed.
            changed.observe(cards, { childList: true, subtree: true, characterData: true });
            cards.addEventListener(`transitionend`, schedule);
        }
        schedule();
    });
    watch(scroller, (port) => {
        if (port !== undefined) {
            resized.observe(port);
        }
    });
    onMounted(schedule);
    onBeforeUnmount(() => {
        cancelAnimationFrame(frame);
        resized.disconnect();
        changed.disconnect();
    });
    return schedule;
};

export const useCornerFit = ({ drawn, narrow, view, filtering, hiddenFinished }: CornerFitHost) => {
    // The board's scroller and the lane grid inside it, and Finished's card box, all from template refs.
    const scroller = ref<HTMLElement>();
    const grid = ref<HTMLElement>();
    const box = ref<HTMLElement>();
    const active = computed(() => drawn() && !narrow.value);
    // Finished lists past its window (expanded, the archive, a filter's matches): it scrolls rather than cuts.
    const scrolls = computed(() => view.value.all || view.value.archive || filtering.value);
    const room = ref<LaneRoom>({ top: 0, height: 0 });
    // How many of the drawn cards are hidden for want of room.
    const cut = ref(0);
    const schedule = useWatchedBox(box, scroller, () => {
        if (scroller.value !== undefined && grid.value !== undefined) {
            room.value = roomIn(scroller.value, grid.value);
        }
        cut.value = box.value === undefined ? 0 : cutCards(box.value, active.value && !scrolls.value, hiddenFinished.value > 0);
    });
    watch([active, scrolls, hiddenFinished], schedule);

    // Finished's card box, by a function ref, so a v-for does not make it a list.
    const attach = (el: Element | ComponentPublicInstance | null): void => {
        box.value = el instanceof HTMLElement ? el : undefined;
    };
    // The lane itself: pinned at the grid's top padding, exactly the height left under it; not before that height is read,
    // or its first frame is a lane of no height whose corner then drops into place.
    const lane = computed((): CSSProperties | undefined =>
        active.value && room.value.height > 0 ? { top: `${room.value.top}px`, height: `${room.value.height}px` } : undefined,
    );
    // Its card box: the room between its header and the corner, cutting or scrolling; else no box at all.
    const cards = computed((): string => {
        if (!active.value) {
            return `contents`;
        }
        return scrolls.value ? `flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain ${BLEED}` : `flex min-h-0 flex-1 flex-col overflow-y-clip [overflow-clip-margin:0.75rem]`;
    });
    // Finished's tail counts the cards its window leaves out and the ones the corner left no room for; expanded, it
    // always offers the fold back, since the corner's cut is not counted while the lane scrolls.
    const earlier = computed(() => hiddenFinished.value + cut.value);
    const tailed = computed(() => (view.value.all ? hiddenFinished.value > 0 || active.value : earlier.value > 0));
    return { scroller, grid, active, attach, lane, cards, earlier, tailed };
};
