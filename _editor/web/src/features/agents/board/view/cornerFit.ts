import { afterResize } from "@intentic/ui";
import type { BoardView } from "./boardView";
import { type ComponentPublicInstance, computed, type CSSProperties, onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";

// FINISHED BROKERS THE CORNER. While the host stands something in the board's bottom-right corner (Agents.vue: Usage left,
// when the chat beside the board has no room for it), the Finished lane is held to exactly the board's visible height and
// pinned there, so what stands at its foot is always whole on screen and never lengthens the board: the lanes beside it
// may scroll, this column does not. What gives way is Finished's own cards: only those that fit whole above the corner
// are drawn, the rest join the lane's "N earlier" count (its header's fold). Pressing that (or opening the archive, or a
// filter listing every match) lets the lane scroll inside its own column instead, the corner still standing under it,
// told it is `crowded` so it can shrink and leave the scrolling cards the height.
//
// The fit is read off the drawn cards, never estimated: every card of Finished's window is rendered, all are shown and
// measured, and the ones whose bottom falls past the lane's card box (less the tile board's "N earlier" row under them)
// are taken out, in one frame before it paints, so nothing flickers.

export interface CornerFitHost {
    // A corner is drawn, and whether the board is stacked: a stacked board has no corner to hold, so the corner follows
    // its lanes there.
    readonly drawn: () => boolean;
    readonly narrow: Readonly<Ref<boolean>>;
    // How Finished is being read (expanded, the archive), a filter, and how many cards its window leaves out.
    readonly view: Readonly<Ref<BoardView>>;
    readonly filtering: Readonly<Ref<boolean>>;
    readonly hiddenFinished: Readonly<Ref<number>>;
    // Whether the fold is a row under the cards (a tile board, whose header has no room for it) rather than a header chip.
    readonly tailRow: () => boolean;
}

// A card's hover bar and drop shadow reach past its edge; the scrolling box gives them this much room inside its clip,
// and at its foot room for the last card's drop (a wallpaper's reaches ~2.25rem down, skins/wallpapers.css). The room
// above is 16px because the hover bar floats 14px over the card's top (CardHoverBar's `-top-3.5`): 12px cut its edge off.
const BLEED = `-mx-2 -mt-4 px-2 pt-4 pb-6`;
// That room above reaches 16px up over the lane's header, which paints no ground under a wallpaper: scrolled, a card
// sliding through it drew over the header's name and chips. Once the box is scrolled at all, that band is clipped away,
// so the cards end at the header's foot; at the top it stays open, for the first card's hover bar. A clip, not a mask: a
// mask only hides the band, and as a stacking context the masked box then sat over the unraised header and took every
// press on the fold and Clear that fell in it, invisibly. A clipped-out band takes no pointer.
const SCROLLED_CLIP = `[clip-path:inset(1rem_0_0_0)]`;

// How far the cut box lets its cards paint past its edge. A wallpaper's card drop reaches 2rem and more below the card
// (skins/wallpapers.css, 14px down with a 30px blur), and this was 0.75rem, which sliced that drop into a hard-edged
// band just above the corner. Past the box it falls into the corner's top padding and under the corner's opaque card.
// The same margin above lets the first card's hover bar float over the header, as it does in every other lane. Browsers
// honour the margin only when BOTH axes are `clip`, so the box clips sideways too (`overflow-clip`, not
// `overflow-y-clip`): clipped on one axis, the margin was ignored and the bar was cut off at the header's foot.
const CLIP_MARGIN = `[overflow-clip-margin:2.5rem]`;

// The card list's own bottom padding (AgentsView's `pb-2.5`), between the last card and the "N earlier" row; and that
// row's height, until one is drawn to measure.
const LIST_PAD_PX = 10;
const TAIL_PX = 34;

// Takes out every card from the first whose bottom falls past the box (never skipping one to show a later one), and
// answers how many it took out. Room for the "N earlier" row is kept whenever there will be one (`tailRow`, and the window
// already leaves cards out (`folded`), or this cut does). Not cutting, it shows them all.
const cutCards = (box: HTMLElement, cutting: boolean, folded: boolean, tailRow: boolean): number => {
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
    // Without the row, the last card still keeps the list's padding under it, so the gap down to the corner never shrinks
    // to the corner's own padding alone.
    const floor = tailRow && (folded || units.some((unit) => unit.getBoundingClientRect().bottom > bottom)) ? bottom - tailRoom : bottom - LIST_PAD_PX;
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

// Reads the box once a frame at most, after any resize handle rests or is released.
const useWatchedBox = (box: Ref<HTMLElement | undefined>, scroller: Ref<HTMLElement | undefined>, read: () => void): (() => void) => {
    let frame = 0;
    const readOnFrame = (): void => {
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            read();
        });
    };
    let waiting = (): void => {};
    const schedule = (): void => {
        waiting = afterResize(readOnFrame);
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
        waiting();
        cancelAnimationFrame(frame);
        resized.disconnect();
        changed.disconnect();
    });
    return schedule;
};

export const useCornerFit = ({ drawn, narrow, view, filtering, hiddenFinished, tailRow }: CornerFitHost) => {
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
    // Whether the card box is scrolled off its top (it scrolls only while `scrolls`).
    const scrolled = ref(false);
    const onScroll = (): void => {
        scrolled.value = (box.value?.scrollTop ?? 0) > 0;
    };
    watch(box, (el, was) => {
        was?.removeEventListener(`scroll`, onScroll);
        el?.addEventListener(`scroll`, onScroll, { passive: true });
        onScroll();
    });
    onBeforeUnmount(() => box.value?.removeEventListener(`scroll`, onScroll));
    const schedule = useWatchedBox(box, scroller, () => {
        if (scroller.value !== undefined && grid.value !== undefined) {
            const measured = roomIn(scroller.value, grid.value);
            if (measured.top !== room.value.top || measured.height !== room.value.height) {
                room.value = measured;
            }
        }
        cut.value = box.value === undefined ? 0 : cutCards(box.value, active.value && !scrolls.value, hiddenFinished.value > 0, tailRow());
    });
    watch([active, scrolls, hiddenFinished, tailRow], schedule);

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
        return scrolls.value ? `flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain ${BLEED}${scrolled.value ? ` ${SCROLLED_CLIP}` : ``}` : `flex min-h-0 flex-1 flex-col overflow-clip ${CLIP_MARGIN}`;
    });
    // Finished's fold counts the cards its window leaves out and the ones the corner left no room for; expanded, it
    // always offers the fold back, since the corner's cut is not counted while the lane scrolls.
    const earlier = computed(() => hiddenFinished.value + cut.value);
    const tailed = computed(() => (view.value.all ? hiddenFinished.value > 0 || active.value : earlier.value > 0));
    // The corner shares the pinned lane with cards a reader is scrolling through: told to what stands there, so it can
    // give them the height (Agents.vue folds Usage left to one row).
    const crowded = computed(() => active.value && scrolls.value);
    return { scroller, grid, active, attach, lane, cards, earlier, tailed, crowded };
};
