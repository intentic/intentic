import { computed, ref, watch, type Ref } from "vue";

/* Keyboard navigation for a searchbox-driven listbox (the QuickOpen pattern): a highlight index over a flat
 * row list, wrap-around arrow movement that keeps the highlighted row scrolled into view, and the element
 * registry the scrolling needs. Rows register their elements by key (via :ref) so v-for churn stays correct.
 * The highlight snaps back to the top whenever the row set changes under it. */
export function useListNavigation<T>(rows: Ref<readonly T[]>, keyOf: (row: T) => string) {
    const activeIndex = ref(0);
    const rowEls = new Map<string, HTMLElement>();

    watch(rows, () => (activeIndex.value = 0));

    const setRowEl = (key: string, el: unknown): void => {
        if (el) {
            rowEls.set(key, el as HTMLElement);
        } else {
            rowEls.delete(key);
        }
    };

    const move = (delta: number): void => {
        const count = rows.value.length;
        if (count === 0) {
            return;
        }
        activeIndex.value = (activeIndex.value + delta + count) % count;
        const row = rows.value[activeIndex.value];
        if (row !== undefined) {
            rowEls.get(keyOf(row))?.scrollIntoView({ block: `nearest` });
        }
    };

    const activeRow = computed<T | undefined>(() => rows.value[activeIndex.value]);

    return { activeIndex, activeRow, move, setRowEl };
}
