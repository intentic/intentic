import { afterResize, layoutResizing } from "@intentic/ui";
import { canAnimate, FOLD_EASE, lessMotion, REVEAL_MS, slideFrom } from "@intentic/ui/motion";
import type { BoardView } from "./boardView";
import { type ComponentPublicInstance, computed, type CSSProperties, nextTick, onBeforeUnmount, onMounted, type Ref, ref, watch } from "vue";

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
//
// EVERY FRAME IS RIGHT, A DRAG'S INCLUDED. While a resize handle is dragged, the full read waits for the hand to rest or
// let go, as most measuring does (resizeGesture.ts). Two things cannot wait for it. The corner arriving or leaving, and
// Finished starting or stopping its own scroll, are read the moment they are drawn. And while the corner stands, every
// frame of the drag takes out whatever card has stopped fitting: a lane narrowing under the hand rewraps its cards taller.
// Until 2026-11-24 both waited for the drag to end, and cards ran down over the corner for as long as the hand moved. A
// card the drag took out comes back once the hand rests, fading in, as do the cards the corner gives back by leaving.
// Pinned or let go, the lane slides from where it stood rather than blinking to its new place.

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

const unitsIn = (box: HTMLElement): HTMLElement[] => [...box.querySelectorAll<HTMLElement>(`[data-fold-unit], [data-fit-unit]`)];
const isOut = (unit: HTMLElement): boolean => unit.style.display === `none`;

// The line no card's bottom may pass: the box's own foot, less room for the "N earlier" row whenever there will be one
// (`tailRow`, and the window already leaves cards out (`folded`), or a card of `units` falls past the foot), else less the
// list's padding alone, so the gap down to the corner never shrinks to the corner's own padding.
const floorOf = (box: HTMLElement, units: readonly HTMLElement[], folded: boolean, tailRow: boolean): number => {
    const bottom = box.getBoundingClientRect().bottom + 0.5;
    if (!tailRow || !(folded || units.some((unit) => unit.getBoundingClientRect().bottom > bottom))) {
        return bottom - LIST_PAD_PX;
    }
    // Its own bottom margin may fall under the corner's top padding, so it is not room the cards give up.
    return bottom - (box.querySelector<HTMLElement>(`[data-fit-tail]`)?.offsetHeight ?? TAIL_PX) - LIST_PAD_PX;
};

// A card given back after it was taken out fades in where it stands, rather than appearing in one frame.
const fadeIn = (units: readonly HTMLElement[]): void => {
    if (units.length === 0 || lessMotion()) {
        return;
    }
    for (const unit of units) {
        if (canAnimate(unit)) {
            unit.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: FOLD_EASE });
        }
    }
};

// Takes out every card from the first whose bottom falls past the floor (never skipping one to show a later one), and
// answers how many it took out. Not cutting, it shows them all.
const cutCards = (box: HTMLElement, cutting: boolean, folded: boolean, tailRow: boolean): number => {
    const units = unitsIn(box);
    const wereOut = units.filter(isOut);
    for (const unit of wereOut) {
        unit.style.display = ``;
    }
    const floor = cutting ? floorOf(box, units, folded, tailRow) : Number.POSITIVE_INFINITY;
    const from = units.findIndex((unit) => unit.getBoundingClientRect().bottom > floor);
    const cut = from === -1 ? [] : units.slice(from);
    for (const unit of cut) {
        unit.style.display = `none`;
    }
    fadeIn(wereOut.filter((unit) => !cut.includes(unit)));
    return cut.length;
};

