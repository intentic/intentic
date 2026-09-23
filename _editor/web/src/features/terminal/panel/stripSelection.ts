// The strip's multi-selection, VSCode-style, as one value only `stepSelection` moves: per group, keyed by the group's
// first session. Shift extends from the anchor, Ctrl or Cmd toggles, a plain click activates and clears, and a
// right-click outside the selection retargets it; the selection feeds only the context menu's mass actions.

type Groups = readonly (readonly string[])[];

export interface StripSelection {
    readonly keys: readonly string[];
    // The group a Shift range pivots on.
    readonly anchor: number | undefined;
}

export type SelectionEvent =
    // A Shift press on group `at`: the range from the anchor, else from the active group (-1 for none), else from `at`.
    | { readonly kind: `extend`; readonly groups: Groups; readonly at: number; readonly active: number }
    | { readonly kind: `toggle`; readonly groups: Groups; readonly at: number }
    | { readonly kind: `activate`; readonly at: number }
    | { readonly kind: `retarget`; readonly groups: Groups; readonly at: number }
    // A mass action ran: nothing stays selected, and the anchor stays where it was.
    | { readonly kind: `clear` };

export const NO_SELECTION: StripSelection = { keys: [], anchor: undefined };

export const groupKey = (group: readonly string[]): string => group[0] ?? ``;

export const selects = (selection: StripSelection, group: readonly string[]): boolean => selection.keys.includes(groupKey(group));

type Moves = { readonly [K in SelectionEvent["kind"]]: (selection: StripSelection, event: Extract<SelectionEvent, { kind: K }>) => StripSelection };

const MOVES: Moves = {
    extend: (selection, { groups, at, active }) => {
        const from = selection.anchor ?? (active === -1 ? at : active);
        const [lo, hi] = from < at ? [from, at] : [at, from];
        return { ...selection, keys: groups.slice(lo, hi + 1).map(groupKey) };
    },
    toggle: (selection, { groups, at }) => {
        const group = groups[at] ?? [];
        const key = groupKey(group);
        return { keys: selects(selection, group) ? selection.keys.filter((kept) => kept !== key) : [...selection.keys, key], anchor: at };
    },
    activate: (_, { at }) => ({ keys: [], anchor: at }),
    // VSCode's list behaviour: a right-click inside the selection acts on all of it.
    retarget: (selection, { groups, at }) => {
        const group = groups[at] ?? [];
        return selects(selection, group) ? selection : { keys: [groupKey(group)], anchor: at };
    },
    clear: (selection) => ({ ...selection, keys: [] }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const stepSelection = (selection: StripSelection, event: SelectionEvent): StripSelection =>
    (MOVES[event.kind] as (selection: StripSelection, event: SelectionEvent) => StripSelection)(selection, event);
