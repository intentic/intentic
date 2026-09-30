import { computed, nextTick, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue";
import { type RowMetrics, scrollToShow, windowOf } from "./rowWindow";

// A scroller and a row model, joined: which rows are worth having in the DOM right now. The list's full height goes on
// a spacer so the scrollbar still measures the whole list, and only the crossing slice is rendered.
//
// Use this for any list that can reach the thousands. A workspace directory can hold tens of thousands of entries, and
// a row the reader cannot see still costs a component, its listeners and a diff on every tick.

// Rows kept past each edge, so a flick paints rows rather than blank while the next frame catches up.
const OVERSCAN = 8;

export interface RowWindow {
    // The rendered slice, half-open: render `rows.slice(first, last)` and place each at `metrics.offsetOf(index)`.
    readonly first: ComputedRef<number>;
    readonly last: ComputedRef<number>;
    // The spacer's height; the scroller's range, not the rendered slice's.
    readonly total: ComputedRef<number>;
    // The row model itself, so the view can place a rendered row at `offsetOf(index)` without prefix-summing again.
    readonly rows: ComputedRef<RowMetrics>;
    // Bind to the scroller's `@scroll.passive`.
    readonly onScroll: () => void;
    // Brings a row into view and resolves once it is mounted, so a caller may then focus it. A row outside the window
    // has no element to focus until this has run.
    readonly show: (index: number) => Promise<void>;
    // A new subject (a different folder, a fresh query): back to the start.
    readonly toTop: () => void;
}

export interface RowWindowOptions {
    // Rows to keep past each edge of the viewport.
    readonly overscan?: number;
    /**
     * How far down the scroller's content the list starts, when something sits above it. Read from a ref the caller
     * keeps, not measured here on every scroll: asking the DOM for an offset forces layout, and this number only moves
     * when the thing above the list appears or changes size.
     */
    readonly offsetTop?: () => number;
}

/**
 * Window a long list against its scroller.
 *
 * @param scroller The scrolling element. Must be the one the rows are laid out in.
 * @param metrics How tall the rows are; rebuilt whenever the row model changes (see `uniformRows` / `variableRows`).
 */
export function useRowWindow(scroller: Readonly<Ref<HTMLElement | undefined>>, metrics: () => RowMetrics, options: RowWindowOptions = {}): RowWindow {
    const overscan = options.overscan ?? OVERSCAN;
    const above = (): number => options.offsetTop?.() ?? 0;
    const scrollTop = ref(0);
    const viewport = ref(0);
    const model = computed(metrics);
    // In the list's own coordinates: what the scroller has scrolled, less whatever sits above the first row.
    const slice = computed(() => windowOf(model.value, scrollTop.value - above(), viewport.value, overscan));

    const onScroll = (): void => {
        scrollTop.value = scroller.value?.scrollTop ?? 0;
    };

    let observer: ResizeObserver | undefined;
    onMounted(() => {
        const el = scroller.value;
        if (el === undefined) {
            return;
        }
        // Read once here as well as observing: the first callback lands a frame late, and a viewport of zero until then
        // would render one row and flash.
        viewport.value = el.clientHeight;
        scrollTop.value = el.scrollTop;
        observer = new ResizeObserver(() => {
            viewport.value = scroller.value?.clientHeight ?? 0;
        });
        observer.observe(el);
    });
    onBeforeUnmount(() => observer?.disconnect());

    const show = async (index: number): Promise<void> => {
        const el = scroller.value;
        if (el === undefined) {
            return;
        }
        const start = above();
        const next = start + scrollToShow(model.value, index, el.scrollTop - start, el.clientHeight);
        // Nothing to move means the row already fits in the viewport, and a row that fits is inside the window: it is
        // in the DOM now. Returning without a tick matters — callers await this before touching the element.
        if (next === el.scrollTop && next === scrollTop.value) {
            return;
        }
        // Assigned to both: the scroll event is asynchronous, and the window must widen in this tick for the row to be
        // in the DOM by the `nextTick` below.
        el.scrollTop = next;
        scrollTop.value = next;
        await nextTick();
    };

    const toTop = (): void => {
        if (scroller.value !== undefined) {
            scroller.value.scrollTop = 0;
        }
        scrollTop.value = 0;
    };

    return {
        first: computed(() => slice.value.first),
        last: computed(() => slice.value.last),
        total: computed(() => model.value.total),
        rows: model,
        onScroll,
        show,
        toTop,
    };
}