// One frame of a drag: takes out the cards that have stopped fitting, from the first whose bottom falls past the floor,
// and gives none back (that waits for the full read once the hand rests, which can show every card to measure it). It
// reads only the layout the frame draws anyway and writes only when a card crosses, so the drag keeps its frames.
const trimCards = (box: HTMLElement, folded: boolean, tailRow: boolean): number => {
    const units = unitsIn(box);
    const shown = units.filter((unit) => !isOut(unit));
    const floor = floorOf(box, shown, folded || shown.length < units.length, tailRow);
    const from = units.findIndex((unit) => !isOut(unit) && unit.getBoundingClientRect().bottom > floor);
    for (const unit of from === -1 ? [] : units.slice(from)) {
        unit.style.display = `none`;
    }
    return units.filter(isOut).length;
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

// Reads the box once a frame at most, after any resize handle rests or is released; mid-drag, keeps up once a frame.
const useWatchedBox = (box: Ref<HTMLElement | undefined>, scroller: Ref<HTMLElement | undefined>, read: () => void, keepUp: () => void): void => {
    let frame = 0;
    const readOnFrame = (): void => {
        frame ||= requestAnimationFrame(() => {
            frame = 0;
            read();
        });
    };
    let keepFrame = 0;
    const keepUpOnFrame = (): void => {
        keepFrame ||= requestAnimationFrame(() => {
            keepFrame = 0;
            keepUp();
        });
    };
    let waiting = (): void => {};
    const schedule = (): void => {
        waiting = afterResize(readOnFrame);
        if (layoutResizing.value) {
            keepUpOnFrame();
        }
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
        cancelAnimationFrame(keepFrame);
        resized.disconnect();
        changed.disconnect();
    });
};

// PINNED OR LET GO, THE LANE SLIDES THERE. The corner arriving pins Finished to the top of the board's window and its
// leaving puts the lane back in the board's scroll, so on a scrolled board either one moves the whole column. It is drawn
// at its new place at once and plays the move back as a slide the compositor runs (fold.ts, FLIP), at most a screen's
// height of it. Not when the board stacks or unstacks, which moves every lane at once.
const useLaneSlide = (box: Readonly<Ref<HTMLElement | undefined>>, corner: () => boolean, narrow: Readonly<Ref<boolean>>): void => {
    const laneOf = (): HTMLElement | null | undefined => box.value?.closest<HTMLElement>(`[data-lane]`);
    let before: number | undefined;
    watch(
        corner,
        () => {
            before = lessMotion() || narrow.value ? undefined : laneOf()?.getBoundingClientRect().top;
        },
        { flush: `pre` },
    );
    watch(
        corner,
        () => {
            const lane = laneOf();
            const was = before;
            before = undefined;
            if (was === undefined || narrow.value || !canAnimate(lane)) {
                return;
            }
            const reach = globalThis.innerHeight;
            const dy = Math.max(-reach, Math.min(reach, was - lane.getBoundingClientRect().top));
            if (Math.abs(dy) >= 0.5) {
                slideFrom(lane, dy);
            }
        },
        { flush: `post` },
    );
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
    const cutNow = (): void => {
        cut.value = box.value === undefined ? 0 : cutCards(box.value, active.value && !scrolls.value, hiddenFinished.value > 0, tailRow());
    };
    const read = (): void => {
        if (scroller.value !== undefined && grid.value !== undefined) {
            const measured = roomIn(scroller.value, grid.value);
            if (measured.top !== room.value.top || measured.height !== room.value.height) {
                room.value = measured;
                // The lane is pinned anew from that room: cut once it has been drawn there (still before this frame
                // paints), not against where it stood. The board's fold changing its padding on the frame the corner
                // arrives left one frame of every card drawn whole and clipped below the corner.
                void nextTick(cutNow);
                return;
            }
        }
        cutNow();
    };
    const keepUp = (): void => {
        if (box.value !== undefined && active.value && !scrolls.value) {
            cut.value = trimCards(box.value, hiddenFinished.value > 0, tailRow());
        }
    };
    useWatchedBox(box, scroller, read, keepUp);
    // Drawn differently (the corner come or gone, the lane scrolling or cutting, its window or fold row changed): read
    // once that render and every render it sets off have been drawn, before the frame paints, whether or not a hand is on
    // a resize handle. Not straight after it: what stands in the corner can show its insides only in a render of its own
    // (Usage left's Await reveals them when it mounts), and a corner read empty left every card drawn for a frame.
    watch([active, scrolls, hiddenFinished, tailRow], () => void nextTick(read), { flush: `post` });
    useLaneSlide(box, drawn, narrow);

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
