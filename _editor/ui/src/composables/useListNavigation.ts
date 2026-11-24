import { computed, ref, watch, type Ref } from "vue";

// Keyboard navigation for a searchbox-driven listbox: a highlight index over a flat row list, wrap-around
// arrow movement that keeps it scrolled into view. Rows register their elements by key (`:ref`) so v-for
// churn stays correct. `home` is where the highlight rests when the rows change: the first row, unless the caller
// names another (a picker's current value, the option a listbox opens on); -1 falls back to the first row.
export function useListNavigation<T>(rows: Ref<readonly T[]>, keyOf: (row: T) => string, home: (rows: readonly T[]) => number = () => 0) {
    const rest = (): number => Math.max(0, home(rows.value));
    const activeIndex = ref(rest());
    const rowEls = new Map<string, HTMLElement>();

    // Resets on the row KEYS, not array identity: callers re-derive their list often (a workspace refresh
    // rebuilding an @mention list), and resetting on identity would lose the highlight for no user reason.
    // NUL-joined, since a key may be a path containing a space.
    watch(
        () => rows.value.map(keyOf).join(`\u0000`),
        () => (activeIndex.value = rest()),
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
