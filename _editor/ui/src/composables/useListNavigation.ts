import { computed, ref, watch, type Ref } from "vue";

/* Keyboard navigation for a searchbox-driven listbox (the QuickOpen pattern): a highlight index over a flat
 * row list, wrap-around arrow movement that keeps the highlighted row scrolled into view, and the element
 * registry the scrolling needs. Rows register their elements by key (via :ref) so v-for churn stays correct.
 * The highlight snaps back to the top whenever the row set changes under it. */
export function useListNavigation<T>(rows: Ref<readonly T[]>, keyOf: (row: T) => string) {
    const activeIndex = ref(0);
    const rowEls = new Map<string, HTMLElement>();

    /* Reset on WHAT THE ROWS ARE, not on the array holding them. Every caller derives its list — a slice of a
     * ranked file search, a flatMap over the picker's sections — so each recompute hands over a new array whose
     * contents are usually identical, and resetting on identity took the highlight back to the top for reasons
     * the user had nothing to do with: an agent saving a file refreshes the workspace tree, the @mention list is
     * rebuilt from it, and the row someone was arrowing towards is suddenly row one again.
     *
     * The keys ARE the row set here: they are what the caller promises is stable per row (they address the
     * element registry above), so a list that re-derives to the same keys is the same list to look at.
     *
     * NUL-joined, because a key here can be a file path and a path may contain a space: joined on one, two
     * different row sets ([`a b`, `c`] and [`a`, `b c`]) serialize alike and the reset is missed. Nothing a
     * path can hold collides with a NUL, which is why the fleet roster's own change key uses it too. */
    watch(
        () => rows.value.map(keyOf).join(`\u0000`),
        () => (activeIndex.value = 0),
    );

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
