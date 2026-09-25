import { computed, type Ref, ref, watch } from "vue";

// A click on a multi-selectable row: Shift ranges from an anchor, Ctrl or Cmd toggles, anything else takes it alone.
export type ClickIntent = `range` | `toggle` | `single`;

// `anchored` is false where there is nothing to range from, and then Shift reads as the keys held beside it.
export const clickIntent = (keys: Pick<MouseEvent, `shiftKey` | `ctrlKey` | `metaKey`>, anchored = true): ClickIntent =>
    keys.shiftKey && anchored ? `range` : keys.ctrlKey || keys.metaKey ? `toggle` : `single`;

// Anchor to row inclusive, either way round; the row alone for an unlisted anchor, undefined for an unlisted row.
export const rangeSelect = <T>(order: readonly T[], anchor: T | undefined, row: T): T[] | undefined => {
    const to = order.indexOf(row);
    if (to === -1) {
        return undefined;
    }
    const from = anchor === undefined ? -1 : order.indexOf(anchor);
    return from === -1 ? [row] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
};

export interface MultiSelectOptions {
    /**
     * A lead the page shares, such as the home's current entry. When one is given, the selection follows it: set
     * elsewhere, it collapses the selection to it (or empties it when it is not in `order`), entries that leave `order`
     * leave the selection, and a clear drops the lead too. Without one the lead is the surface's own keyboard cursor,
     * which a clear leaves where it was, so the keyboard picks up from there.
     */
    readonly lead?: Ref<string | null>;
}

/**
 * Which entries a surface's verbs act on: a click selects, Ctrl/Cmd toggles and Shift ranges from the anchor over
 * `order`; the lead is the entry the keyboard and a single-entry verb act on.
 */
export const useMultiSelect = (order: Readonly<Ref<readonly string[]>>, { lead: shared }: MultiSelectOptions = {}) => {
    const lead = shared ?? ref<string | null>(null);
    const start = lead.value !== null && order.value.includes(lead.value) ? lead.value : null;
    const selection = ref<ReadonlySet<string>>(new Set(start === null ? [] : [start]));
    // Pivots Shift-range.
    const anchor = ref<string | null>(start);

    const selectSingle = (path: string): void => {
        selection.value = new Set([path]);
        anchor.value = path;
        lead.value = path;
    };
    const extendTo = (path: string): void => {
        selection.value = new Set(rangeSelect(order.value, anchor.value ?? undefined, path) ?? [path]);
        lead.value = path;
    };
    const toggleAt = (path: string): void => {
        const next = new Set(selection.value);
        if (!next.delete(path)) {
            next.add(path);
        }
        selection.value = next;
        anchor.value = path;
        lead.value = path;
    };
    // A press with its modifier keys; none held (or none given, a keyboard or menu route) selects the entry alone.
    const select = (path: string, keys?: Pick<MouseEvent, `shiftKey` | `ctrlKey` | `metaKey`>): void => {
        const intent = keys === undefined ? `single` : clickIntent(keys, anchor.value !== null);
        (intent === `range` ? extendTo : intent === `toggle` ? toggleAt : selectSingle)(path);
    };
    const selectAll = (): void => {
        selection.value = new Set(order.value);
    };
    // What just landed (a paste, a copy out of an archive, an extract), the last of it leading.
    const selectLanded = (paths: readonly string[]): void => {
        selection.value = new Set(paths);
        anchor.value = paths.at(-1) ?? null;
        lead.value = anchor.value;
    };
    // Nothing selected and nothing to range from; a shared lead goes too, since it named something now unmarked.
    const clear = (): void => {
        selection.value = new Set();
        anchor.value = null;
        if (shared !== undefined) {
            lead.value = null;
        }
    };
    // Collapses everything onto `path`, or onto nothing: the tree following the file the editor opened.
    const follow = (path: string | null): void => {
        selection.value = new Set(path === null ? [] : [path]);
        anchor.value = path;
        lead.value = path;
    };
    // The surface's one tab stop: the lead if visible, else the first entry, so Tab enters even when a filter hides it.
    const tabbablePath = computed<string | null>(() => (lead.value !== null && order.value.includes(lead.value) ? lead.value : (order.value[0] ?? null)));

    if (shared !== undefined) {
        // A lead set elsewhere collapses the set to it, or empties it off the order; one toggled out here is the anchor.
        watch(shared, (path) => {
            if (path === null || !order.value.includes(path)) {
                selection.value = new Set();
                anchor.value = null;
            } else if (!selection.value.has(path) && path !== anchor.value) {
                selectSingle(path);
            }
        });
        // Entries that left the order (deleted, moved, filtered) leave the selection too.
        watch(order, (list) => {
            const present = new Set(list);
            if ([...selection.value].some((path) => !present.has(path))) {
                selection.value = new Set([...selection.value].filter((path) => present.has(path)));
            }
        });
    }

    return { selection, anchor, lead, selectSingle, extendTo, toggleAt, select, selectAll, selectLanded, clear, follow, tabbablePath };
};

export type MultiSelect = ReturnType<typeof useMultiSelect>;
