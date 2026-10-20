import { onBeforeUnmount, ref, watch, type Ref } from "vue";

// WHEN THE RAIL'S CHECKLIST SPREADS INTO A SECOND COLUMN. The rail is 240px and shares its height with plan headroom
// (ChatSideRail), so a long plan scrolls inside half a rail while the panel often has empty room between the
// transcript and the rail. Spread, the checklist doubles leftwards into that room and its items flow down one column
// and on into the next, so "what is left" reads without scrolling. Two rules keep it honest:
// - It spreads only where one column would scroll. A list that fits stays the narrow column it always was.
// - It spreads only into room nothing else stands in: past the transcript's column AND the lane its marks stand in.
//   The reserved rail width (`--capacity-rail`) never changes, so the transcript cannot reflow under the reader.
// The two columns are each exactly as wide as the narrow one (ChatRailChecklist's gap), so every item wraps the same in
// either form: the one-column height is the sum of the rows whichever form is drawn, and the choice cannot flip-flop.

/** What the decision reads, all in screen pixels. */
export interface SpreadReading {
    // The checklist's rows stacked in one column (each row carries its own gap), and its heading and padding.
    readonly rows: number;
    readonly chrome: number;
    // Plan headroom's whole height if nothing clipped it.
    readonly capacity: number;
    // The rail's height, which the two share out (ChatSideRail's grid).
    readonly rail: number;
    // Room left of the rail that nothing paints in, and what a second column takes of it.
    readonly free: number;
    readonly extra: number;
    // Drawn spread now: staying that way takes a little less than spreading did, so a pixel of rounding never toggles it.
    readonly spread: boolean;
}

// How near to fitting a spread list may come before it narrows again.
const SETTLE_PX = 8;

export const spreadsChecklist = (reading: SpreadReading): boolean => {
    if (reading.free < reading.extra) {
        return false;
    }
    const slack = reading.spread ? -SETTLE_PX : 1;
    const natural = reading.rows + reading.chrome;
    // The rail's grid lets a block under half the height keep all of it and the other take the rest; when both are long
    // each gets half. So one column scrolls exactly when the two don't fit together and the checklist is the longer half.
    return natural + reading.capacity - reading.rail > slack && natural - reading.rail / 2 > slack;
};

// A length the stylesheet writes in rem, in screen pixels.
const cssLength = (value: string): number => {
    const trimmed = value.trim();
    const number = Number.parseFloat(trimmed);
    if (!Number.isFinite(number)) {
        return 0;
    }
    return trimmed.endsWith(`rem`) ? number * Number.parseFloat(getComputedStyle(document.documentElement).fontSize) : number;
};

// A box's height if its scroller held all of its content.
const naturalHeight = (section: HTMLElement): number => {
    const scroller = section.querySelector<HTMLElement>(`.overflow-y-auto`);
    return scroller === null ? section.offsetHeight : section.offsetHeight - scroller.clientHeight + scroller.scrollHeight;
};

// Clear air between the marks' lane and the spread list, so the two never read as one block.
const BREATHING_REM = 1;

/**
 * Whether the checklist `section` should be drawn spread. `list` is its scroller, `rows` what it scrolls.
 * Measured off the live layout, as the rail's own presence is (ChatPanel's railFitsBeside).
 */
export const useChecklistSpread = (
    section: Ref<HTMLElement | undefined>,
    list: Ref<HTMLElement | undefined>,
    // Anything that changes the list's rows: a new key means measure again.
    changed: () => string,
): Ref<boolean> => {
    const spread = ref(false);
    // A component-test DOM has no ResizeObserver: nothing measures and the list stays the narrow column.
    if (!(`ResizeObserver` in globalThis)) {
        return spread;
    }
    const watched = new Set<Element>();
    let frame = 0;
    const observer = new ResizeObserver(() => schedule());
    const observe = (element: Element | null | undefined): void => {
        if (element && !watched.has(element)) {
            watched.add(element);
            observer.observe(element);
        }
    };

    const measure = (): void => {
        frame = 0;
        const box = section.value;
        const scroller = list.value;
        const rail = box?.parentElement;
        const panel = box?.closest<HTMLElement>(`.chat-panel`);
        if (!box || !scroller || !rail || !panel) {
            spread.value = false;
            return;
        }
        // The pane the rail stands beside is the row's last drawn one (chat.css pads it for the rail).
        const column = panel.querySelector<HTMLElement>(`.chat-panes > .chat-pane:last-child .chat-turns`);
        const capacity = box.nextElementSibling instanceof HTMLElement ? box.nextElementSibling : undefined;
        const content = scroller.firstElementChild;
        [panel, rail, column, capacity, capacity?.querySelector(`.overflow-y-auto`), content].forEach(observe);
        if (!column || !(content instanceof HTMLElement)) {
            spread.value = false;
            return;
        }
        const railBox = rail.getBoundingClientRect();
        // What stands past the column's box: the lane its marks paint in (chat.css `--chat-lane`), then air.
        const lane = cssLength(getComputedStyle(column).getPropertyValue(`--chat-lane`)) + cssLength(`${BREATHING_REM}rem`);
        const rows = [...content.querySelectorAll<HTMLElement>(`[data-reveal]`)].reduce((sum, row) => sum + row.offsetHeight, 0);
        spread.value = spreadsChecklist({
            rows,
            chrome: box.offsetHeight - scroller.clientHeight,
            capacity: capacity ? naturalHeight(capacity) : 0,
            rail: railBox.height,
            free: railBox.left - (column.getBoundingClientRect().right + lane),
            extra: railBox.width,
            spread: spread.value,
        });
    };
    const schedule = (): void => {
        if (frame === 0) {
            frame = requestAnimationFrame(measure);
        }
    };

    watch([section, list, changed], schedule, { flush: `post`, immediate: true });
    onBeforeUnmount(() => {
        cancelAnimationFrame(frame);
        observer.disconnect();
    });
    return spread;
};
